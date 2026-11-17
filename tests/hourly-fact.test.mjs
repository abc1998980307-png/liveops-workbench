import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuClient } from '../rpa/feishu.mjs';
import { FACT_FIELDS, FACT_TABLE_NAME, accountStableKey, ensureFactTable, factFields,
  saveFactLocation } from '../rpa/hourly-fact.mjs';

const config = { appId: 'cli_synthetic', appSecret: 'synthetic-secret', appToken: 'appSynthetic' };
const reply = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
function mockApi({ loseCreate = false, wrongType = false, denyCreate = false } = {}) {
  const tables = [{ name: '旧宽表', table_id: 'tblOld' }];
  const fields = new Map();
  const calls = [];
  let lost = loseCreate;
  const fetcher = async (url, request) => {
    const parsed = new URL(url), body = request.body ? JSON.parse(request.body) : null;
    const route = parsed.pathname;
    calls.push({ route, method: request.method });
    if (route.endsWith('/oauth/v3/token'))
      return { ok: true, status: 200, json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (route.endsWith('/tables')) {
      if (request.method === 'GET') return reply({ items: tables, has_more: false });
      if (denyCreate) return { ok: false, status: 403, json: async () => ({ code: 1254302, msg: 'synthetic-secret' }) };
      const table = { name: body.table.name, table_id: 'tblFact' };
      tables.push(table);
      fields.set('tblFact', body.table.fields.map((field, i) => ({ ...field, field_id: `fldFact${i}` })));
      if (wrongType) fields.get('tblFact')[0].type = 2;
      if (lost) { lost = false; throw new Error('synthetic lost response'); }
      return reply({ table });
    }
    if (route.endsWith('/fields')) {
      const tableId = route.split('/').at(-2);
      if (request.method === 'GET') return reply({ items: fields.get(tableId) || [], has_more: false });
      fields.get(tableId).push({ ...body, field_id: `fldFact${fields.get(tableId).length}` });
      return reply({ field: fields.get(tableId).at(-1) });
    }
    throw new Error('Unexpected synthetic endpoint');
  };
  return { fetcher, tables, fields, calls };
}

test('fact key has all stable dimensions and source-specific trusted values preserve zero and missing', () => {
  const common = { accountUid: '100000000000001', sessionKey: 'session:0123456789abcdef01234567',
    hourStart: '2026-11-17 10:00:00', hourEnd: '2026-11-17 11:00:00', version: 'live',
    status: '已读取', sampledAt: '2026-11-17T03:01:00Z' };
  const official = factFields({ ...common, platform: '巨量千川', source: '巨量千川', grain: '官方小时',
    metrics: { stat_cost: { value: 0, unit: '元', status: '已读取' } } });
  const boundary = factFields({ ...common, platform: '电商罗盘', source: '电商罗盘', grain: '边界快照',
    metrics: { pay_amt: { value: null, unit: '元', status: '缺失' }, pay_ucnt: { value: 0, unit: '人', status: '已读取' } } });
  assert.equal(official['官方小时消耗（元）'], '0');
  assert.equal(boundary['边界快照·成交金额'], '');
  assert.equal(boundary['边界快照·支付人数'], '0');
  assert.notEqual(official['同步键'], boundary['同步键']);
  assert.deepEqual(JSON.parse(official['同步键']), [accountStableKey(common.accountUid), '巨量千川',
    common.sessionKey, common.hourStart, common.hourEnd, common.version]);
  assert.ok(!official['同步键'].includes(common.accountUid));
  assert.equal(JSON.parse(boundary['指标可信性']).pay_amt.status, '缺失');
  assert.throws(() => factFields({ ...common, platform: '巨量千川', source: '巨量千川', grain: '官方小时',
    metrics: { gpm: { value: 10, status: '已读取' } } }), /未核验/);
  assert.throws(() => factFields({ ...common, platform: '巨量千川', source: '巨量千川', grain: '官方小时',
    metrics: { stat_cost: { value: 10, unit: '分', status: '已读取' } } }), /单位未核验/);
  assert.throws(() => factFields({ ...common, platform: '电商罗盘', source: '电商罗盘', grain: '官方小时' }), /未核验/);
});

test('provisioning creates once, reuses exact table and repairs missing text fields', async () => {
  const api = mockApi();
  const first = await ensureFactTable(config, api.fetcher);
  assert.equal(first.created, true);
  assert.equal(api.tables.filter(table => table.name === FACT_TABLE_NAME).length, 1);
  api.fields.get('tblFact').pop();
  const second = await ensureFactTable(config, api.fetcher, first.tableId);
  assert.equal(second.created, false);
  assert.equal(second.fields.length, FACT_FIELDS.length);
  assert.equal(api.calls.filter(call => call.route.endsWith('/tables') && call.method === 'POST').length, 1);
  assert.equal(api.calls.filter(call => call.route.endsWith('/fields') && call.method === 'POST').length, 1);
});

test('lost create response reconciles by table name without creating a duplicate', async () => {
  const api = mockApi({ loseCreate: true });
  const result = await ensureFactTable(config, api.fetcher);
  assert.equal(result.fields.length, FACT_FIELDS.length);
  assert.equal(api.tables.filter(table => table.name === FACT_TABLE_NAME).length, 1);
});

test('permission error and wrong field type stop without changing other tables', async () => {
  const denied = mockApi({ denyCreate: true });
  await assert.rejects(ensureFactTable(config, denied.fetcher), error => {
    assert.equal(error.code, 1254302);
    assert.match(error.message, /创建数据表/);
    assert.ok(!error.message.includes('synthetic-secret'));
    return true;
  });
  assert.equal(denied.tables.length, 1);
  const wrong = mockApi({ wrongType: true });
  await assert.rejects(ensureFactTable(config, wrong.fetcher), /缺少预期主键字段/);
  assert.equal(wrong.tables[0].name, '旧宽表');
});

test('unrelated same-name table is left untouched', async () => {
  const api = mockApi();
  api.tables.push({ name: FACT_TABLE_NAME, table_id: 'tblFact' });
  api.fields.set('tblFact', [{ field_name: '其他主键', type: 1, field_id: 'fldOther' }]);
  await assert.rejects(ensureFactTable(config, api.fetcher), /缺少预期主键字段/);
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.route.endsWith('/fields')).length, 0);
});

