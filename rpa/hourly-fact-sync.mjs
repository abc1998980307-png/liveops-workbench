import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuClient, FeishuError } from './feishu.mjs';
import { FACT_FIELDS, FACT_METRICS, FACT_TABLE_NAME, encodeFactFields, factFields,
  factSchemaTypes, listTables } from './hourly-fact.mjs';

const TARGET = '雪梨老师阅读100篇';
const ID = /^[A-Za-z0-9_-]+$/;
const SOURCE = { '电商罗盘': ['电商罗盘', '边界快照', '官方页面快照'],
  '巨量千川': ['巨量千川', '官方小时', '官方值'] };

function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077)))
    throw new Error('小时事实表定位文件权限或格式无效');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function factDestination(root, store) {
  const location = privateJson(path.join(root, 'hourly-fact-table.json'));
  const saved = store.db.prepare('SELECT json FROM feishu_config WHERE id=1').get();
  if (!saved) throw new Error('本机飞书应用配置不存在');
  const config = JSON.parse(saved.json);
  if (location.tableName !== FACT_TABLE_NAME || location.schemaVersion !== 1 ||
      !ID.test(location.appToken || '') || !ID.test(location.tableId || '') ||
      location.tableId === config.tableId || location.tableId === config.reviewTableId ||
      location.appToken !== config.appToken || !config.appId || !config.appSecret)
    throw new Error('小时事实表定位与本机应用配置不一致');
  return { appId: config.appId, appSecret: config.appSecret,
    appToken: location.appToken, tableId: location.tableId };
}

function verifiedAccount(store, id) {
  const account = store.account(id);
  if (store.targetName() !== TARGET || account.name !== TARGET || account.observedName !== TARGET ||
      !account.uid || account.observedUidMatchesStored !== true ||
      !Number.isFinite(Date.parse(account.verifiedAt || '')))
    throw new Error('小时事实账号映射未经核验');
  return account;
}

function versionOf(row) { return String(row.version || '').split(':')[0]; }

