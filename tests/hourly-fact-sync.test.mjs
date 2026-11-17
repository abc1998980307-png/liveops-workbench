import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../rpa/store.mjs';
import { compassHourlyRows, qianchuanHourlyRows } from '../rpa/hourly.mjs';
import { FACT_FIELDS, FACT_NUMBER_FIELDS, FACT_DATE_FIELDS, encodeFactFields,
  factSchemaTypes, saveFactLocation } from '../rpa/hourly-fact.mjs';
import { HourlyFactSync, prepareFactRows } from '../rpa/hourly-fact-sync.mjs';

const target = '雪梨老师阅读100篇';
const since = '2026-11-17T00:00:00.000Z';
const sampledAt = '2026-11-17T03:01:00.000Z';
const account = { id: 'synthetic-account', uid: '100000000000001', name: target,
  observedName: target, observedUidMatchesStored: true, verifiedAt: sampledAt };
const room = { id: 'synthetic-room', startedAt: '2026-11-17 10:00:00', state: 'live' };
const reply = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-fact-sync-'));
  const store = new Store(root);
  store.save(account); store.setTargetName(target); store.saveRoom(account.id, room);
  store.db.exec('CREATE TABLE feishu_config (id INTEGER PRIMARY KEY, json TEXT NOT NULL)');
  store.db.prepare('INSERT INTO feishu_config VALUES (1,?)').run(JSON.stringify({ appId: 'cli_synthetic',
    appSecret: 'synthetic-secret', appToken: 'appSynthetic', tableId: 'tblOld' }));
  saveFactLocation(path.join(root, 'hourly-fact-table.json'), 'appSynthetic', 'tblFact');
  const close = () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, store, close };
}

function official(value, time = sampledAt) {
  return qianchuanHourlyRows({ status_code: 0, data: { StatsData: { Rows: [{
    Dimensions: { room_id: { Value: room.id }, stat_time_hour: { ValueStr: '2026-11-17 10:00:00' } },
    Metrics: { stat_cost: { Value: value, ValueStr: value.toFixed(2) } },
  }] } } }, account, room, time);
}

function syntheticApi({ deny = false, lose = false, loseUpdate = false, duplicate = false, wrongTable = false,
  fieldTypes = {} } = {}) {
  const records = new Map(); const calls = [];
  let lost = lose, updateLost = loseUpdate;
  const fetcher = async (url, request) => {
    const parsed = new URL(url), route = parsed.pathname;
    const body = request.body ? JSON.parse(request.body) : null;
    calls.push({ route, method: request.method });
    if (route.endsWith('/oauth/v3/token'))
      return { ok: true, status: 200, json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (route.endsWith('/tables')) return reply({ items: [{ name: '旧宽表', table_id: 'tblOld' },
      { name: wrongTable ? '其他合成表' : '小时事实表', table_id: 'tblFact' }], has_more: false });
    if (route.endsWith('/fields')) return reply({ items: FACT_FIELDS.map(field_name => ({ field_name,
      type: fieldTypes[field_name] || 1 })), has_more: false });
    if (route.endsWith('/records/search')) {
      const key = body.filter.conditions[0].value[0];
      const found = [...records.values()].filter(item => item.fields['同步键'] === key);
      return reply({ items: duplicate && found.length ? [found[0], { ...found[0], record_id: 'recDuplicate' }] : found,
        has_more: false });
    }
    if (route.includes('/records')) {
      if (deny) return { ok: false, status: 403, json: async () => ({ code: 1254302, msg: 'synthetic-secret' }) };
      const recordId = request.method === 'PUT' ? route.split('/').at(-1) : `recSynthetic${records.size}`;
      const record = { record_id: recordId, fields: body.fields };
      records.set(recordId, record);
      if (lost) { lost = false; throw new Error('synthetic lost response'); }
      if (request.method === 'PUT' && updateLost) {
        updateLost = false; throw new Error('synthetic lost update response');
      }
      return reply({ record });
    }
    throw new Error('unexpected synthetic endpoint');
  };
  return { fetcher, records, calls };
}

test('source mapping preserves zero, missing, snapshots and official hourly evidence', () => {
  const f = fixture();
  try {
    f.store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [
      { key: 'pay_ucnt', value: 0, unit: '人' }, { key: 'pay_amt', value: null, unit: '元' },
    ] }, sampledAt));
    f.store.saveHourly(official(0));
    const prepared = prepareFactRows(f.store, since);
    assert.equal(prepared.length, 2);
    const snapshot = prepared.find(item => item.fields.平台 === '电商罗盘').fields;
    const hourly = prepared.find(item => item.fields.平台 === '巨量千川').fields;
    assert.equal(snapshot['边界快照·支付人数'], '0');
    assert.equal(snapshot['边界快照·成交金额'], '');
    assert.equal(hourly['官方小时消耗（元）'], '0');
    assert.equal(snapshot['官方小时消耗（元）'], '');
    assert.equal(hourly['边界快照·支付人数'], '');
    assert.notEqual(snapshot['同步键'], hourly['同步键']);
    assert.equal(JSON.parse(snapshot['指标可信性']).pay_amt.status, '缺失');
    assert.equal(JSON.parse(hourly['指标可信性']).stat_cost.pagination, '单页已核验');
    assert.match(JSON.parse(hourly['指标可信性']).stat_cost.accountBinding, /未证明/);
    assert.throws(() => prepareFactRows(f.store, ''), /采样起点/);
    assert.equal(prepareFactRows(f.store, '2026-11-17T03:00:00.000Z').length, 0);
    f.store.save({ ...account, observedUidMatchesStored: false });
    assert.throws(() => prepareFactRows(f.store, since), /账号映射未经核验/);
  } finally { f.close(); }
});