test('synthetic keyed upsert reconciles a lost response and rejects unknown remote edits', async () => {
  const records = new Map(); let lost = true;
  const fetcher = async (url, request) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/oauth/v3/token'))
      return { ok: true, status: 200, json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (route.endsWith('/records/search')) {
      const key = JSON.parse(request.body).filter.conditions[0].value[0];
      return reply({ items: [...records.values()].filter(item => item.fields['同步键'] === key), has_more: false });
    }
    if (route.endsWith('/records') && request.method === 'POST') {
      const record = { record_id: 'recSynthetic', fields: JSON.parse(request.body).fields };
      records.set(record.record_id, record);
      if (lost) { lost = false; throw new Error('synthetic lost response'); }
      return reply({ record });
    }
    if (route.endsWith('/recSynthetic') && request.method === 'PUT') {
      const record = { record_id: 'recSynthetic', fields: JSON.parse(request.body).fields };
      records.set(record.record_id, record);
      return reply({ record });
    }
    throw new Error('Unexpected synthetic endpoint');
  };
  const client = new FeishuClient({ ...config, tableId: 'tblFact' }, fetcher);
  const fields = { 同步键: 'synthetic-key', 同步状态: '待同步', '官方小时消耗（元）': '0' };
  await assert.rejects(client.upsert(fields['同步键'], fields, 'synthetic-token', () => true, true, null), /请求失败/);
  assert.equal(await client.upsert(fields['同步键'], fields, 'synthetic-token', () => true, true, null), 'recSynthetic');
  const updated = { ...fields, '官方小时消耗（元）': '1' };
  assert.equal(await client.upsert(fields['同步键'], updated, 'synthetic-token', () => true, true, fields), 'recSynthetic');
  records.get('recSynthetic').fields['官方小时消耗（元）'] = 'manual';
  await assert.rejects(client.upsert(fields['同步键'], { ...updated, 同步状态: '已同步' },
    'synthetic-token', () => true, true, updated), /上次交付内容不一致/);
});

test('local table location is private and refuses a conflicting overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-fact-'));
  try {
    const file = path.join(root, 'hourly-fact-table.json');
    saveFactLocation(file, 'appSynthetic', 'tblFact');
    const first = fs.readFileSync(file, 'utf8');
    saveFactLocation(file, 'appSynthetic', 'tblFact');
    assert.equal(fs.readFileSync(file, 'utf8'), first);
    assert.throws(() => saveFactLocation(file, 'appSynthetic', 'tblOther'), /不一致/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true }); }
});
