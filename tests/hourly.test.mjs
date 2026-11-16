import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../rpa/store.mjs';
import { Collector } from '../rpa/collector.mjs';
import { boundaryWindow, compassHourlyRows, qianchuanHourlyFailure, qianchuanHourlyRequest, qianchuanHourlyRows } from '../rpa/hourly.mjs';
import { FEISHU_FIELDS, FeishuClient, FeishuSync } from '../rpa/feishu.mjs';
import { REVIEW_FIELDS, REVIEW_METRICS, reviewRows } from '../rpa/hourly-review.mjs';

const account = { id: 'local-test', uid: '1001', name: '雪梨老师阅读100篇' };
const room = { id: '2001', startedAt: '2026-11-15 08:12:00', state: 'live' };
const sampledAt = '2026-11-15T01:01:00.000Z';

test('hour boundary stores Compass observations without claiming hourly increments', () => {
  assert.deepEqual(boundaryWindow(sampledAt), { hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00' });
  assert.equal(boundaryWindow('2026-11-15T01:06:00Z'), null);
  const snapshot = { state: 'live', metrics: [
    { key: 'online_user_cnt', value: 0, display: '0', unit: '人' },
    { key: 'watch_pay_ucnt_ratio', value: 0.03, display: '3%', unit: '%' },
    { key: 'gpm', value: 8, display: '8', unit: '元' },
    { key: 'avg_watch_duration', value: 20, display: '20', unit: '秒' },
  ], spendReconciliation: { compass: { amount: '2.00', display: '2.00' } } };
  const rows = compassHourlyRows(account, room, snapshot, sampledAt);
  assert.equal(rows.length, 15);
  assert.equal(rows[0].grain, '边界快照');
  assert.match(rows[0].statisticalWindow, /字段级小时映射未核实/);
  assert.equal(rows[0].value, 0);
  assert.equal(rows.find(row => row.metricKey === 'pay_amt').status, '缺失');
  assert.equal(rows.at(-1).grain, '独立对照');
  assert.match(rows.at(-1).statisticalWindow, /非小时消耗/);
  assert.ok(!rows[0].sessionKey.includes(account.uid));
  assert.equal(rows[0].display, '0');
  assert.equal(rows.find(row => row.metricKey === 'gpm').value, 8);
  assert.equal(rows.find(row => row.metricKey === 'avg_watch_duration').value, 20);
});

test('review schema uses the official five dimensions and four rates without guessing room totals', () => {
  assert.deepEqual(REVIEW_METRICS.slice(0, 9).map(([name]) => name), [
    '直播间曝光人数', '直播间进入人数', '商品曝光人数', '商品点击人数', '商品成交人数',
    '观看点击率', '商品曝光率', '商品点击率', '点击支付率',
  ]);
  assert.equal(new Set(REVIEW_FIELDS).size, REVIEW_FIELDS.length);
  assert.ok(REVIEW_FIELDS.length < 300);
  for (const type of ['直投', '短视频', '合计']) {
    for (const metric of ['消耗', '展现', '点击', 'CPM', '点击率', '转化数',
      '转化率', '转化成本', '转化目标', '成交金额', 'ROI']) {
      assert.ok(REVIEW_FIELDS.includes(`千川${type}·${metric}·性质`));
    }
  }
  const base = { account: account.id, room: room.id, sessionKey: 'session:synthetic',
    hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00',
    sampledAt, status: '已读取', version: 'live:fixed', source: '电商罗盘',
    grain: '边界快照', value: 12, display: '12', unit: '人' };
  const fields = reviewRows([
    { ...base, metricKey: 'product_show_ucnt' },
    { ...base, metricKey: 'product_click_ucnt' },
    { ...base, metricKey: 'pay_ucnt' },
  ], Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  for (const name of ['商品曝光人数', '商品点击人数', '商品成交人数'])
    assert.equal(fields[`${name}·性质`], '未采集');
  assert.equal(fields['商品点击人数（罗盘候选）·性质'], '边界快照');
  assert.equal(fields['支付人数·性质'], '边界快照');
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
  assert.equal(failure.reason, '无权读取');
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
  store.setTargetName(account.name);
  const other = { id: 'other-local', uid: '1002', name: '其他账号' };
  const otherRoom = { ...room, id: '2002' };
  store.save(other); store.saveRoom(other.id, otherRoom);
  store.saveHourly(compassHourlyRows(other, otherRoom, { state: 'live', metrics: [] }, sampledAt));
  store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [
    { key: 'online_user_cnt', value: 0, display: '0', unit: '人' },
  ] }, sampledAt));
  const calls = [], remote = new Map();
  const fields = id => (id === 'tblSession' ? FEISHU_FIELDS : REVIEW_FIELDS).map((field_name, i) => ({ field_name, type: 1, field_id: `fld${i}` }));
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
      appId: 'cli_synthetic', appSecret: 'synthetic-secret', accountIds: [account.id, other.id] });
    sync.sync(); await sync.busy;
    assert.equal(sync.state().hourlyTableReady, true);
    assert.equal(sync.state().hourlySynced, 1);
    assert.equal(remote.size, 1);
    assert.equal([...remote.values()][0].fields['投放消耗·性质'], '未采集');
    assert.equal([...remote.values()][0].fields['支付人数·性质'], '未采集');
    assert.ok([...remote.values()].every(item => !item.fields['场次稳定键'].includes(account.uid)));
    assert.ok(calls.some(item => item.path.endsWith('/tables') && item.method === 'POST'));
    assert.ok(calls.filter(item => item.path.endsWith('/records') && item.method === 'POST')
      .every(item => item.path.includes('/tblHour/')));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});

