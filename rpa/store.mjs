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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (account TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(account,id), FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, account TEXT NOT NULL, room TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_room ON snapshots(account,room,id DESC);
      CREATE TABLE IF NOT EXISTS history_progress (account TEXT PRIMARY KEY, json TEXT NOT NULL, FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS history_batch (account TEXT PRIMARY KEY, json TEXT NOT NULL, FOREIGN KEY(account) REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS history_reports (account TEXT NOT NULL, room TEXT NOT NULL, json TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(account,room), FOREIGN KEY(account,room) REFERENCES rooms(account,id));
      CREATE TABLE IF NOT EXISTS hourly_metrics (key TEXT PRIMARY KEY, account TEXT NOT NULL, room TEXT NOT NULL, hour_start TEXT NOT NULL, metric TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, sampled_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hourly_room ON hourly_metrics(account,room,hour_start,source,metric);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, account TEXT, time TEXT NOT NULL, message TEXT NOT NULL);`);
  }
  accounts() { return this.db.prepare('SELECT json FROM accounts').all().map(r => JSON.parse(r.json)); }
  targetName() { return this.db.prepare("SELECT value FROM settings WHERE key='targetName'").get()?.value || ''; }
  setTargetName(name) {
    this.db.prepare("INSERT INTO settings(key,value) VALUES ('targetName',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name);
    return name;
  }
  account(id) { const row = this.db.prepare('SELECT json FROM accounts WHERE id=?').get(id); if (!row) throw new Error('账号不存在'); return JSON.parse(row.json); }
  save(account) { this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(account.id, JSON.stringify(account)); return account; }
  create(label) {
    if (this.accounts().length >= 10) throw new Error('最多连接 10 个账号');
    return this.save({ id: crypto.randomUUID(), label: label.trim().slice(0, 60) || '我的罗盘账号', uid: null, name: null, observedName: null, verifiedAt: null, observedUidMatchesStored: false, enabled: false, interval: 60, state: 'needs_login', error: null, lastCheck: null, lastSync: null, createdAt: new Date().toISOString() });
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
  roomOverviewRows(accounts) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 10) throw new Error('账号筛选无效');
    const slots = accounts.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT r.account, r.json AS roomJson, s.time AS snapshotTime,
      s.json AS snapshotJson, h.json AS reportJson
      FROM rooms r
      LEFT JOIN snapshots s ON s.id=(SELECT MAX(s2.id) FROM snapshots s2 WHERE s2.account=r.account AND s2.room=r.id)
      LEFT JOIN history_reports h ON h.account=r.account AND h.room=r.id
      WHERE r.account IN (${slots}) ORDER BY r.updated DESC, r.id DESC LIMIT 100001`).all(...accounts);
    if (rows.length > 100000) throw new Error('本机保存场次超过汇总上限 100000');
    return rows.map(row => ({ account: row.account, room: JSON.parse(row.roomJson),
      latest: row.snapshotJson ? { time: row.snapshotTime, ...JSON.parse(row.snapshotJson) } : null,
      historyReport: row.reportJson ? JSON.parse(row.reportJson) : null }));
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
  saveHourly(rows) {
    const insert = this.db.prepare(`INSERT INTO hourly_metrics(key,account,room,hour_start,metric,source,version,sampled_at,json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET sampled_at=excluded.sampled_at,json=excluded.json
      WHERE excluded.sampled_at > hourly_metrics.sampled_at`);
    for (const row of rows) {
      if (!this.room(row.account, row.room) || !row.sessionKey || !row.hourStart || !row.version)
        throw new Error('小时行缺少已保存场次或版本');
      const key = [row.sessionKey, row.source, row.metricKey, row.hourStart, row.version].join(':');
      insert.run(key, row.account, row.room, row.hourStart, row.metricKey, row.source, row.version,
        row.sampledAt, JSON.stringify({ ...row, key }));
    }
  }
  hourly(account, room) {
    this.account(account);
    const savedRoom = this.room(account, room);
    const report = this.historyReport(account, room);
    const finalReport = savedRoom?.state === 'ended' && report?.roomState === 'ended' &&
      Boolean(report.endedAt) && report.endpoints?.historyBasic?.ok === true;
    return this.db.prepare('SELECT json FROM hourly_metrics WHERE account=? AND room=? ORDER BY hour_start,source,metric,version').all(account, room)
      .map(row => {
        const item = JSON.parse(row.json);
        const unit = /^(?:nan|undefined|null)$/i.test(String(item.unit || '')) ? '' : item.unit;
        const sampledAfterEnd = Number.isFinite(Date.parse(report?.endedAt)) &&
          Number.isFinite(Date.parse(item.sampledAt)) && Date.parse(item.sampledAt) >= Date.parse(report.endedAt);
        const hasFinalValue = item.source === '巨量千川' ? Number.isFinite(item.value) :
          Array.isArray(report?.metrics) && report.metrics.some(metric =>
            metric.key === item.metricKey && Number.isFinite(metric.value));
        const streamState = finalReport && hasFinalValue && sampledAfterEnd &&
          item.streamState === '直播状态待确认' && item.status === '已读取'
          ? item.source === '巨量千川' ? '下播后重报' : '下播后' : item.streamState;
        return { ...item, unit: unit || (item.metricKey === 'follow_anchor_ucnt' ? '人' : ''), streamState };
      });
  }
  latestHourlyRead(account, room, source) {
    return this.db.prepare('SELECT MAX(sampled_at) AS sampledAt FROM hourly_metrics WHERE account=? AND room=? AND source=?').get(account, room, source)?.sampledAt || null;
  }
  detail(account, room, raw = false) {
    this.account(account);
    const latest = this.db.prepare('SELECT time,json,raw FROM snapshots WHERE account=? AND room=? ORDER BY id DESC LIMIT 1').get(account, room);
    const history = this.db.prepare('SELECT time,json FROM snapshots WHERE account=? AND room=? ORDER BY id DESC LIMIT 120').all(account, room).reverse().map(r => ({ time: r.time, metrics: JSON.parse(r.json).metrics }));
    const report = this.historyReport(account, room);
    return { room: this.room(account, room), latest: latest ? { time: latest.time, ...JSON.parse(latest.json) } : null, history,
      hourly: this.hourly(account, room),
      historyReport: report,
      ...(raw && report ? { historyRaw: this.historyReport(account, room, true).raw } : {}),
      ...(raw && latest ? { raw: JSON.parse(latest.raw) } : {}) };
  }
  review(account, room) {
    const detail = this.detail(account, room);
    const history = this.db.prepare('SELECT time,json FROM snapshots WHERE account=? AND room=? ORDER BY id ASC LIMIT 1000').all(account, room)
      .map(row => ({ time: row.time, metrics: JSON.parse(row.json).metrics }));
    return { ...detail, history };
  }
  close() { this.db.close(); }
}