export function prepareFactRows(store, since) {
  if (!Number.isFinite(Date.parse(since)) || new Date(since).toISOString() !== since)
    throw new Error('必须提供明确的 ISO 采样起点，避免隐式历史回填');
  const sinceTime = Date.parse(since);
  if (store.targetName() !== TARGET) throw new Error('小时事实目标账号未经核验');
  const candidates = store.db.prepare('SELECT json FROM accounts').all().map(item => JSON.parse(item.json))
    .filter(item => item.name === TARGET && !item.archivedAt);
  if (candidates.length !== 1) throw new Error('小时事实目标账号无法唯一确认');
  const target = verifiedAccount(store, candidates[0].id);
  const rows = store.db.prepare('SELECT json FROM hourly_metrics ORDER BY sampled_at,key')
    .all().map(item => JSON.parse(item.json));
  const groups = new Map();
  for (const row of rows) {
    if (row.account !== target.id) continue;
    if (!Number.isFinite(Date.parse(String(row.hourEnd).replace(' ', 'T') + '+08:00')) ||
        Date.parse(String(row.hourEnd).replace(' ', 'T') + '+08:00') <= sinceTime) continue;
    if (!SOURCE[row.source] || !['已读取', '缺失'].includes(row.status)) continue;
    const [source, grain, valueKind] = SOURCE[row.source];
    if (row.grain !== grain || row.valueKind !== valueKind || row.source !== source) continue;
    if (source === '巨量千川' && (row.status !== '已读取' || row.metricKey !== 'stat_cost' ||
        row.paginationVerified !== true)) continue;
    const account = target;
    const room = store.room(row.account, row.room);
    const expectedSession = `session:${crypto.createHash('sha256').update(`${account.uid}:${room?.id}`).digest('hex').slice(0, 24)}`;
    if (!room || row.sessionKey !== expectedSession || row.room !== room.id ||
        !row.hourStart || !row.hourEnd || !['live', 'post-live', 'unknown'].includes(versionOf(row)))
      throw new Error('小时事实场次或小时映射未经核验');
    const spec = FACT_METRICS[row.metricKey];
    if (!spec || spec[1] !== source || spec[2] !== grain) continue;
    const key = JSON.stringify([row.account, source, expectedSession, row.hourStart, row.hourEnd, versionOf(row)]);
    if (!groups.has(key)) groups.set(key, { account, platform: source, sessionKey: expectedSession,
      hourStart: row.hourStart, hourEnd: row.hourEnd, version: versionOf(row), metrics: new Map() });
    const group = groups.get(key);
    const prior = group.metrics.get(row.metricKey);
    if (!prior || Date.parse(row.sampledAt) > Date.parse(prior.sampledAt)) group.metrics.set(row.metricKey, row);
  }
  return [...groups.values()].filter(group => [...group.metrics.values()]
    .some(row => Date.parse(row.sampledAt) >= sinceTime)).map(group => {
    const metrics = {};
    for (const [key, row] of group.metrics) metrics[key] = { status: row.status,
      value: row.value, unit: row.unit,
      evidence: group.platform === '巨量千川' ? { pagination: '单页已核验',
        hourCoverage: row.hourCoverage || '待确认', missingHours: row.missingHours?.length ?? null,
        accountBinding: '当前千川户同场报表；未证明与罗盘账号 ID 相同' } :
        { hourCoverage: '边界快照，非小时增量' } };
    const sampledAt = [...group.metrics.values()].map(row => row.sampledAt).sort().at(-1);
    const status = Object.values(metrics).some(metric => metric.status === '已读取') ? '已读取' : '缺失';
    const fields = factFields({ accountUid: group.account.uid, platform: group.platform,
      sessionKey: group.sessionKey, hourStart: group.hourStart, hourEnd: group.hourEnd,
      version: group.version, source: group.platform, grain: SOURCE[group.platform][1],
      status, sampledAt, metrics });
    fields['同步状态'] = '已同步';
    return { key: fields['同步键'], sampledAt, fields };
  }).sort((a, b) => a.sampledAt.localeCompare(b.sampledAt) || a.key.localeCompare(b.key));
}

function sameFields(remote, expected) {
  return remote && Object.entries(expected).every(([name, value]) => {
    const actual = remote[name];
    return value == null || value === '' ? actual == null || actual === '' : actual === value;
  });
}

async function upsertFact(client, key, fields, token, previous) {
  const data = await client.request(`${client.base}/records/search?page_size=2`, { method: 'POST',
    body: { filter: { conjunction: 'and', conditions: [{ field_name: '同步键', operator: 'is', value: [key] }] },
      automatic_fields: false } });
  if (!Array.isArray(data.items)) throw new FeishuError('小时事实查询格式异常');
  if (data.has_more || data.items.length > 1) throw new FeishuError('小时事实同步键远端重复，已停止写入');
  const found = data.items[0];
  if (found && (!ID.test(found.record_id || '') || !found.fields))
    throw new FeishuError('小时事实远端记录格式异常，已停止写入');
  if (found && sameFields(found.fields, fields)) return found.record_id;
  if (!found && previous)
    throw new FeishuError('小时事实已交付记录在远端缺失，已保留冲突');
  if (found && (!previous || !sameFields(found.fields, previous)))
    throw new FeishuError('小时事实远端内容与上次交付不一致，已保留冲突');
  const route = `${client.base}/records${found ? '/' + found.record_id : '?client_token=' + token}`;
  const result = await client.request(route, { method: found ? 'PUT' : 'POST', body: { fields } });
  if (!ID.test(result.record?.record_id || ''))
    throw new FeishuError('小时事实写入响应缺少记录 ID，待按同步键核对');
  return result.record.record_id;
}

