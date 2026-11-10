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
    return { room: this.room(account, room), latest: latest ? { time: latest.time, ...JSON.parse(latest.json) } : null, history, ...(raw && latest ? { raw: JSON.parse(latest.raw) } : {}) };
  }
  close() { this.db.close(); }
}
