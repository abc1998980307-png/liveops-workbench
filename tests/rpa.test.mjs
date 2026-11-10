import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskUrl, validateResponse, measure, findMetric, roomList, historyWindow, historyRoomPage, validateHistoryEndpoint, normalizeHistoryReport, normalizeSnapshot, CollectError } from '../rpa/model.mjs';
import { Store } from '../rpa/store.mjs';
import { Collector } from '../rpa/collector.mjs';

// Synthetic fixtures test supported response shapes, not captured production data.
const roomId = '7612345678901234567';
const responses = {
  identity: { data: { author_id: '99887766' } },
  account: { code: 0, data: { account_name: '测试账号' } },
  rooms: { code: 0, data: { card_list: [{ room_info: { room_id: roomId, room_title: '测试直播', room_status: 2 } }] } },
  base: { st: 0, data: { room_status: 2 } },
  core: { st: 0, data: { online_user_cnt: { value: 123, unit: '人' }, pay_amt: { value: 1200, value_str: '12.00', unit: '元' }, watch_pay_ucnt_ratio: 0.12 } },
  products: { st: 0, data: { product_list: [{ product_id: '9000', product_name: '测试商品', pay_amt: { value: 500, unit: '分' }, stock_cnt: 0 }] } },
};
const historyResponses = {
  historyBasic: { st: 0, data: { live_room_base_info: {
    title: '测试历史直播', is_living: false,
    start_time: { unit: 'time', value: 1787443200 }, end_time: { unit: 'time', value: 1787446800 },
  } } },
  historyCore: { st: 0, data: { flow_index_list: [
    { index_name: 'view_cnt', index_display: '观看次数', value: { unit: 'number', value: 0 } },
    { index_name: 'watch_ratio', index_display: '观看转化', value: { unit: 'ratio', value: 0.125 } },
    { index_name: 'watch_time', index_display: '观看时长', value: { unit: 'time', value: 3600 } },
    { index_name: 'missing', index_display: '暂缺指标', value: { unit: 'number' } },
  ], interaty_index_list: [], portrait_index_list: [], product_index_list: [], refund_index_list: [] } },
  historyTrade: { st: 0, data: { trade_list: [
    { index_name: 't7payin8d_predstl_ord_amt', index_display: '预计结算金额', value: { unit: 'price', value: 12345 } },
  ] } },
};
function setup(handler = task => structuredClone(responses[task])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-rpa-test-'));
  const store = new Store(root);
  const engine = { request: async (_id, task, options) => handler(task, options), open: async () => ({}), close: async () => {} };
  const collector = new Collector(store, engine);
  const a = store.create('测试'); store.save({ ...a, enabled: true });
  return { root, store, collector, id: a.id, cleanup: async () => { await collector.close(); fs.rmSync(root, { recursive: true }); } };
}
function savedHistoryRoom(t) {
  t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
  t.store.saveRoom(t.id, { id: roomId, title: '测试历史直播', state: 'ended', source: 'compass_history' });
}

