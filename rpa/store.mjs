import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(root) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, 'data.sqlite'));
    fs.chmodSync(path.join(root, 'data.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (account TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(account,id), FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, account TEXT NOT NULL, room TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_room ON snapshots(account,room,id DESC);
      CREATE TABLE IF NOT EXISTS history_progress (account TEXT PRIMARY KEY, json TEXT NOT NULL, FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS history_batch (account TEXT PRIMARY KEY, json TEXT NOT NULL, FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS history_reports (account TEXT NOT NULL, room TEXT NOT NULL, json TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(account,room), FOREIGN KEY(account,room) REFERENCES rooms(account,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, account TEXT, time TEXT NOT NULL, message TEXT NOT NULL);`);
  }
  accounts() { return this.db.prepare('SELECT json FROM accounts').all().map(r => JSON.parse(r.json)); }
  account(id) { const row = this.db.prepare('SELECT json FROM accounts WHERE id=?').get(id); if (!row) throw new Error('账号不存在'); return JSON.parse(row.json); }
  save(account) { this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(account.id, JSON.stringify(account)); return account; }
  create(label) {
    if (this.accounts().length >= 10) throw new Error('最多连接 10 个账号');
    return this.save({ id: crypto.randomUUID(), label: label.trim().slice(0, 60) || '我的罗盘账号', uid: null, name: null, enabled: false, interval: 60, state: 'needs_login', error: null, lastCheck: null, lastSync: null, createdAt: new Date().toISOString() });
  }
  event(id, message) {
    this.db.prepare('INSERT INTO events(account,time,message) VALUES (?,?,?)').run(id, new Date().toISOString(), message.slice(0, 500));
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 300)');
  }
  events() { return this.db.prepare('SELECT account,time,message FROM events ORDER BY id DESC LIMIT 30').all(); }
  rooms(id) { return this.db.prepare('SELECT json FROM rooms WHERE account=? ORDER BY updated DESC LIMIT 100').all(id).map(r => JSON.parse(r.json)); }
  historyProgress(account) {
    const row = this.db.prepare('SELECT json FROM history_progress WHERE account=?').get(account);
    return row ? JSON.parse(row.json) : null;
  }
  saveHistoryProgress(account, progress) {
    this.account(account);
    this.db.prepare('INSERT INTO history_progress(account,json) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET json=excluded.json').run(account, JSON.stringify(progress));
    return progress;
  }
  historyBatch(account) {
    const row = this.db.prepare('SELECT json FROM history_batch WHERE account=?').get(account);
    return row ? JSON.parse(row.json) : null;
  }
  saveHistoryBatch(account, progress) {
    this.account(account);
    this.db.prepare('INSERT INTO history_batch(account,json) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET json=excluded.json').run(account, JSON.stringify(progress));
    return progress;
  }
  recoverHistoryBatches() {
    for (const row of this.db.prepare('SELECT account,json FROM history_batch').all()) {
      const progress = JSON.parse(row.json);
      if (progress.status === 'running') this.saveHistoryBatch(row.account, {
        ...progress, status: 'paused', error: '工作台已重启，点击继续回填。', updatedAt: new Date().toISOString(),
      });
    }
  }
  allRooms(account) {
    this.account(account);
    const rows = this.db.prepare('SELECT json FROM rooms WHERE account=? ORDER BY id LIMIT 10001').all(account);
    if (rows.length > 10000) throw new Error('本机保存场次超过批量扫描上限 10000，请先导出并整理历史数据');
    return rows.map(row => JSON.parse(row.json));
  }
  historyReport(account, room, raw = false) {
    const row = this.db.prepare('SELECT json,raw FROM history_reports WHERE account=? AND room=?').get(account, room);
    return row ? { ...JSON.parse(row.json), ...(raw ? { raw: JSON.parse(row.raw) } : {}) } : null;
  }
  saveHistoryReport(account, room, report, raw) {
    if (!this.room(account, room)) throw new Error('历史场次尚未保存');
    this.db.prepare('INSERT INTO history_reports(account,room,json,raw) VALUES (?,?,?,?) ON CONFLICT(account,room) DO UPDATE SET json=excluded.json,raw=excluded.raw').run(account, room, JSON.stringify(report), JSON.stringify(raw));
    return report;
  }
  roomsPage(account, offset, limit) {
    this.account(account);
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE account=?').get(account).count;
    const rooms = this.db.prepare('SELECT json FROM rooms WHERE account=? ORDER BY updated DESC, id DESC LIMIT ? OFFSET ?').all(account, limit, offset).map(r => JSON.parse(r.json));
    return { rooms, total, offset, limit, hasMore: offset + rooms.length < total };
  }
  room(account, id) {
    this.account(account);
    const row = this.db.prepare('SELECT json FROM rooms WHERE account=? AND id=?').get(account, id);
    return row ? JSON.parse(row.json) : null;
  }
  saveRoom(account, room) {
    const time = new Date().toISOString();
    this.db.prepare('INSERT INTO rooms VALUES (?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET json=excluded.json,updated=excluded.updated').run(account, room.id, JSON.stringify({ ...room, updatedAt: time }), time);
  }
  snapshot(account, room, normalized, raw) {
    const time = new Date().toISOString();
    this.db.prepare('INSERT INTO snapshots(account,room,time,json,raw) VALUES (?,?,?,?,?)').run(account, room, time, JSON.stringify(normalized), JSON.stringify(raw));
    this.db.prepare('DELETE FROM snapshots WHERE account=? AND room=? AND id NOT IN (SELECT id FROM snapshots WHERE account=? AND room=? ORDER BY id DESC LIMIT 1000)').run(account, room, account, room);
    this.db.prepare('DELETE FROM snapshots WHERE time < ?').run(new Date(Date.now() - 30 * 86400e3).toISOString());
  }
  detail(account, room, raw = false) {
    this.account(account);
    const latest = this.db.prepare('SELECT time,json,raw FROM snapshots WHERE account=? AND room=? ORDER BY id DESC LIMIT 1').get(account, room);
    const history = this.db.prepare('SELECT time,json FROM snapshots WHERE account=? AND room=? ORDER BY id DESC LIMIT 120').all(account, room).reverse().map(r => ({ time: r.time, metrics: JSON.parse(r.json).metrics }));
    const report = this.historyReport(account, room);
    return { room: this.room(account, room), latest: latest ? { time: latest.time, ...JSON.parse(latest.json) } : null, history,
      historyReport: report,
      ...(raw && report ? { historyRaw: this.historyReport(account, room, true).raw } : {}),
      ...(raw && latest ? { raw: JSON.parse(latest.raw) } : {}) };
  }
  close() { this.db.close(); }
}
