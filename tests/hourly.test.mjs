import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../rpa/store.mjs';
import { Collector } from '../rpa/collector.mjs';
import { boundaryWindow, compassHourlyRows, qianchuanHourlyFailure, qianchuanHourlyRequest, qianchuanHourlyRows } from '../rpa/hourly.mjs';
import { FEISHU_FIELDS, HOURLY_FIELDS, FeishuClient, FeishuSync, hourlyFields, hourlyLegacyFields } from '../rpa/feishu.mjs';

const account = { id: 'local-test', uid: '1001', name: '测试直播号' };
const room = { id: '2001', startedAt: '2026-11-15 08:12:00', state: 'live' };
const sampledAt = '2026-11-15T01:01:00.000Z';

test('hour boundary stores Compass observations without claiming hourly increments', () => {
  assert.deepEqual(boundaryWindow(sampledAt), { hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00' });
  assert.equal(boundaryWindow('2026-11-15T01:06:00Z'), null);
  const snapshot = { state: 'live', metrics: [
    { key: 'online_user_cnt', value: 0, display: '0', unit: '人' },
    { key: 'watch_pay_ucnt_ratio', value: 0.03, display: '3%', unit: '%' },
  ], spendReconciliation: { compass: { amount: '2.00', display: '2.00' } } };
  const rows = compassHourlyRows(account, room, snapshot, sampledAt);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].grain, '边界快照');
  assert.match(rows[0].statisticalWindow, /字段级小时映射未核实/);
  assert.equal(rows[0].value, 0);
  assert.equal(rows.find(row => row.metricKey === 'pay_amt').status, '缺失');
  assert.equal(rows.at(-1).grain, '独立对照');
  assert.match(rows.at(-1).statisticalWindow, /非小时消耗/);
  assert.ok(!rows[0].sessionKey.includes(account.uid));
  assert.equal(hourlyFields(rows[0])['值'], '0');
});

test('hourly follow unit discards nan and state needs a reliable signal', () => {
  const snapshot = { state: 'unknown', metrics: [
    { key: 'follow_anchor_ucnt', value: 3, display: '3', unit: 'nan' },
  ] };
  const uncertain = compassHourlyRows(account, { ...room, state: 'unknown' }, snapshot, sampledAt);
  assert.equal(uncertain.find(row => row.metricKey === 'follow_anchor_ucnt').unit, '人');
  assert.equal(uncertain[0].streamState, '直播状态待确认');
  const ended = compassHourlyRows(account, { ...room, state: 'ended' }, snapshot, sampledAt);
  assert.equal(ended[0].streamState, '下播后');
  assert.equal(compassHourlyRows(account, room, { state: 'unknown', metrics: [] }, sampledAt)[0].streamState, '在播观测');
});

test('stored uncertain hourly row resolves only with ended report and final values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-final-'));
  const store = new Store(root);
  try {
    store.save(account);
    store.saveRoom(account.id, { ...room, state: 'ended' });
    const row = compassHourlyRows(account, { ...room, state: 'unknown' },
      { state: 'unknown', metrics: [{ key: 'follow_anchor_ucnt', value: 3, display: '3', unit: 'nan' }] }, sampledAt)
      .find(item => item.metricKey === 'follow_anchor_ucnt');
    store.saveHourly([{ ...row, unit: 'nan' }]);
    const state = () => store.hourly(account.id, room.id)[0];
    assert.equal(state().streamState, '直播状态待确认');
    assert.equal(state().unit, '人');
    const report = { roomState: 'ended', endedAt: '2026-11-15T00:30:00.000Z',
      endpoints: { historyBasic: { ok: true } }, metrics: [{ key: 'follow_anchor_ucnt', value: 3 }] };
    store.saveHistoryReport(account.id, room.id, report, {});
    assert.equal(state().streamState, '下播后');
    store.saveHistoryReport(account.id, room.id, { ...report, metrics: [{ value: null }] }, {});
    assert.equal(state().streamState, '直播状态待确认');
  } finally { store.close(); fs.rmSync(root, { recursive: true }); }
});