test('request targets are fixed and room IDs cannot become URLs or parameters', () => {
  assert.equal(new URL(taskUrl('core', roomId)).hostname, 'compass.jinritemai.com');
  assert.throws(() => taskUrl('unknown'));
  assert.throws(() => taskUrl('base', '1&room_id=2'));
});
test('auth, throttling, malformed and business errors never become empty successful data', () => {
  for (const response of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 200, body: null }, { status: 200, body: { st: 7, msg: 'error' } }]) assert.throws(() => validateResponse(response), CollectError);
  assert.deepEqual(validateResponse({ status: 200, body: { st: 0, data: {} } }), { st: 0, data: {} });
});
test('preserve units, zero values and explicit display strings without money/ratio guessing', () => {
  assert.deepEqual(measure({ value: 1200, value_str: '12.00', unit: '元' }), { value: 1200, display: '12.00', unit: '元' });
  assert.equal(measure(0).value, 0);
  assert.equal(measure(null), null);
  assert.equal(measure(0.12).display, '0.12');
  assert.equal(findMetric({ compare: { online_user_cnt: 1000 }, current: { online_user_cnt: 9 } }, 'online_user_cnt').value, 9);
});
test('room IDs stay precise and unknown status is not treated as live', () => {
  assert.equal(roomList(responses.rooms)[0].id, roomId);
  assert.equal(roomList({ data: { card_list: [{ room_id: '1', status: 0 }] } })[0].state, 'unknown');
  assert.throws(() => roomList({ data: { card_list: [{ room_id: Number(roomId) }] } }));
  assert.throws(() => roomList({ data: { items: [] } }));
});
test('historical request and response have bounded pagination and exact string IDs', () => {
  const window = historyWindow(new Date('2026-11-10T10:00:00+08:00'));
  assert.deepEqual(window, { beginDate: 1786550400, beginDateFormat: '2026-08-13T00:00:00+08:00' });
  const url = new URL(taskUrl('history', { pageNo: 2, ...window }));
  assert.equal(url.pathname, '/compass_api/content_live/author/live_detail/history_live');
  assert.equal(url.searchParams.get('page_no'), '2');
  assert.equal(url.searchParams.get('page_size'), '10');
  assert.equal(url.searchParams.get('date_type'), '24');
  assert.throws(() => taskUrl('history', { pageNo: 51, ...window }));
  const body = { data: { data_result: [{ live_room: '测试历史直播', start_time: '2026-08-23 08:04:00', operation: { live_id: roomId } }], page_result: { page_no: 2, page_size: 10, total: 11 } } };
  assert.deepEqual(historyRoomPage(body, 2).rooms[0], { id: roomId, title: '测试历史直播', state: 'ended', startedAt: '2026-08-23 08:04:00', today: false, source: 'compass_history' });
  const observedShape = { ...body, data: { ...body.data, data_result: [{ ...body.data.data_result[0], start_time: { start_time: '2026-08-23 08:04:00', live_duration: '01:00:00' } }] } };
  assert.equal(historyRoomPage(observedShape, 2).rooms[0].startedAt, '2026-08-23 08:04:00');
  assert.throws(() => historyRoomPage({ data: { ...body.data, data_result: [{ operation: { live_id: Number(roomId) } }] } }, 2), CollectError);
  assert.throws(() => historyRoomPage(body, 1), CollectError);
  assert.throws(() => historyRoomPage({ data: { data_result: [] } }, 1), CollectError);
});
test('historical detail endpoints use exact live_room_id and reject changed schemas', () => {
  for (const task of ['historyBasic', 'historyCore', 'historyTrade']) {
    const url = new URL(taskUrl(task, roomId));
    assert.equal(url.hostname, 'compass.jinritemai.com');
    assert.equal(url.searchParams.get('live_room_id'), roomId);
    assert.equal(url.searchParams.has('room_id'), false);
    assert.equal(validateHistoryEndpoint(task, historyResponses[task]), historyResponses[task]);
    assert.throws(() => taskUrl(task, `${roomId}&x=1`));
    assert.throws(() => validateHistoryEndpoint(task, { data: {} }), CollectError);
  }
});
test('historical metrics keep source, raw units, zeros and missing values distinct', () => {
  const results = Object.fromEntries(Object.entries(historyResponses).map(([task, body]) => [task, { ok: true, body }]));
  const report = normalizeHistoryReport(results, roomId, '2026-11-10T00:00:00.000Z');
  assert.equal(report.source, 'compass_history_detail');
  assert.equal(report.roomState, 'ended');
  assert.equal(report.startedAt, new Date(1787443200 * 1000).toISOString());
  assert.equal(report.endedAt, new Date(1787446800 * 1000).toISOString());
  const byKey = Object.fromEntries(report.metrics.map(item => [item.key, item]));
  assert.deepEqual([byKey.t7payin8d_predstl_ord_amt.value, byKey.t7payin8d_predstl_ord_amt.display, byKey.t7payin8d_predstl_ord_amt.unit, byKey.t7payin8d_predstl_ord_amt.rawUnit], [12345, '123.45', '元', 'price']);
  assert.deepEqual([byKey.watch_ratio.value, byKey.watch_ratio.display, byKey.watch_ratio.unit], [0.125, '12.5', '%']);
  assert.deepEqual([byKey.watch_time.value, byKey.watch_time.display, byKey.watch_time.unit], [3600, '3,600', '秒']);
  assert.deepEqual([byKey.view_cnt.value, byKey.view_cnt.display], [0, '0']);
  assert.deepEqual([byKey.missing.value, byKey.missing.display], [null, '—']);
  assert.equal(byKey.t7payin8d_predstl_ord_amt.source, 'historyTrade');
  assert.equal(byKey.t7payin8d_predstl_ord_amt.category, '成交');
  assert.equal(byKey.pay_amt, undefined);
});
test('manual historical detail persists across restart without snapshots or Feishu work', async () => {
  const calls = [];
  const t = setup((task, options) => { calls.push({ task, options }); return structuredClone(task === 'identity' ? responses.identity : historyResponses[task]); });
  try {
    savedHistoryRoom(t);
    t.collector.feishu.config = { appToken: 'app_test', tableId: 'tbl_test', accountIds: [t.id], enabled: true };
    const result = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.equal(result.report.metrics.length, 5);
    assert.deepEqual(calls.map(item => item.task), ['identity', 'historyBasic', 'historyCore', 'historyTrade', 'identity']);
    assert.deepEqual(calls.filter(item => item.task.startsWith('history')).map(item => item.options), [roomId, roomId, roomId]);
    assert.equal(t.store.detail(t.id, roomId).latest, null);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
    assert.equal(t.collector.feishu.pending().length, 0);
    assert.equal(t.store.account(t.id).enabled, false);
    const reopened = new Store(t.root);
    assert.equal(reopened.detail(t.id, roomId).historyReport.metrics.length, 5);
    assert.equal(reopened.detail(t.id, roomId, true).historyRaw.historyTrade.ok, true);
    reopened.close();
  } finally { await t.cleanup(); }
});
test('historical detail refuses account changes and in-flight pause before saving', async () => {
  const t = setup();
  try {
    savedHistoryRoom(t);
    let identityReads = 0;
    t.collector.engine.request = async (_id, task) => task === 'identity'
      ? { data: { author_id: ++identityReads === 1 ? '99887766' : 'other' } }
      : structuredClone(historyResponses[task]);
    await assert.rejects(t.collector.command('history.report', { id: t.id, room: roomId }), /身份已变化/);
    assert.equal(t.store.historyReport(t.id, roomId), null);
    let resolveBasic;
    t.collector.engine.request = async (_id, task) => task === 'identity' ? structuredClone(responses.identity)
      : task === 'historyBasic' ? new Promise(resolve => { resolveBasic = resolve; }) : structuredClone(historyResponses[task]);
    const pending = t.collector.command('history.report', { id: t.id, room: roomId });
    while (!resolveBasic) await new Promise(resolve => setImmediate(resolve));
    t.collector.pause(t.id);
    resolveBasic(structuredClone(historyResponses.historyBasic));
    assert.deepEqual(await pending, { cancelled: true });
    assert.equal(t.store.historyReport(t.id, roomId), null);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
  } finally { await t.cleanup(); }
});
test('historical detail marks partial failures and retains the last complete report', async () => {
  const t = setup(task => {
    if (task === 'identity') return structuredClone(responses.identity);
    if (task === 'historyTrade') throw new CollectError('成交接口暂不可用');
    return structuredClone(historyResponses[task]);
  });
  try {
    savedHistoryRoom(t);
    const partial = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.equal(partial.report.endpoints.historyTrade.ok, false);
    assert.equal(partial.report.metrics.some(item => item.category === '成交'), false);
    t.collector.engine.request = async (_id, task) => structuredClone(task === 'identity' ? responses.identity : historyResponses[task]);
    const complete = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.equal(complete.report.endpoints.historyTrade.ok, true);
    t.collector.engine.request = async (_id, task) => {
      if (task === 'historyCore') throw new CollectError('流量接口暂不可用');
      return structuredClone(task === 'identity' ? responses.identity : historyResponses[task]);
    };
    const retained = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.match(retained.warning, /保留上次完整报表/);
    assert.deepEqual(t.store.historyReport(t.id, roomId), complete.report);
    t.collector.engine.request = async (_id, task) => {
      if (task !== 'identity') throw new CollectError('接口全部失败');
      return structuredClone(responses.identity);
    };
    await assert.rejects(t.collector.command('history.report', { id: t.id, room: roomId }), /三个历史详情接口均未成功/);
    assert.deepEqual(t.store.historyReport(t.id, roomId), complete.report);
  } finally { await t.cleanup(); }
});
test('manual history pages resume after restart without snapshots or Feishu writes', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `76123456789012345${String(i).padStart(2, '0')}`);
  const calls = [];
  const t = setup((task, options) => {
    calls.push({ task, options });
    if (task === 'identity') return structuredClone(responses.identity);
    if (task === 'history') return { data: { data_result: (options.pageNo === 1 ? ids : [ids[0]]).map(id => ({ live_room: `历史场次 ${id}`, operation: { live_id: id } })), page_result: { page_no: options.pageNo, page_size: 10, total: 11 } } };
    throw new Error('unexpected task');
  });
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    const first = await t.collector.command('history.page', { id: t.id, reset: true });
    assert.equal(first.nextPage, 2);
    assert.equal(first.imported, 10);
    const secondStore = new Store(t.root);
    assert.equal(secondStore.historyProgress(t.id).nextPage, 2);
    secondStore.close();
    const second = await t.collector.command('history.page', { id: t.id });
    assert.equal(second.complete, true);
    assert.equal(second.imported, 10);
    assert.equal(second.scanned, 11);
    assert.equal(t.store.roomsPage(t.id, 0, 100).total, 10);
    assert.equal(t.store.detail(t.id, ids[0]).latest, null);
    assert.equal(t.store.account(t.id).enabled, false);
    assert.deepEqual(calls.filter(c => c.task === 'history').map(c => c.options.pageNo), [1, 2]);
  } finally { await t.cleanup(); }
});
test('history import rejects switched identity and pause prevents in-flight writes', async () => {
  const t = setup();
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    t.collector.engine.request = async () => ({ data: { author_id: 'other' } });
    await assert.rejects(t.collector.command('history.page', { id: t.id, reset: true }), /身份已变化/);
    assert.equal(t.store.rooms(t.id).length, 0);
    assert.match(t.store.historyProgress(t.id).error, /身份已变化/);
    let resolveHistory;
    t.collector.engine.request = async (_id, task) => task === 'identity' ? structuredClone(responses.identity) : new Promise(resolve => { resolveHistory = resolve; });
    const pending = t.collector.command('history.page', { id: t.id });
    while (!resolveHistory) await new Promise(resolve => setImmediate(resolve));
    t.collector.pause(t.id);
    resolveHistory({ data: { data_result: [{ operation: { live_id: roomId } }], page_result: { page_no: 1, page_size: 10, total: 1 } } });
    await pending;
    assert.equal(t.store.rooms(t.id).length, 0);
    assert.equal(t.store.account(t.id).state, 'paused');
  } finally { await t.cleanup(); }
});
test('identity switched during a history request cannot write that page', async () => {
  const t = setup();
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    let reads = 0;
    t.collector.engine.request = async (_id, task) => {
      if (task === 'identity') return { data: { author_id: ++reads === 1 ? '99887766' : 'other' } };
      return { data: { data_result: [{ operation: { live_id: roomId } }], page_result: { page_no: 1, page_size: 10, total: 1 } } };
    };
    await assert.rejects(t.collector.command('history.page', { id: t.id, reset: true }), /身份已变化/);
    assert.equal(t.store.rooms(t.id).length, 0);
    assert.equal(t.store.historyProgress(t.id).nextPage, 1);
  } finally { await t.cleanup(); }
});
test('normalize mixed metric and product shapes; failed metrics remain missing', () => {
  const results = Object.fromEntries(['base','core','products'].map(k => [k, { ok: true, body: responses[k] }]));
  const data = normalizeSnapshot(results);
  assert.equal(data.metrics.find(m => m.key === 'online_user_cnt').display, '123');
  assert.equal(data.products[0].metrics.stock_cnt.value, 0);
  assert.equal(data.products[0].metrics.pay_amt.unit, '分');
  results.core = { ok: false, error: 'offline' };
  assert.equal(normalizeSnapshot(results).metrics.find(m => m.key === 'online_user_cnt').value, null);
});
test('successful sync persists data across restart; repeated syncs are serialized', async () => {
  const t = setup();
  try {
    t.collector.start(t.id);
    assert.equal(t.collector.start(t.id).busy, true);
    await t.collector.busy.get(t.id);
    assert.equal(t.store.account(t.id).state, 'ready');
    assert.equal(t.store.detail(t.id, roomId).history.length, 1);
    const second = new Store(t.root);
    assert.equal(second.detail(t.id, roomId).latest.products[0].id, '9000'); second.close();
  } finally { await t.cleanup(); }
});
test('partial failures are shown per endpoint without invented values', async () => {
  const t = setup(task => { if (task === 'core') throw new CollectError('接口异常'); return structuredClone(responses[task]); });
  try {
    await t.collector.sync(t.id);
    assert.equal(t.store.account(t.id).state, 'partial');
    assert.equal(t.store.detail(t.id, roomId).latest.metrics[0].display, '—');
    assert.equal(t.store.detail(t.id, roomId).latest.endpoints.core.ok, false);
  } finally { await t.cleanup(); }
});
test('expired login retains historical snapshots and reports login needed', async () => {
  let expired = false;
  const t = setup(task => { if (expired) throw new CollectError('请登录', 'needs_login'); return structuredClone(responses[task]); });
  try {
    await t.collector.sync(t.id); expired = true; await t.collector.sync(t.id);
    assert.equal(t.store.account(t.id).state, 'needs_login');
    assert.equal(t.store.detail(t.id, roomId).history.length, 1);
  } finally { await t.cleanup(); }
});
test('switching login identity cannot append another account’s data', async () => {
  const t = setup();
  try {
    await t.collector.sync(t.id);
    t.collector.engine.request = async () => ({ data: { author_id: 'other' } });
    await t.collector.sync(t.id);
    assert.equal(t.store.account(t.id).state, 'account_changed');
    assert.equal(t.store.detail(t.id, roomId).history.length, 1);
  } finally { await t.cleanup(); }
});
test('pause cancels pending writes and stops automatic scheduling', async () => {
  let resume;
  const t = setup(task => task === 'identity' ? new Promise(resolve => { resume = () => resolve(responses.identity); }) : structuredClone(responses[task]));
  try {
    const p = t.collector.sync(t.id); t.collector.pause(t.id); resume(); await p;
    assert.equal(t.store.account(t.id).state, 'paused');
    assert.equal(t.store.rooms(t.id).length, 0);
    t.collector.tick(); assert.equal(t.collector.busy.size, 0);
  } finally { await t.cleanup(); }
});

