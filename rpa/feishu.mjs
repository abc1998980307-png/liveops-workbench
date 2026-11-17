import crypto from 'node:crypto';
import { METRICS } from './model.mjs';
import { reconcileSpend } from './spend-reconciliation.mjs';
import { REVIEW_FIELDS, reviewRows } from './hourly-review.mjs';

const API = 'https://open.feishu.cn/open-apis';
export const HISTORY_FIELDS = ['历史报表时间', '历史报表状态', '历史结算有效成交金额', '历史结算有效成交订单量', '历史进入直播间人数', '历史指标原值', '历史接口状态'];
export const SPEND_FIELDS = ['罗盘消耗', '千川消耗', '对账状态', '对账说明', '罗盘采样时间', '千川采样时间'];
export const FEISHU_FIELDS = ['同步键', '账号', '账号ID', '直播间ID', '直播标题', '直播状态', '采样时间', '采集状态', ...METRICS.map(([, label]) => label), '指标原值', '商品数量', '商品明细', ...SPEND_FIELDS, ...HISTORY_FIELDS];
const ID = /^[A-Za-z0-9_-]+$/;
const REVIEW_TARGET = '雪梨老师阅读100篇';

export function parseBitableUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error('请输入完整的飞书多维表格链接'); }
  if (url.protocol !== 'https:' || !/(^|\.)feishu\.cn$/.test(url.hostname) || url.username || url.password || url.port)
    throw new Error('请使用 https://…feishu.cn/base/… 的多维表格链接');
  const match = /^\/base\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error('请从多维表格本体复制 /base/ 链接；知识库 /wiki/ 链接请先在原多维表格中打开');
  const tableId = url.searchParams.get('table') || '';
  if (!/^tbl[A-Za-z0-9_-]+$/.test(tableId)) throw new Error('链接缺少数据表 ID：请点开要写入的数据表后复制含 table=tbl… 的地址');
  return { appToken: match[1], tableId, url: `${url.origin}/base/${match[1]}?table=${tableId}` };
}

export class FeishuError extends Error {
  constructor(message, code = 0) { super(message); this.code = code; }
}

function feishuOperation(route, method) {
  if (route === 'token') return '获取访问令牌';
  if (/\/fields(?:\?|$)/.test(route)) return method === 'POST' ? '创建字段' : '列出字段';
  if (/\/tables(?:\?.*)?$/.test(route)) return method === 'POST' ? '创建数据表' : '列出数据表';
  if (route.includes('/records/search')) return '查询记录';
  if (route.includes('/records')) return method === 'POST' ? '新增记录' : '更新记录';
  return '请求飞书接口';
}

