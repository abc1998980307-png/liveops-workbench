import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuClient, FeishuError } from './feishu.mjs';

export const FACT_TABLE_NAME = '小时事实表';
export const FACT_VIEW_NAME = '小时事实';
export const FACT_METRICS = Object.freeze({
  stat_cost: ['官方小时消耗（元）', '巨量千川', '官方小时'],
  online_user_cnt: ['边界快照·在线人数', '电商罗盘', '边界快照'],
  watch_ucnt: ['边界快照·进入人数', '电商罗盘', '边界快照'],
  pay_ucnt: ['边界快照·支付人数', '电商罗盘', '边界快照'],
  pay_amt: ['边界快照·成交金额', '电商罗盘', '边界快照'],
  pay_combo_cnt: ['边界快照·成交订单', '电商罗盘', '边界快照'],
  avg_watch_duration: ['边界快照·人均观看时长', '电商罗盘', '边界快照'],
  follow_anchor_ucnt: ['边界快照·新增关注', '电商罗盘', '边界快照'],
});
export const FACT_FIELDS = [
  '同步键', '账号稳定键', '平台', '场次稳定键', '小时开始（北京时间）', '小时结束（北京时间）',
  '版本', '来源', '粒度', '采集状态', '同步状态', '采样时间',
  ...Object.values(FACT_METRICS).map(([name]) => name), '指标可信性',
];
export const FACT_NUMBER_FIELDS = Object.freeze(Object.values(FACT_METRICS).map(([name]) => name));
export const FACT_DATE_FIELDS = Object.freeze(['小时开始（北京时间）', '小时结束（北京时间）', '采样时间']);
const ID = /^[A-Za-z0-9_-]+$/;
const HOUR = /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/;

export function accountStableKey(uid) {
  if (!/^\d{1,30}$/.test(String(uid))) throw new Error('账号身份未核验');
  return `account:${crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 24)}`;
}

export function factKey({ accountKey, platform, sessionKey, hourStart, hourEnd, version }) {
  if (!/^account:[a-f0-9]{24}$/.test(accountKey) || !['电商罗盘', '巨量千川'].includes(platform) ||
      !/^session:[a-f0-9]{24}$/.test(sessionKey) || !HOUR.test(hourStart) || !HOUR.test(hourEnd) ||
      !['live', 'post-live', 'unknown'].includes(version) ||
      Date.parse(hourEnd.replace(' ', 'T') + '+08:00') - Date.parse(hourStart.replace(' ', 'T') + '+08:00') !== 3600000)
    throw new Error('小时事实同步维度无效');
  return JSON.stringify([accountKey, platform, sessionKey, hourStart, hourEnd, version]);
}

export function factFields({ accountUid, platform, sessionKey, hourStart, hourEnd, version,
  source, grain, status, sampledAt, metrics = {} }) {
  if (!((platform === '巨量千川' && source === '巨量千川' && grain === '官方小时') ||
        (platform === '电商罗盘' && source === '电商罗盘' && grain === '边界快照')))
    throw new Error('来源与粒度未核验');
  if (!['已读取', '缺失', '失败'].includes(status) || !Number.isFinite(Date.parse(sampledAt)))
    throw new Error('采集状态或采样时间无效');
  const accountKey = accountStableKey(accountUid);
  const fields = {
    同步键: factKey({ accountKey, platform, sessionKey, hourStart, hourEnd, version }),
    账号稳定键: accountKey, 平台: platform, 场次稳定键: sessionKey,
    '小时开始（北京时间）': hourStart, '小时结束（北京时间）': hourEnd,
    版本: version, 来源: source, 粒度: grain, 采集状态: status,
    同步状态: '待同步', 采样时间: sampledAt,
  };
  const trust = {};
  for (const [name] of Object.values(FACT_METRICS)) fields[name] = '';
  for (const [key, item] of Object.entries(metrics)) {
    const spec = FACT_METRICS[key];
    if (!spec || spec[1] !== source || spec[2] !== grain) throw new Error('指标来源或粒度未核验');
    if (!item || !['已读取', '缺失', '失败'].includes(item.status)) throw new Error('指标状态无效');
    if (key === 'stat_cost' && item.status === '已读取' && item.unit !== '元')
      throw new Error('官方小时消耗单位未核验');
    if (item.status === '已读取' && !Number.isFinite(item.value)) throw new Error('可信指标缺少数值');
    fields[spec[0]] = item.status === '已读取' ? String(item.value) : '';
    trust[key] = { ...(item.evidence || {}), status: item.status, source, grain,
      unit: String(item.unit || '') };
  }
  fields['指标可信性'] = JSON.stringify(trust);
  return fields;
}