test('profile lookup command calls the isolated browser reader', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-profile-test-'));
  const store = new Store(root);
  const requested = [];
  const engine = {
    lookupProfile: async secUserId => { requested.push(secUserId); return { status_code: 0, user: { room_data: '' } }; },
    close: async () => {},
  };
  const collector = new Collector(store, engine);
  try {
    const result = await collector.command('profile.lookup', { secUserId: 'MS4wLjABAAAA1234567890' });
    assert.deepEqual(requested, ['MS4wLjABAAAA1234567890']);
    assert.deepEqual(result, { status_code: 0, user: { room_data: '' } });
  } finally { await collector.close(); fs.rmSync(root, { recursive: true }); }
});

test('saved rooms can be paged and inspected while collection stays paused', async () => {
  const t = setup();
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    for (let i = 0; i < 105; i++) t.store.saveRoom(t.id, { id: String(100000 + i), title: `历史场次 ${i}`, state: 'ended' });
    const first = await t.collector.command('rooms.list', { account: t.id, offset: 0, limit: 50 });
    const last = await t.collector.command('rooms.list', { account: t.id, offset: 100, limit: 50 });
    assert.equal(first.total, 105);
    assert.equal(first.rooms.length, 50);
    assert.equal(last.rooms.length, 5);
    assert.equal(last.hasMore, false);
    const historical = await t.collector.command('room.review', { account: t.id, room: '100000' });
    assert.equal(historical.room.title, '历史场次 0');
    assert.equal(historical.latest, null);
    assert.equal(historical.account.uid, '99887766');
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal(t.collector.busy.size, 0);
    await assert.rejects(t.collector.command('rooms.list', { account: t.id, offset: -1 }));
  } finally { await t.cleanup(); }
});