test('unrelated saved accounts do not block the unique verified target', () => {
  const f = fixture();
  try {
    const other = { ...account, id: 'synthetic-other', uid: '100000000000002',
      name: '其他合成账号', observedName: '其他合成账号' };
    f.store.save(other); f.store.saveRoom(other.id, room);
    f.store.saveHourly(qianchuanHourlyRows({ status_code: 0, data: { StatsData: { Rows: [{
      Dimensions: { room_id: { Value: room.id }, stat_time_hour: { ValueStr: '2026-11-17 10:00:00' } },
      Metrics: { stat_cost: { Value: 1, ValueStr: '1.00' } },
    }] } } }, other, room, sampledAt));
    f.store.saveHourly(official(0));
    assert.equal(prepareFactRows(f.store, since).length, 1);
  } finally { f.close(); }
});

test('numeric and date adapter requires an exact schema and preserves numeric zero', () => {
  const fields = FACT_FIELDS.map(field_name => ({ field_name, type:
    FACT_NUMBER_FIELDS.includes(field_name) ? 2 : FACT_DATE_FIELDS.includes(field_name) ? 5 : 1 }));
  const types = factSchemaTypes(fields);
  const encoded = encodeFactFields({ '官方小时消耗（元）': '0', '边界快照·支付人数': '',
    '小时开始（北京时间）': '2026-11-17 10:00:00', 采样时间: sampledAt }, types);
  assert.equal(encoded['官方小时消耗（元）'], 0);
  assert.equal(encoded['边界快照·支付人数'], null);
  assert.equal(encoded['小时开始（北京时间）'], Date.parse('2026-11-17T10:00:00+08:00'));
  assert.equal(encoded.采样时间, Date.parse(sampledAt));
  assert.throws(() => factSchemaTypes(fields.slice(1)), /缺失/);
  assert.throws(() => factSchemaTypes([...fields, fields[0]]), /重复/);
  assert.throws(() => factSchemaTypes(fields.map(f => f.field_name === '同步键' ? { ...f, type: 2 } : f)), /不适配/);
});

test('later missing snapshot clears an earlier value without turning it into zero', () => {
  const f = fixture();
  try {
    f.store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [
      { key: 'pay_ucnt', value: 3, unit: '人' },
    ] }, sampledAt));
    f.store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [
      { key: 'pay_ucnt', value: null, unit: '人' },
    ] }, '2026-11-17T03:02:00.000Z'));
    const fields = prepareFactRows(f.store, since)[0].fields;
    assert.equal(fields['边界快照·支付人数'], '');
    assert.equal(JSON.parse(fields['指标可信性']).pay_ucnt.status, '缺失');
  } finally { f.close(); }
});

test('location cannot point at either legacy table or a permissive config file', async () => {
  const f = fixture();
  try {
    const location = path.join(f.root, 'hourly-fact-table.json');
    fs.writeFileSync(location, JSON.stringify({ appToken: 'appSynthetic', tableId: 'tblOld',
      tableName: '小时事实表', schemaVersion: 1 }));
    const api = syntheticApi();
    const sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher });
    await assert.rejects(sync.sync({ since }), /定位.*不一致/);
    assert.equal(api.calls.length, 0);
    if (process.platform !== 'win32') {
      fs.chmodSync(location, 0o644);
      await assert.rejects(sync.sync({ since }), /权限或格式无效/);
    }
    sync.close();
  } finally { f.close(); }
});

