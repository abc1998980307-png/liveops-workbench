import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rpaDataRoot } from '../rpa/platform.mjs';
import { FeishuClient } from '../rpa/feishu.mjs';
import { ensureFactTable, FACT_FIELDS, listTables, saveFactLocation } from '../rpa/hourly-fact.mjs';

const root = rpaDataRoot();
const dbFile = path.join(root, 'data.sqlite');
const locationFile = path.join(root, 'hourly-fact-table.json');

async function views(client) {
  const items = []; let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await client.request(`${client.base}/views?page_size=100${cursor ? '&page_token=' + encodeURIComponent(cursor) : ''}`);
    if (!Array.isArray(data.items)) throw new Error('旧视图清单格式异常');
    items.push(...data.items);
    if (!data.has_more) return items;
    if (!data.page_token || data.page_token === cursor) throw new Error('旧视图分页异常');
    cursor = data.page_token;
  }
  throw new Error('旧视图过多，无法完整核对');
}

async function oldMetadata(config) {
  const client = new FeishuClient(config);
  const tables = await listTables(client);
  const oldIds = [config.tableId, config.reviewTableId].filter(Boolean);
  const old = [];
  for (const tableId of oldIds) {
    const table = tables.find(item => item.table_id === tableId);
    if (!table) throw new Error('原有数据表不在当前应用中');
    const target = new FeishuClient({ ...config, tableId });
    old.push({ table, fields: await target.fields(), views: await views(target) });
  }
  return JSON.stringify(old);
}

function localConfig() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const json = db.prepare('SELECT json FROM feishu_config WHERE id=1').get()?.json;
    if (!json) throw new Error('现有飞书配置不存在');
    const config = JSON.parse(json);
    if (!config.appId || !config.appSecret || !config.appToken || !config.tableId)
      throw new Error('现有飞书配置不完整');
    return { json, config };
  } finally { db.close(); }
}

try {
  if (!fs.existsSync(dbFile)) throw new Error('本地采集数据库不存在');
  const before = localConfig();
  const oldBefore = await oldMetadata(before.config);
  let expected = null;
  if (fs.existsSync(locationFile)) {
    const saved = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
    if (saved.appToken !== before.config.appToken) throw new Error('已保存的小时事实表不属于当前应用');
    expected = saved.tableId;
  }
  const result = await ensureFactTable(before.config, globalThis.fetch, expected);
  const oldAfter = await oldMetadata(before.config);
  if (oldBefore !== oldAfter || before.json !== localConfig().json)
    throw new Error('原有飞书表、视图或同步配置对照不一致');
  saveFactLocation(locationFile, before.config.appToken, result.tableId);
  console.log(JSON.stringify({ status: '已建成真实新表', created: result.created,
    fieldCount: result.fields.length, fieldTypes: [...new Set(result.fields.map(item => item.type))],
    expectedFieldCount: FACT_FIELDS.length, oldMetadataUnchanged: true,
    oldSyncConfigUnchanged: true, businessRowsWritten: 0 }));
} catch (error) {
  // The public API client already strips remote messages, request bodies and identifiers.
  const message = String(error?.message || '未知错误');
  console.error(message.replace(/https?:\/\/\S+|(?:cli_|tbl|app)[A-Za-z0-9_-]{6,}/g, '[已脱敏]'));
  process.exitCode = 1;
}