export class HourlyFactSync {
  constructor(root, store, { fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
    this.root = root; this.store = store; this.fetcher = fetcher; this.now = now;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'hourly-fact-delivery.sqlite');
    this.db = new DatabaseSync(file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS delivery (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL,
        fields TEXT NOT NULL, record TEXT NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS attempt (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL,
        fields TEXT NOT NULL, token TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(destination,key));`);
  }
  close() { this.db.close(); }
  async sync({ since, limit = 20 } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await this.run({ since, limit });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // Failed attempts and their backoff remain durable after an API error.
      try { this.db.exec('COMMIT'); } catch { this.db.exec('ROLLBACK'); }
      throw error;
    }
  }
  async run({ since, limit }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('小时事实单次写入上限无效');
    const config = factDestination(this.root, this.store);
    const destination = `${config.appToken}:${config.tableId}`;
    const client = new FeishuClient(config, this.fetcher);
    const matching = (await listTables(client)).filter(table => table.table_id === config.tableId &&
      table.name === FACT_TABLE_NAME);
    if (matching.length !== 1) throw new FeishuError('小时事实表远端身份不一致，已停止写入');
    const types = factSchemaTypes(await client.fields());
    const prepared = prepareFactRows(this.store, since);
    for (const item of prepared) {
      const fields = encodeFactFields(item.fields, types);
      const json = JSON.stringify(fields);
      const delivered = this.db.prepare('SELECT fields FROM delivery WHERE destination=? AND key=?').get(destination, item.key);
      if (delivered?.fields === json) continue;
      const pending = this.db.prepare('SELECT fields FROM attempt WHERE destination=? AND key=?')
        .get(destination, item.key);
      if (!pending)
        this.db.prepare('INSERT INTO attempt(destination,key,sampled_at,fields,token) VALUES (?,?,?,?,?)')
          .run(destination, item.key, item.sampledAt, json, crypto.randomUUID());
      else if (pending.fields !== json && delivered && pending.fields === delivered.fields)
        this.db.prepare('UPDATE attempt SET sampled_at=?,fields=? WHERE destination=? AND key=?')
          .run(item.sampledAt, json, destination, item.key);
    }
    const due = this.db.prepare('SELECT * FROM attempt WHERE destination=? AND retry_at<=? ORDER BY sampled_at,key LIMIT ?')
      .all(destination, this.now(), limit);
    let deliveredCount = 0;
    for (const attempt of due) {
      const previous = this.db.prepare('SELECT fields FROM delivery WHERE destination=? AND key=?')
        .get(destination, attempt.key);
      try {
        const record = await upsertFact(client, attempt.key, JSON.parse(attempt.fields), attempt.token,
          previous ? JSON.parse(previous.fields) : null);
        this.db.exec('SAVEPOINT delivered');
        try {
          this.db.prepare(`INSERT INTO delivery VALUES (?,?,?,?,?,?) ON CONFLICT(destination,key) DO UPDATE SET
            sampled_at=excluded.sampled_at,fields=excluded.fields,record=excluded.record,delivered_at=excluded.delivered_at`)
            .run(destination, attempt.key, attempt.sampled_at, attempt.fields, record, new Date(this.now()).toISOString());
          this.db.prepare('DELETE FROM attempt WHERE destination=? AND key=?').run(destination, attempt.key);
          this.db.exec('RELEASE delivered');
        } catch (error) { this.db.exec('ROLLBACK TO delivered'); this.db.exec('RELEASE delivered'); throw error; }
        deliveredCount++;
      } catch (error) {
        const failures = attempt.failures + 1;
        const delay = Math.min(600, 30 * 2 ** Math.min(failures - 1, 5)) * 1000;
        this.db.prepare('UPDATE attempt SET failures=?,retry_at=?,error=? WHERE destination=? AND key=?')
          .run(failures, this.now() + delay, error instanceof FeishuError ? error.message.slice(0, 300) :
            '小时事实本地处理失败', destination, attempt.key);
        throw error;
      }
    }
    return { delivered: deliveredCount,
      pending: this.db.prepare('SELECT COUNT(*) AS n FROM attempt WHERE destination=?').get(destination).n,
      deferred: this.db.prepare('SELECT COUNT(*) AS n FROM attempt WHERE destination=? AND retry_at>?').get(destination, this.now()).n };
  }
}