test('remote table identity must match the protected locator before record access', async () => {
  const f = fixture();
  try {
    f.store.saveHourly(official(0));
    const api = syntheticApi({ wrongTable: true });
    const sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher });
    await assert.rejects(sync.sync({ since }), /远端身份不一致/);
    assert.equal(api.calls.filter(call => call.route.includes('/records')).length, 0);
    sync.close();
  } finally { f.close(); }
});

test('permission error retains a persistent attempt and retry resumes after backoff', async () => {
  const f = fixture(); let now = Date.parse(sampledAt);
  try {
    f.store.saveHourly(official(0));
    const denied = syntheticApi({ deny: true });
    let sync = new HourlyFactSync(f.root, f.store, { fetcher: denied.fetcher, now: () => now });
    await assert.rejects(sync.sync({ since }), error => {
      assert.equal(error.code, 1254302);
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
    assert.equal(sync.db.prepare('SELECT failures FROM attempt').get().failures, 1);
    sync.close();
    now += 31000;
    const recovered = syntheticApi();
    sync = new HourlyFactSync(f.root, f.store, { fetcher: recovered.fetcher, now: () => now });
    assert.deepEqual(await sync.sync({ since }), { delivered: 1, pending: 0, deferred: 0 });
    assert.equal(recovered.records.size, 1);
    sync.close();
  } finally { f.close(); }
});

test('lost response reconciles remote write; duplicate and manual conflict remain pending', async () => {
  const f = fixture(); let now = Date.parse(sampledAt);
  try {
    f.store.saveHourly(official(1));
    const api = syntheticApi({ lose: true });
    let sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher, now: () => now });
    await assert.rejects(sync.sync({ since }), /请求失败/);
    assert.equal(api.records.size, 1);
    sync.close(); now += 31000;
    sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher, now: () => now });
    assert.equal((await sync.sync({ since })).delivered, 1);
    assert.equal(api.calls.filter(call => call.method === 'POST' && call.route.endsWith('/records')).length, 1);
    f.store.saveHourly(official(2, '2026-11-17T03:02:00.000Z'));
    assert.equal((await sync.sync({ since })).delivered, 1);
    assert.equal(api.records.values().next().value.fields['官方小时消耗（元）'], '2');
    f.store.saveHourly(official(3, '2026-11-17T03:03:00.000Z'));
    api.records.values().next().value.fields['官方小时消耗（元）'] = 'manual';
    await assert.rejects(sync.sync({ since }), /远端内容/);
    assert.equal(sync.db.prepare('SELECT COUNT(*) AS n FROM attempt').get().n, 1);
    sync.close();
    now += 31000;
    const repeated = syntheticApi({ duplicate: true });
    for (const [id, record] of api.records) repeated.records.set(id, record);
    sync = new HourlyFactSync(f.root, f.store, { fetcher: repeated.fetcher, now: () => now });
    await assert.rejects(sync.sync({ since }), /远端重复/);
    assert.equal(sync.db.prepare('SELECT COUNT(*) AS n FROM attempt').get().n, 1);
    sync.close();
  } finally { f.close(); }
});

test('lost update response reconciles, while remote deletion stays a conflict', async () => {
  const f = fixture(); let now = Date.parse(sampledAt);
  try {
    f.store.saveHourly(official(1));
    const api = syntheticApi({ loseUpdate: true });
    let sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher, now: () => now });
    assert.equal((await sync.sync({ since })).delivered, 1);
    f.store.saveHourly(official(2, '2026-11-17T03:02:00.000Z'));
    await assert.rejects(sync.sync({ since }), /请求失败/);
    sync.close(); now += 31000;
    sync = new HourlyFactSync(f.root, f.store, { fetcher: api.fetcher, now: () => now });
    assert.equal((await sync.sync({ since })).delivered, 1);
    assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1);
    api.records.clear();
    f.store.saveHourly(official(3, '2026-11-17T03:03:00.000Z'));
    await assert.rejects(sync.sync({ since }), /远端缺失/);
    assert.equal(api.records.size, 0);
    sync.close();
  } finally { f.close(); }
});