test('Feishu stops hourly writes when table creation lacks permission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-fallback-'));
  const store = new Store(root);
  store.save(account); store.saveRoom(account.id, room);
  store.setTargetName(account.name);
  const row = compassHourlyRows(account, room, { state: 'live', metrics: [] }, sampledAt)[0];
  store.saveHourly([row]);
  store.snapshot(account.id, room.id, { state: 'live', metrics: [] }, {});
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
    sync.syncReviewOnly(); await sync.busy;
    assert.equal(sync.state().hourlyStorage, '待创建');
    assert.equal(sync.state().hourlySynced, 0);
    assert.match(sync.state().error, /权限不足/);
    assert.ok(!calls.some(item => item.path.endsWith('/records') && item.method === 'POST'));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});

test('review rows keep separate hours, versions, provenance and previous-hour comparison', () => {
  const base = { account: account.id, room: room.id, sessionKey: 'session:synthetic', source: '巨量千川',
    metricKey: 'stat_cost', grain: '官方小时', status: '已读取', unit: '元', version: 'live:2026-11-15 10:00:00' };
  const rows = [
    { ...base, hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00', sampledAt: '2026-11-15T01:01:00Z', value: 2, display: '2' },
    { ...base, hourStart: '2026-11-15 09:00:00', hourEnd: '2026-11-15 10:00:00', sampledAt: '2026-11-15T02:01:00Z', value: 3, display: '3' },
    { ...base, hourStart: '2026-11-15 09:00:00', hourEnd: '2026-11-15 10:00:00', sampledAt: '2026-11-15T02:02:00Z', value: 99, display: '99' },
    { ...base, hourStart: '2026-11-15 09:00:00', hourEnd: '2026-11-15 10:00:00', sampledAt: '2026-11-15T02:03:00Z', value: 4, display: '4', version: 'post-live:2026-11-15 10:00:00' },
  ];
  const reviews = reviewRows(rows, Date.parse('2026-11-15T03:00:00Z'));
  assert.equal(reviews.length, 3);
  assert.notEqual(reviews[0].key, reviews[1].key);
  assert.notEqual(reviews[1].key, reviews[2].key);
  const live = reviews.find(row => row.hourStart.endsWith('09:00:00') && row.version === 'live');
  assert.equal(live.fields['投放消耗·本小时'], '3 元');
  assert.equal(live.fields['投放消耗·上一小时'], '2 元');
  assert.equal(live.fields['投放消耗·变化'], '1 元');
  assert.equal(live.fields['CPM·性质'], '未采集');
  assert.equal(reviews.find(row => row.version === 'post-live').fields['投放消耗·上一小时'], '');
});

test('review calculations require matching official-hour inputs and mark calculated values', () => {
  const base = { account: account.id, room: room.id, sessionKey: 'session:synthetic',
    hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00',
    sampledAt: '2026-11-15T01:01:00Z', status: '已读取', version: 'live:fixed' };
  const revenue = { ...base, source: '电商罗盘', metricKey: 'pay_amt',
    value: 20, display: '20', unit: '元', grain: '官方小时' };
  const viewers = { ...base, source: '电商罗盘', metricKey: 'watch_ucnt',
    value: 10, display: '10', unit: '人', grain: '官方小时' };
  const calculated = reviewRows([revenue, viewers], Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  assert.equal(calculated['GPM·本小时'], '2000.00 元');
  assert.equal(calculated['GPM·性质'], '本机计算值');
  assert.equal(calculated['CPM·性质'], '未采集');
  const boundary = reviewRows([{ ...revenue, grain: '边界快照' }, viewers], Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  assert.equal(boundary['GPM·性质'], '未采集');
  const otherSource = reviewRows([revenue, { ...viewers, source: '巨量千川' }],
    Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  assert.equal(otherSource['GPM·性质'], '未采集');
  const customers = { ...viewers, metricKey: 'pay_ucnt', value: 4, display: '4' };
  const unitPrice = reviewRows([revenue, customers], Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  assert.equal(unitPrice['客单价·本小时'], '5.00 元');
  assert.equal(unitPrice['客单价·性质'], '本机计算值');
});

test('official total spend never fills unverified direct, video or traffic-source columns', () => {
  const base = { account: account.id, room: room.id, sessionKey: 'session:synthetic',
    hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00',
    sampledAt, status: '已读取', version: 'live:fixed' };
  const fields = reviewRows([
    { ...base, source: '巨量千川', metricKey: 'stat_cost', value: 7, display: '7',
      unit: '元', grain: '官方小时' },
    { ...base, source: '电商罗盘', metricKey: 'gpm', value: 9, display: '9',
      unit: '元', grain: '边界快照' },
    { ...base, source: '电商罗盘', metricKey: 'avg_watch_duration', value: 20,
      display: '20', unit: '秒', grain: '边界快照' },
    { ...base, source: '电商罗盘', metricKey: 'product_click_pay_ucnt_ratio', value: 0.1,
      display: '10%', unit: '%', grain: '边界快照' },
    { ...base, source: '电商罗盘', metricKey: 'watch_pay_ucnt_ratio', value: 0.02,
      display: '2%', unit: '%', grain: '边界快照' },
  ], Date.parse('2026-11-15T02:00:00Z'))[0].fields;
  assert.equal(fields['千川合计·消耗·本小时'], '7 元');
  assert.equal(fields['千川合计·消耗·性质'], '官方小时值');
  for (const type of ['直投', '短视频']) {
    assert.equal(fields[`千川${type}·消耗·性质`], '未采集');
    assert.equal(fields[`千川${type}·转化率·性质`], '未采集');
    assert.equal(fields[`千川${type}·CPM·性质`], '未采集');
  }
  assert.equal(fields['流量千川·进房人数·性质'], '未采集');
  assert.equal(fields['GPM·性质'], '边界快照');
  assert.equal(fields['人均观看时长·性质'], '边界快照');
  assert.equal(fields['点击支付率·本小时'], '10%');
  assert.equal(fields['观看支付转化率·本小时'], '2%');
});

test('frozen remote review rows are found but never updated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-hourly-freeze-'));
  const store = new Store(root);
  store.save(account); store.setTargetName(account.name); store.saveRoom(account.id, room);
  store.saveHourly(compassHourlyRows(account, room, { state: 'live', metrics: [] }, sampledAt));
  const calls = [];
  const reply = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
  const fetcher = async (url, request) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: request.method });
    if (parsed.hostname === 'accounts.feishu.cn') return { ok: true, status: 200,
      json: async () => ({ code: 0, access_token: 'synthetic-token', expires_in: 7200 }) };
    if (parsed.pathname.endsWith('/tables')) return reply({ items: [{ name: '小时复盘', table_id: 'tblReview' }], has_more: false });
    if (parsed.pathname.endsWith('/fields')) return reply({ items: REVIEW_FIELDS.map((field_name, i) =>
      ({ field_name, field_id: `fld${i}`, type: 1 })), has_more: false });
    if (parsed.pathname.endsWith('/records/search')) return reply({ items: [{ record_id: 'recExisting' }], has_more: false });
    throw new Error('frozen row attempted a remote mutation');
  };
  const sync = new FeishuSync(store, { clientFactory: config => new FeishuClient(config, fetcher) });
  try {
    sync.configure({ url: 'https://demo.feishu.cn/base/appDemo?table=tblSession',
      appId: 'cli_synthetic', appSecret: 'synthetic-secret', accountIds: [account.id] });
    sync.syncReviewOnly(); await sync.busy;
    assert.equal(sync.state().hourlySynced, 1);
    assert.ok(!calls.some(call => call.method === 'PUT' ||
      call.path.endsWith('/records') && call.method === 'POST'));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});