export function factSchemaTypes(fields) {
  const types = {};
  for (const name of FACT_FIELDS) {
    const found = fields.filter(field => field.field_name === name);
    const allowed = FACT_NUMBER_FIELDS.includes(name) ? [1, 2] : FACT_DATE_FIELDS.includes(name) ? [1, 5] : [1];
    if (found.length !== 1 || !allowed.includes(found[0].type))
      throw new FeishuError('小时事实表字段缺失、重复或类型不适配，已停止写入');
    types[name] = found[0].type;
  }
  return types;
}

export function encodeFactFields(fields, types) {
  const encoded = {};
  for (const name of FACT_FIELDS) {
    if (!(name in fields)) continue;
    const value = fields[name];
    if (types[name] === 2) {
      if (value === '' || value == null) encoded[name] = null;
      else {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error('小时事实数值无效');
        encoded[name] = number;
      }
    } else if (types[name] === 5) {
      const time = name === '采样时间' ? Date.parse(value) : Date.parse(String(value).replace(' ', 'T') + '+08:00');
      if (!Number.isFinite(time)) throw new Error('小时事实日期无效');
      encoded[name] = time;
    } else if (types[name] === 1) encoded[name] = String(value ?? '');
    else throw new Error('小时事实字段类型未经核验');
  }
  return encoded;
}

export async function listTables(client) {
  const items = []; let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await client.request(`/bitable/v1/apps/${client.config.appToken}/tables?page_size=100${cursor ? '&page_token=' + encodeURIComponent(cursor) : ''}`);
    if (!Array.isArray(data.items)) throw new FeishuError('数据表列表格式异常');
    items.push(...data.items);
    if (!data.has_more) return items;
    if (!data.page_token || data.page_token === cursor) throw new FeishuError('数据表分页异常');
    cursor = data.page_token;
  }
  throw new FeishuError('数据表过多，无法完整核对');
}

export async function ensureFactTable(config, fetcher = globalThis.fetch, expectedTableId = null) {
  const client = new FeishuClient(config, fetcher);
  const route = `/bitable/v1/apps/${config.appToken}/tables`;
  let matches = (await listTables(client)).filter(item => item.name === FACT_TABLE_NAME);
  if (matches.length > 1) throw new FeishuError('发现多个同名小时事实表，已停止');
  let created = false;
  if (!matches.length) {
    try {
      await client.request(route, { method: 'POST', body: { table: { name: FACT_TABLE_NAME,
        default_view_name: FACT_VIEW_NAME, fields: FACT_FIELDS.map(field_name => ({ field_name, type: 1 })) } } });
      created = true;
    } catch (error) {
      // A lost response may follow a successful create; explicit API errors are terminal.
      if (error.code || !/请求失败或超时/.test(error.message)) throw error;
    }
    matches = (await listTables(client)).filter(item => item.name === FACT_TABLE_NAME);
    if (matches.length !== 1) throw new FeishuError('建表结果无法唯一确认，已停止');
  }
  const tableId = matches[0].table_id;
  if (!ID.test(tableId || '')) throw new FeishuError('小时事实表定位无效');
  if (expectedTableId && tableId !== expectedTableId) throw new FeishuError('已保存的小时事实表定位与远端不一致');
  const tableClient = new FeishuClient({ ...config, tableId }, fetcher);
  let fields = await tableClient.fields();
  if (!fields.some(item => item.field_name === '同步键' && item.type === 1))
    throw new FeishuError('同名小时事实表缺少预期主键字段，已停止适配');
  for (const name of FACT_FIELDS) {
    const found = fields.filter(item => item.field_name === name);
    if (found.length > 1 || found.some(item => item.type !== 1)) throw new FeishuError('小时事实表同名字段类型或数量不符');
    if (!found.length) await tableClient.request(`${tableClient.base}/fields`, {
      method: 'POST', body: { field_name: name, type: 1 },
    });
  }
  fields = await tableClient.fields();
  if (!FACT_FIELDS.every(name => fields.filter(item => item.field_name === name && item.type === 1).length === 1))
    throw new FeishuError('小时事实表字段核验未通过');
  return { tableId, created, fields: fields.filter(item => FACT_FIELDS.includes(item.field_name)) };
}

export function saveFactLocation(file, appToken, tableId) {
  if (!ID.test(appToken || '') || !ID.test(tableId || '')) throw new Error('小时事实表定位无效');
  const content = JSON.stringify({ appToken, tableId, tableName: FACT_TABLE_NAME, schemaVersion: 1 }) + '\n';
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === content) return;
    throw new Error('本地小时事实表定位与已保存内容不一致');
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