test('Qianchuan hourly report keeps official buckets, current room and live/post-live versions', () => {
  const request = qianchuanHourlyRequest('3001', room, new Date(sampledAt));
  assert.deepEqual(request.body.Dimensions, ['room_id', 'stat_time_hour']);
  assert.equal(request.body.Filters.Conditions.find(item => item.Field === 'room_id').Values[0], room.id);
  const item = (hour, id = room.id) => ({ Dimensions: { room_id: { Value: id }, stat_time_hour: { ValueStr: hour } },
    Metrics: { stat_cost: { Value: 1.25, ValueStr: '1.25' } } });
  const body = { status_code: 0, data: { StatsData: { Rows: [item('2026-11-15 08:00:00')] } } };
  const [live] = qianchuanHourlyRows(body, account, room, sampledAt);
  const [ended] = qianchuanHourlyRows(body, account, { ...room, state: 'ended' }, '2026-11-15T02:01:00Z');
  assert.equal(live.grain, '官方小时');
  assert.equal(live.value, 1.25);
  assert.equal(live.streamState, '在播读数');
  assert.equal(ended.streamState, '下播后重报');
  assert.notEqual(live.version, ended.version);
  assert.equal(qianchuanHourlyRows(body, account, { ...room, state: 'unknown' }, sampledAt)[0].streamState, '直播状态待确认');
  const failure = qianchuanHourlyFailure(account, room, sampledAt, '无权读取');
  assert.equal(failure.value, null);
  assert.equal(failure.valueKind, '未取得官方值');
  assert.equal(hourlyFields(failure)['缺失原因'], '无权读取');
  assert.throws(() => qianchuanHourlyRows({ ...body, data: { StatsData: { Rows: [item('2026-11-15 08:00:00', 'other')] } } }, account, room, sampledAt), /其他直播间/);
  assert.throws(() => qianchuanHourlyRows({ ...body, data: { StatsData: { Rows: [item('2026-11-15 08:00:00'), item('2026-11-15 08:00:00')] } } }, account, room, sampledAt), /重复/);
});

test('hourly store retains separate source and report versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-'));
  const store = new Store(root);
  try {
    store.save(account); store.saveRoom(account.id, room);
    const report = { status_code: 0, data: { StatsData: { Rows: [{
      Dimensions: { room_id: { Value: room.id }, stat_time_hour: { ValueStr: '2026-11-15 08:00:00' } },
      Metrics: { stat_cost: { Value: 1.25, ValueStr: '1.25' } },
    }] } } };
    const first = qianchuanHourlyRows(report, account, room, sampledAt);
    store.saveHourly(first);
    store.saveHourly(first);
    store.saveHourly(qianchuanHourlyRows(report, account, { ...room, state: 'ended' }, '2026-11-15T02:01:00Z'));
    assert.equal(store.hourly(account.id, room.id).length, 2);
    assert.notEqual(store.hourly(account.id, room.id)[0].key, store.hourly(account.id, room.id)[1].key);
  } finally { store.close(); fs.rmSync(root, { recursive: true }); }
});

test('startup snapshot backfill stays within the enabled target connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-scope-'));
  const store = new Store(root);
  try {
    store.save({ ...account, enabled: false }); store.setTargetName(account.name);
    store.saveRoom(account.id, room);
    store.db.prepare('INSERT INTO snapshots(account,room,time,json,raw) VALUES (?,?,?,?,?)')
      .run(account.id, room.id, sampledAt, JSON.stringify({ state: 'live', metrics: [] }), '{}');
    const collector = new Collector(store, { root });
    assert.equal(store.hourly(account.id, room.id).length, 0);
    await collector.feishu.close();
  } finally { store.close(); fs.rmSync(root, { recursive: true }); }
});