export class FeishuClient {
  constructor(config, fetcher = globalThis.fetch) { this.config = config; this.fetcher = fetcher; this.token = null; this.expires = 0; }
  async transport(route, { method = 'GET', body, token } = {}) {
    let response, result;
    try {
      response = await this.fetcher(route === 'token' ? 'https://accounts.feishu.cn/oauth/v3/token' : API + route, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      result = await response.json();
    } catch { throw new FeishuError('飞书请求失败或超时，请检查网络；待同步数据已保留'); }
    const code = Number(result?.code);
    if (!response.ok || code !== 0) {
      let hint = '请检查飞书应用权限及数据表配置';
      if ([20002, 20048, 20069].includes(code)) hint = ({ 20002: '应用密钥错误，请重新填写 App Secret', 20048: '应用不存在，请检查 App ID', 20069: '应用未发布或未启用，请在开放平台发布并启用应用' })[code];
      else if (response.status === 429 || [99991400, 1254290, 1254291, 1254607].includes(code)) hint = '请求频率受限，稍后自动重试';
      else if ([99991661, 99991663, 99991664, 99991665, 99991668].includes(code)) hint = '应用凭据或访问令牌无效，请检查 App ID 与 App Secret';
      else if ([1254004, 1254040, 1254041, 1254042].includes(code)) hint = '数据表或记录不存在，请检查链接和表格权限';
      else if ([99991672, 99991679, 91403, 1254302, 1254304].includes(code)) hint = '权限不足，请发布应用权限，并在多维表格的“添加文档应用”中授权；启用高级权限时需可管理权限';
      else if (response.status === 403) hint = '访问被拒绝，请核对应用、租户和目标表格的配置及实际权限';
      // Never surface arbitrary remote messages: they can echo credentials or request bodies.
      throw new FeishuError(`${feishuOperation(route, method)}时飞书返回错误 ${Number.isFinite(code) ? code : '响应格式异常'}（HTTP ${response.status}）：${hint}`, code);
    }
    return result;
  }
  async accessToken() {
    if (this.token && Date.now() < this.expires) return this.token;
    const result = await this.transport('token', { method: 'POST', body: { grant_type: 'client_credentials', client_id: this.config.appId, client_secret: this.config.appSecret } });
    if (!result.access_token) throw new FeishuError('飞书未返回应用访问令牌');
    if (!Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new FeishuError('飞书令牌有效期格式异常');
    this.token = result.access_token;
    this.expires = Date.now() + Math.max(0, Number(result.expires_in) - 120) * 1000;
    return this.token;
  }
  async request(route, options = {}) {
    try { return (await this.transport(route, { ...options, token: await this.accessToken() })).data || {}; }
    catch (error) {
      if (![99991663, 99991664, 99991665, 99991668].includes(error.code)) throw error;
      this.token = null;
      return (await this.transport(route, { ...options, token: await this.accessToken() })).data || {};
    }
  }
  get base() { return `/bitable/v1/apps/${this.config.appToken}/tables/${this.config.tableId}`; }
  async fields() {
    const items = []; let cursor = '';
    for (let page = 0; page < 20; page++) {
      const data = await this.request(`${this.base}/fields?page_size=100${cursor ? '&page_token=' + encodeURIComponent(cursor) : ''}`);
      if (!Array.isArray(data.items)) throw new FeishuError('飞书字段列表格式异常');
      items.push(...data.items);
      if (!data.has_more) return items;
      if (!data.page_token || data.page_token === cursor) throw new FeishuError('飞书字段分页异常');
      cursor = data.page_token;
    }
    throw new FeishuError('数据表字段过多，无法完成检查');
  }
  async schema(create = false, active = () => true, expected = FEISHU_FIELDS) {
    const fields = await this.fields();
    const wrong = fields.filter(f => expected.includes(f.field_name) && f.type !== 1);
    if (wrong.length) throw new FeishuError(`以下同名列需要使用文本类型：${wrong.map(f => f.field_name).join('、')}`);
    const missing = expected.filter(name => !fields.some(f => f.field_name === name));
    if (create) for (const name of missing) {
      if (!active()) return missing;
      await this.request(`${this.base}/fields`, { method: 'POST', body: { field_name: name, type: 1 } });
      await new Promise(resolve => setTimeout(resolve, 110));
    }
    return missing;
  }
  async upsert(key, fields, clientToken, active = () => true, updateExisting = true) {
    // Reconcile by a stable business key on every attempt, including after a lost response.
    const data = await this.request(`${this.base}/records/search?page_size=2`, { method: 'POST', body: { filter: { conjunction: 'and', conditions: [{ field_name: '同步键', operator: 'is', value: [key] }] }, automatic_fields: false } });
    if (!Array.isArray(data.items)) throw new FeishuError('飞书记录查询格式异常');
    if (data.has_more || data.items.length > 1) throw new FeishuError('发现重复的同步键，请在飞书中合并重复记录后重试');
    const recordId = data.items[0]?.record_id;
    if (data.items.length && !recordId) throw new FeishuError('飞书查询结果缺少记录 ID，已停止写入以避免重复记录');
    if (recordId && !ID.test(recordId)) throw new FeishuError('飞书记录 ID 格式异常');
    if (recordId && !updateExisting) return recordId;
    if (!active()) return null;
    const result = await this.request(`${this.base}/records${recordId ? '/' + recordId : '?client_token=' + clientToken}`, { method: recordId ? 'PUT' : 'POST', body: { fields } });
    if (!result.record?.record_id) throw new FeishuError('飞书写入响应缺少记录 ID，将在重试时核对同步键');
    return result.record.record_id;
  }
}

export function snapshotFields(account, room, snapshot) {
  if (!account.uid) throw new Error('账号身份尚未确认，暂不写入飞书');
  const failures = Object.entries(snapshot.endpoints || {}).filter(([, value]) => !value.ok).map(([name]) => name);
  const fields = {
    同步键: `compass:${account.uid}:${room.id}`, 账号: account.name || account.label,
    账号ID: String(account.uid), 直播间ID: String(room.id), 直播标题: room.title || '',
    直播状态: ({ live: '直播中', ended: '已结束', unknown: '待确认' })[snapshot.state] || '待确认',
    采样时间: snapshot.time, 采集状态: failures.length ? `部分数据缺失：${failures.join('、')}` : '完整',
    指标原值: JSON.stringify(snapshot.metrics || []),
    商品数量: snapshot.endpoints?.products?.ok ? String(snapshot.products?.length || 0) : '',
    商品明细: snapshot.endpoints?.products?.ok ? JSON.stringify(snapshot.products || []) : '',
  };
  for (const [key, label] of METRICS) {
    const metric = snapshot.metrics?.find(m => m.key === key);
    fields[label] = !metric || metric.display === '—' ? '' : `${metric.display}${metric.unit ? ' ' + metric.unit : ''}`;
  }
  for (const name of SPEND_FIELDS) fields[name] = '';
  fields['对账状态'] = '尚未采集';
  if (snapshot.spendReconciliation) {
    const spend = snapshot.spendReconciliation;
    const sample = side => side && { roomId: side.roomId, amount: side.amount,
      unit: side.unit, sampledAt: side.time };
    const verified = reconcileSpend(String(room.id), sample(spend.compass), sample(spend.qianchuan),
      { toleranceYuan: spend.toleranceYuan });
    if (verified.status !== spend.status) throw new Error('消耗对账状态与采样不一致，已停止飞书写入');
    const formatted = side => side ? `${side.display} ${side.unit}` : '';
    fields['罗盘消耗'] = formatted(verified.compass);
    fields['千川消耗'] = formatted(verified.qianchuan);
    fields['对账状态'] = verified.status;
    fields['对账说明'] = verified.status === '匹配' ? (verified.reason || '') : verified.reason || spend.reason || Object.entries(spend.reasons || {})
      .filter(([, reason]) => reason).map(([side, reason]) =>
        `${side === 'compass' ? '罗盘' : '千川'}：${String(reason).slice(0, 120)}`).join('；');
    fields['罗盘采样时间'] = verified.compass?.time || '';
    fields['千川采样时间'] = verified.qianchuan?.time || '';
  }
  for (const value of Object.values(fields)) if (String(value).length > 95000) throw new Error('本场商品明细超出飞书单元格容量，已保留在本机；请缩小商品数据范围后重试');
  return fields;
}

export function historyFields(account, room, report) {
  if (!account.uid) throw new Error('账号身份尚未确认，暂不写入飞书');
  if (!/^\d{1,30}$/.test(room.id) || report.roomId !== room.id || room.state !== 'ended')
    throw new Error('历史报表与已结束场次不匹配');
  const endpoints = report.endpoints || {};
  const complete = ['historyBasic', 'historyCore', 'historyTrade'].every(name => endpoints[name]?.ok);
  const field = (key, source, rawUnit) => {
    if (!endpoints[source]?.ok) return '';
    const metric = report.metrics?.find(item => item.key === key && item.source === source && item.rawUnit === rawUnit);
    return Number.isFinite(metric?.value) && metric.display !== '—' ? `${metric.display}${metric.unit ? ' ' + metric.unit : ''}` : '';
  };
  const fields = {
    同步键: `compass:${account.uid}:${room.id}`, 账号: account.name || account.label,
    账号ID: String(account.uid), 直播间ID: room.id, 直播标题: room.title || report.title || '',
    直播状态: '已结束',
    历史报表时间: report.retrievedAt || '', 历史报表状态: complete ? '完整' : '部分接口缺失',
    历史结算有效成交金额: field('t7payin8d_predstl_ord_amt', 'historyTrade', 'price'),
    历史结算有效成交订单量: field('t7payin8d_predstl_ord_cnt', 'historyTrade', 'number'),
    历史进入直播间人数: field('watch_ucnt', 'historyCore', 'number'),
    历史指标原值: JSON.stringify(report.metrics || []), 历史接口状态: JSON.stringify(endpoints),
  };
  for (const value of Object.values(fields)) if (String(value).length > 95000) throw new Error('历史报表超出飞书单元格容量，已保留在本机');
  return fields;
}

export class FeishuSync {
  constructor(store, { clientFactory = config => new FeishuClient(config), now = () => Date.now() } = {}) {
    this.store = store; this.db = store.db; this.clientFactory = clientFactory; this.now = now;
    this.busy = null; this.stopping = false; this.client = null; this.pauseVersion = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS feishu_config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feishu_delivery (destination TEXT NOT NULL, account TEXT NOT NULL, room TEXT NOT NULL, snapshot INTEGER NOT NULL, record TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY(destination,account,room));
      CREATE TABLE IF NOT EXISTS feishu_attempt (destination TEXT NOT NULL, account TEXT NOT NULL, room TEXT NOT NULL, snapshot INTEGER NOT NULL, token TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(destination,account,room));
      CREATE TABLE IF NOT EXISTS feishu_history_delivery (destination TEXT NOT NULL, account TEXT NOT NULL, room TEXT NOT NULL, version TEXT NOT NULL, record TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY(destination,account,room));
      CREATE TABLE IF NOT EXISTS feishu_history_attempt (destination TEXT NOT NULL, account TEXT NOT NULL, room TEXT NOT NULL, version TEXT NOT NULL, token TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(destination,account,room));
      CREATE TABLE IF NOT EXISTS feishu_hourly_delivery (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL, record TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS feishu_hourly_attempt (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL, token TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS feishu_review_delivery (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL, record TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY(destination,key));
      CREATE TABLE IF NOT EXISTS feishu_review_attempt (destination TEXT NOT NULL, key TEXT NOT NULL, sampled_at TEXT NOT NULL, token TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(destination,key));`);
    this.config = JSON.parse(this.db.prepare('SELECT json FROM feishu_config WHERE id=1').get()?.json || '{}');
  }
  persist() { this.db.prepare('INSERT INTO feishu_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(this.config)); }
  destination() { return this.config.appToken && this.config.tableId ? `${this.config.appToken}:${this.config.tableId}` : ''; }
  pending(limit = 1000) {
    if (!this.destination() || !this.config.accountIds?.length) return [];
    return this.db.prepare(`WITH pending AS (SELECT s.id,s.account,s.room,s.time,s.json FROM snapshots s
      JOIN (SELECT MAX(id) AS id FROM snapshots GROUP BY account,room) latest ON latest.id=s.id
      LEFT JOIN feishu_delivery d ON d.destination=? AND d.account=s.account AND d.room=s.room
      WHERE (d.snapshot IS NULL OR s.id>d.snapshot)
      UNION ALL SELECT a.snapshot,a.account,a.room,'','{}' FROM feishu_attempt a
      WHERE a.destination=? AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.account=a.account AND s.room=a.room))
      SELECT * FROM pending WHERE account IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`).all(this.destination(), this.destination(), JSON.stringify(this.config.accountIds), limit);
  }
  pendingHistory(limit = 1000) {
    if (!this.destination() || !this.config.accountIds?.length) return [];
    return this.db.prepare(`SELECT h.account,h.room,h.json,r.json AS roomJson,a.fields AS attemptFields,a.version AS attemptVersion
      FROM history_reports h JOIN rooms r ON r.account=h.account AND r.id=h.room
      LEFT JOIN feishu_history_delivery d ON d.destination=? AND d.account=h.account AND d.room=h.room
      LEFT JOIN feishu_history_attempt a ON a.destination=? AND a.account=h.account AND a.room=h.room
      WHERE h.account IN (SELECT value FROM json_each(?)) AND json_extract(h.json,'$.retrievedAt') IS NOT NULL
        AND (a.version IS NOT NULL OR d.version IS NULL OR d.version<>json_extract(h.json,'$.retrievedAt'))
      ORDER BY h.account,h.room LIMIT ?`).all(this.destination(), this.destination(), JSON.stringify(this.config.accountIds), limit);
  }
  pendingHourly(limit = 1000) {
    if (!this.destination() || !this.config.accountIds?.length) return [];
    if (this.store.targetName() !== REVIEW_TARGET) return [];
    const selected = this.config.accountIds.filter(id => this.store.account(id).name === REVIEW_TARGET);
    if (selected.length !== 1) return [];
    const saved = this.db.prepare(`SELECT h.json FROM hourly_metrics h
      WHERE h.account IN (SELECT value FROM json_each(?)) ORDER BY h.hour_start,h.key`)
      .all(JSON.stringify(selected)).map(row => JSON.parse(row.json));
    const delivered = new Map(this.db.prepare('SELECT key,sampled_at FROM feishu_review_delivery WHERE destination=?')
      .all(this.destination()).map(row => [row.key, row.sampled_at]));
    return reviewRows(saved, this.now()).filter(row => {
      const prior = delivered.get(row.key);
      return !prior || !row.frozen && prior < row.sampledAt;
    }).slice(0, limit);
  }
  state() {
    const c = this.config;
    return {
      configured: Boolean(c.appSecret && c.appId && this.destination()), url: c.url || '', appId: c.appId || '', hasSecret: Boolean(c.appSecret),
      enabled: c.enabled === true, busy: Boolean(this.busy), verified: Boolean(c.verified),
      lastSuccess: c.lastSuccess || null, lastTest: c.lastTest || null, error: c.error || null,
      nextRetry: c.enabled && c.nextRetry ? new Date(c.nextRetry).toISOString() : null,
      pending: this.pending().length, synced: this.destination() ? this.db.prepare('SELECT COUNT(*) AS n FROM feishu_delivery WHERE destination=?').get(this.destination()).n : 0,
      historyEnabled: c.historyEnabled === true, historyPending: this.pendingHistory().length,
      historySynced: this.destination() ? this.db.prepare('SELECT COUNT(*) AS n FROM feishu_history_delivery WHERE destination=?').get(this.destination()).n : 0,
      hourlyPending: this.pendingHourly().length,
      hourlySynced: this.destination() ? this.db.prepare('SELECT COUNT(*) AS n FROM feishu_review_delivery WHERE destination=?').get(this.destination()).n : 0,
      hourlyTableReady: Boolean(c.reviewTableId),
      hourlyStorage: c.reviewTableId ? '小时复盘宽表' : '待创建',
      fields: FEISHU_FIELDS, missingFields: c.missingFields || [],
      accountIds: c.accountIds || [], accounts: this.store.accounts().map(({ id, name, label }) => ({ id, name, label })),
    };
  }
  configure(args) {
    if (this.busy) throw new Error('飞书操作正在进行，请完成后再修改配置');
    const parsed = parseBitableUrl(args.url);
    const appId = typeof args.appId === 'string' ? args.appId.trim() : '';
    if (!/^cli_[A-Za-z0-9]+$/.test(appId) || appId.length > 100) throw new Error('请填写飞书自建应用 App ID（cli_ 开头）');
    if (args.appSecret != null && typeof args.appSecret !== 'string') throw new Error('App Secret 格式无效');
    const appSecret = args.appSecret?.trim() || (appId === this.config.appId ? this.config.appSecret : '');
    if (!appSecret || appSecret.length > 256 || /\s/.test(appSecret)) throw new Error('请在本机填写该应用的 App Secret');
    const accountIds = args.accountIds ?? this.store.accounts().map(a => a.id);
    if (!Array.isArray(accountIds) || !accountIds.length || accountIds.some(id => typeof id !== 'string' || !this.store.accounts().some(a => a.id === id))) throw new Error('请至少选择一个已连接的罗盘账号');
    this.config = { ...parsed, appId, appSecret, accountIds: [...new Set(accountIds)], enabled: false,
      historyEnabled: false, verified: false, error: null };
    this.client = null; this.persist();
    return this.state();
  }
  saveDestination(args) {
    if (this.busy) throw new Error('飞书操作正在进行，请完成后再修改表格');
    const parsed = parseBitableUrl(args.url);
    const accountIds = args.accountIds ?? this.config.accountIds ?? this.store.accounts().map(a => a.id);
    if (!Array.isArray(accountIds) || accountIds.some(id => typeof id !== 'string' || !this.store.accounts().some(a => a.id === id))) throw new Error('同步账号选择无效');
    this.config = { ...this.config, ...parsed, reviewTableId: parsed.appToken === this.config.appToken ? this.config.reviewTableId : null,
      accountIds: [...new Set(accountIds)], enabled: false, historyEnabled: false,
      verified: false, error: null, missingFields: [], lastTest: null, lastSuccess: null, nextRetry: 0 };
    this.client = null; this.persist();
    return this.state();
  }
  getClient() {
    if (!this.state().configured) throw new Error('请先配置飞书多维表格链接和应用凭据');
    return this.client ||= this.clientFactory(this.config);
  }
  launch(operation) {
    this.getClient();
    if (this.stopping) throw new Error('同步服务正在停止');
    if (this.busy) return { ...this.state(), queued: false };
    this.busy = Promise.resolve().then(operation).catch(error => {
      const message = String(error.message || '飞书同步失败');
      this.config.error = [this.config.appSecret, this.client?.token].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), message).slice(0, 400);
      this.config.failures = (this.config.failures || 0) + 1;
      this.config.nextRetry = this.now() + Math.min(600, 30 * 2 ** Math.min(this.config.failures - 1, 5)) * 1000;
      this.persist();
    }).finally(() => { this.busy = null; });
    return { ...this.state(), queued: true };
  }
  test() {
    return this.launch(async () => {
      this.config.verified = false;
      this.config.missingFields = await this.getClient().schema(false);
      this.config.verified = true; this.config.lastTest = new Date(this.now()).toISOString();
      this.config.error = null; this.config.failures = 0; this.config.nextRetry = 0; this.persist();
    });
  }
  monitor(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动同步开关必须为布尔值');
    if (enabled) this.getClient();
    if (!enabled) this.pauseVersion++;
    this.config.enabled = enabled; this.config.nextRetry = 0; this.persist();
    if (enabled) return this.sync(false);
    return this.state();
  }
  historyMonitor(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('历史报表同步开关必须为布尔值');
    if (enabled) this.getClient();
    if (!enabled) this.pauseVersion++;
    this.config.historyEnabled = enabled; this.config.nextRetry = 0; this.persist();
    if (enabled) return this.sync(false);
    return this.state();
  }
  sync(manual = true) { const version = this.pauseVersion; return this.launch(() => this.run(version, manual)); }
  async run(version = this.pauseVersion, manual = true) {
    if (this.stopping || version !== this.pauseVersion) return;
    const client = this.getClient();
    const active = () => !this.stopping && version === this.pauseVersion;
    await client.schema(true, active);
    if (!active()) return;
    this.config.missingFields = []; this.config.verified = true;
    // Bound each pass. New snapshots remain pending until their own successful write.
    for (const row of manual || this.config.enabled ? this.pending(20) : []) {
      if (this.stopping || version !== this.pauseVersion) break;
      const account = this.store.account(row.account);
      const room = this.store.rooms(row.account).find(r => r.id === row.room) || { id: row.room };
      const snapshot = { ...JSON.parse(row.json), time: row.time };
      let attempt = this.db.prepare('SELECT * FROM feishu_attempt WHERE destination=? AND account=? AND room=?').get(this.destination(), row.account, row.room);
      if (!attempt) {
        attempt = { snapshot: row.id, fields: JSON.stringify(snapshotFields(account, room, snapshot)), token: crypto.randomUUID() };
        this.db.prepare('INSERT INTO feishu_attempt VALUES (?,?,?,?,?,?)').run(this.destination(), row.account, row.room, attempt.snapshot, attempt.token, attempt.fields);
      }
      const fields = JSON.parse(attempt.fields);
      const record = await client.upsert(fields['同步键'], fields, attempt.token, active);
      if (!record) break;
      const time = new Date(this.now()).toISOString();
      this.db.exec('BEGIN');
      try {
        this.db.prepare('INSERT INTO feishu_delivery (destination,account,room,snapshot,record,time) VALUES (?,?,?,?,?,?) ON CONFLICT(destination,account,room) DO UPDATE SET snapshot=excluded.snapshot,record=excluded.record,time=excluded.time').run(this.destination(), row.account, row.room, attempt.snapshot, record, time);
        this.db.prepare('DELETE FROM feishu_attempt WHERE destination=? AND account=? AND room=?').run(this.destination(), row.account, row.room);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.config.lastSuccess = time;
    }
    for (const row of this.config.historyEnabled ? this.pendingHistory(20) : []) {
      if (!active() || !this.config.historyEnabled) break;
      const account = this.store.account(row.account);
      const room = JSON.parse(row.roomJson), report = JSON.parse(row.json);
      let attempt = this.db.prepare('SELECT * FROM feishu_history_attempt WHERE destination=? AND account=? AND room=?').get(this.destination(), row.account, row.room);
      if (!attempt) {
        attempt = { version: report.retrievedAt, fields: JSON.stringify(historyFields(account, room, report)), token: crypto.randomUUID() };
        this.db.prepare('INSERT INTO feishu_history_attempt VALUES (?,?,?,?,?,?)').run(this.destination(), row.account, row.room, attempt.version, attempt.token, attempt.fields);
      }
      const fields = JSON.parse(attempt.fields);
      const record = await client.upsert(fields['同步键'], fields, attempt.token, active);
      if (!record) break;
      const time = new Date(this.now()).toISOString();
      this.db.exec('BEGIN');
      try {
        this.db.prepare('INSERT INTO feishu_history_delivery VALUES (?,?,?,?,?,?) ON CONFLICT(destination,account,room) DO UPDATE SET version=excluded.version,record=excluded.record,time=excluded.time').run(this.destination(), row.account, row.room, attempt.version, record, time);
        this.db.prepare('DELETE FROM feishu_history_attempt WHERE destination=? AND account=? AND room=?').run(this.destination(), row.account, row.room);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.config.lastSuccess = time;
    }
    if (manual || this.config.enabled) await this.syncHourly(client, active);
    this.config.error = null; this.config.failures = 0; this.config.nextRetry = 0; this.persist();
  }
  async hourlyClient(client, active) {
    const route = `/bitable/v1/apps/${this.config.appToken}/tables`;
    const items = []; let cursor = '';
    for (let page = 0; page < 20; page++) {
      const data = await client.request(`${route}?page_size=100${cursor ? '&page_token=' + encodeURIComponent(cursor) : ''}`);
      if (!Array.isArray(data.items)) throw new FeishuError('小时复盘表列表格式异常');
      items.push(...data.items);
      if (!data.has_more) break;
      if (!data.page_token || data.page_token === cursor || page === 19) throw new FeishuError('无法完整核对小时复盘数据表列表');
      cursor = data.page_token;
    }
    const existing = items.filter(item => item.name === '小时复盘');
    if (existing.length > 1) throw new FeishuError('发现多个同名小时复盘表，请先确认目标表');
    let tableId = existing[0]?.table_id;
    if (this.config.reviewTableId && tableId && this.config.reviewTableId !== tableId)
      throw new FeishuError('小时复盘表身份发生变化，已停止写入');
    if (!tableId && this.config.reviewTableId) throw new FeishuError('已配置的小时复盘表不在当前应用中');
    if (!tableId && active()) {
      const created = await client.request(route, { method: 'POST', body: { table: { name: '小时复盘',
        default_view_name: '今日按小时', fields: [{ field_name: '同步键', type: 1 }] } } });
      tableId = created.table_id || created.table?.table_id;
    }
    if (!tableId || !ID.test(tableId)) throw new FeishuError('小时复盘表创建响应无效');
    this.config.reviewTableId = tableId; this.persist();
    return new FeishuClient({ ...this.config, tableId }, client.fetcher);
  }
  async syncHourly(client, active) {
    const pending = this.pendingHourly(20);
    if (!pending.length || !active()) return;
    const hourly = await this.hourlyClient(client, active);
    await hourly.schema(true, active, REVIEW_FIELDS);
    for (const row of pending) {
      if (!active()) break;
      let attempt = this.db.prepare('SELECT * FROM feishu_review_attempt WHERE destination=? AND key=?').get(this.destination(), row.key);
      if (!attempt) {
        attempt = { sampled_at: row.sampledAt, fields: JSON.stringify(row.fields), token: crypto.randomUUID() };
        this.db.prepare('INSERT INTO feishu_review_attempt VALUES (?,?,?,?,?)').run(this.destination(), row.key, attempt.sampled_at, attempt.token, attempt.fields);
      }
      const fields = JSON.parse(attempt.fields);
      const mutable = !row.frozen && Date.parse(row.hourEnd.replace(' ', 'T') + '+08:00') > this.now();
      const record = await hourly.upsert(row.key, fields, attempt.token, active, mutable);
      if (!record) break;
      const time = new Date(this.now()).toISOString();
      this.db.exec('BEGIN');
      try {
        this.db.prepare(`INSERT INTO feishu_review_delivery VALUES (?,?,?,?,?) ON CONFLICT(destination,key)
          DO UPDATE SET sampled_at=excluded.sampled_at,record=excluded.record,time=excluded.time`).run(this.destination(), row.key, attempt.sampled_at, record, time);
        this.db.prepare('DELETE FROM feishu_review_attempt WHERE destination=? AND key=?').run(this.destination(), row.key);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.config.lastSuccess = time;
    }
  }
  syncReviewOnly() { const version = this.pauseVersion; return this.launch(() => this.runReviewOnly(version)); }
  async runReviewOnly(version) {
    const active = () => !this.stopping && version === this.pauseVersion;
    await this.syncHourly(this.getClient(), active);
    this.config.error = null; this.config.failures = 0; this.config.nextRetry = 0; this.persist();
  }
  tick() {
    if (!this.stopping && (this.config.enabled || this.config.historyEnabled) && !this.busy && this.now() >= (this.config.nextRetry || 0) &&
        (this.config.enabled && (this.pending(1).length || this.pendingHourly(1).length) || this.config.historyEnabled && this.pendingHistory(1).length)) this.sync(false);
  }
  async close() { this.stopping = true; if (this.busy) await this.busy; }
}