test('Feishu writes hourly rows into a separate table with stable keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-feishu-'));
  const store = new Store(root);
  store.save(account); store.saveRoom(account.id, room);
  store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [
    { key: 'online_user_cnt', value: 0, display: '0', unit: '人' },
  ] }, sampledAt));
  const calls = [], remote = new Map();
  const fields = id => (id === 'tblSession' ? FEISHU_FIELDS : HOURLY_FIELDS).map((field_name, i) => ({ field_name, type: 1, field_id: `fld${i}` }));
  const reply = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
  const fetcher = async (url, request) => {
    const parsed = new URL(url), body = request.body ? JSON.parse(request.body) : null;
    calls.push({ path: parsed.pathname, method: request.method, body });
    if (parsed.hostname === 'accounts.feishu.cn') return { ok: true, status: 200,
      json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (parsed.pathname.endsWith('/tables') && request.method === 'GET') return reply({ items: [], has_more: false });
    if (parsed.pathname.endsWith('/tables') && request.method === 'POST') return reply({ table_id: 'tblHour' });
    const tableId = parsed.pathname.match(/\/tables\/(tbl\w+)/)?.[1];
    if (parsed.pathname.endsWith('/fields')) return reply({ items: fields(tableId), has_more: false });
    if (parsed.pathname.endsWith('/records/search')) return reply({ items: [...remote.values()].filter(item =>
      item.fields['同步键'] === body.filter.conditions[0].value[0]), has_more: false });
    if (parsed.pathname.endsWith('/records') && request.method === 'POST') {
      const record = { record_id: `rec${remote.size + 1}`, fields: body.fields };
      remote.set(record.record_id, record); return reply({ record });
    }
    throw new Error('unexpected synthetic endpoint');
  };
  const sync = new FeishuSync(store, { clientFactory: config => new FeishuClient(config, fetcher) });
  try {
    sync.configure({ url: 'https://demo.feishu.cn/base/appDemo?table=tblSession',
      appId: 'cli_synthetic', appSecret: 'synthetic-secret', accountIds: [account.id] });
    sync.sync(); await sync.busy;
    assert.equal(sync.state().hourlyTableReady, true);
    assert.equal(sync.state().hourlySynced, 7);
    assert.equal(remote.size, 7);
    assert.ok([...remote.values()].every(item => !item.fields['场次稳定键'].includes(account.uid)));
    assert.ok(calls.some(item => item.path.endsWith('/tables') && item.method === 'POST'));
    assert.ok(calls.filter(item => item.path.endsWith('/records') && item.method === 'POST')
      .every(item => item.path.includes('/tblHour/')));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});

test('Feishu uses independent rows in the existing table when table creation lacks permission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-fallback-'));
  const store = new Store(root);
  store.save(account); store.saveRoom(account.id, room);
  const row = compassHourlyRows(account, room, { state: 'live', metrics: [] }, sampledAt)[0];
  store.saveHourly([row]);
  const calls = [], reply = (data, code = 0, status = 200) => ({ ok: status < 400, status,
    json: async () => ({ code, data }) });
  const fetcher = async (url, request) => {
    const parsed = new URL(url), body = request.body ? JSON.parse(request.body) : null;
    calls.push({ path: parsed.pathname, method: request.method, body });
    if (parsed.hostname === 'accounts.feishu.cn') return { ok: true, status: 200,
      json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (parsed.pathname.endsWith('/tables') && request.method === 'GET') return reply({ items: [], has_more: false });
    if (parsed.pathname.endsWith('/tables') && request.method === 'POST') return reply({}, 1254302, 403);
    if (parsed.pathname.endsWith('/fields')) return reply({ items: FEISHU_FIELDS.map((field_name, i) =>
      ({ field_name, field_id: `fld${i}`, type: 1 })), has_more: false });
    if (parsed.pathname.endsWith('/records/search')) return reply({ items: [], has_more: false });
    if (parsed.pathname.endsWith('/records') && request.method === 'POST') return reply({ record: { record_id: 'rec1' } });
    throw new Error('unexpected synthetic endpoint');
  };
  const sync = new FeishuSync(store, { clientFactory: config => new FeishuClient(config, fetcher) });
  try {
    sync.configure({ url: 'https://demo.feishu.cn/base/appDemo?table=tblSession',
      appId: 'cli_synthetic', appSecret: 'synthetic-secret', accountIds: [account.id] });
    sync.sync(); await sync.busy;
    assert.equal(sync.state().hourlyStorage, '原表独立小时行');
    assert.equal(sync.state().hourlySynced, 1);
    const write = calls.find(item => item.path.endsWith('/records') && item.method === 'POST');
    assert.ok(write.path.includes('/tblSession/'));
    assert.equal(write.body.fields['采集状态'], '小时明细：缺失');
    assert.deepEqual(JSON.parse(write.body.fields['指标原值']),
      hourlyFields({ ...row, key: write.body.fields['同步键'] }));
    assert.ok(!JSON.stringify(hourlyLegacyFields(row, account, room)).includes(account.uid));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});
