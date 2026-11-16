import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { taskUrl, validateResponse, measure, findMetric, roomList, historyBounds, historyWindow, historyRange, historyStartDate, historyRoomPage, validateHistoryEndpoint, normalizeHistoryReport, normalizeSnapshot, CollectError } from '../rpa/model.mjs';
import { BrowserEngine, providerLoginUrl, qianchuanLoginState } from '../rpa/engine.mjs';
import { Store } from '../rpa/store.mjs';
import { Collector, acquireCollectorGuard } from '../rpa/collector.mjs';
import { reconcileSpend } from '../rpa/spend-reconciliation.mjs';

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

test('provider login target is fixed to the official Qianchuan portal', () => {
  assert.equal(providerLoginUrl('qianchuan'), 'https://qianchuan.jinritemai.com/');
  assert.throws(() => providerLoginUrl('https://attacker.example/'), CollectError);
  assert.throws(() => providerLoginUrl('compass'), CollectError);
});
test('Qianchuan login status requires observed official page signals', async () => {
  const business = { origin:'https://business.oceanengine.com',
    pathname:'/ebp/account-manage/ecp/bidding/universe/account', hasAccountControl:true, hasHomeContent:true };
  const home = { origin:'https://qianchuan.jinritemai.com', pathname:'/home',
    hasWorkspaceText:true, hasHomeContent:true };
  const login = { origin:'https://qianchuan.jinritemai.com', pathname:'/login', hasTextInput:true,
    hasLoginInput:true };
  const selection = { ...login, hasLoginInput:false, hasSelectAccount:true,
    hasLogoutControl:true, hasAccountSearch:true, hasAccountRows:true };
  assert.equal(qianchuanLoginState([business]), 'logged_in');
  assert.equal(qianchuanLoginState([home]), 'logged_in');
  assert.equal(qianchuanLoginState([{ ...home, pathname:'/dataV2/bidding/site-promotion' }]), 'logged_in');
  assert.equal(qianchuanLoginState([selection]), 'logged_in');
  assert.equal(qianchuanLoginState([{ ...selection, hasSelectAccount:false }]), 'logged_in');
  assert.equal(qianchuanLoginState([login]), 'needs_login');
  assert.equal(qianchuanLoginState([business, login]), 'logged_in');
  assert.equal(qianchuanLoginState([{ ...business, hasAccountControl:false }, login]), 'unknown');
  assert.equal(qianchuanLoginState([{ ...login, origin:'https://business.oceanengine.com' }]), 'needs_login');
  assert.equal(qianchuanLoginState([{ ...business, hasAccountControl:false }]), 'unknown');
  assert.equal(qianchuanLoginState([{ ...login, hasLoginInput:false }]), 'unknown');
  assert.equal(qianchuanLoginState([{ ...business, origin:'https://other.example' }]), 'unknown');

  const engine = new BrowserEngine('/unused', () => {});
  let current = 'https://business.oceanengine.com/ebp/account-manage/ecp/bidding/universe/account';
  let navigations = 0;
  const page = {
    isClosed: () => false, url: () => current,
    evaluate: async () => current.includes('/login') ?
      { hasTextInput:true, hasLoginInput:true, hasAccountControl:false, hasHomeContent:false } :
      { hasTextInput:false, hasAccountControl:true, hasHomeContent:true },
    goto: async url => { assert.equal(url, providerLoginUrl('qianchuan')); navigations++; current = 'https://qianchuan.jinritemai.com/login'; },
    waitForURL: async () => {},
    bringToFront: async () => {},
  };
  engine.sessions.set('provider-qianchuan', { page, context:{ pages: () => [page] } });
  assert.equal((await engine.qianchuanStatus()).state, 'logged_in');
  assert.ok((await engine.qianchuanStatus()).lastSuccessAt);
  assert.equal((await engine.checkQianchuanLogin()).state, 'logged_in');
  await engine.openProviderLogin('qianchuan');
  assert.equal(navigations, 0);
  current = 'https://business.oceanengine.com/login';
  assert.equal((await engine.checkQianchuanLogin()).state, 'needs_login');
  await engine.openProviderLogin('qianchuan');
  assert.equal(navigations, 0);
  current = 'https://business.oceanengine.com/ebp/account-manage/ecp/bidding/universe/account';
  page.evaluate = async () => ({});
  assert.equal((await engine.checkQianchuanLogin()).state, 'unknown');
  assert.equal(navigations, 0);
  page.evaluate = async () => ({ hasTextInput:true, hasLoginInput:true });
  current = 'about:blank';
  assert.equal((await engine.checkQianchuanLogin()).state, 'needs_login');
  assert.equal(navigations, 1);
  engine.sessions.clear();
  assert.equal((await engine.qianchuanStatus()).state, 'unknown');
  assert.ok((await engine.qianchuanStatus()).lastSuccessAt);
});
test('Qianchuan status check never navigates an uncertain official workspace', async () => {
  const engine = new BrowserEngine('/unused', () => {});
  const page = { isClosed: () => false,
    url: () => 'https://qianchuan.jinritemai.com/unknown-workspace',
    evaluate: async () => ({}),
    goto: async () => { throw new Error('an official workspace must not be navigated'); } };
  engine.sessions.set('provider-qianchuan', { page, context: { pages: () => [page] } });
  assert.equal((await engine.checkQianchuanLogin()).state, 'unknown');
});
test('Qianchuan login check honors a verified account tab beside an older login tab', async () => {
  const engine = new BrowserEngine('/unused', () => {});
  const login = { isClosed: () => false, url: () => 'https://qianchuan.jinritemai.com/login',
    evaluate: async fn => fn.toString().includes('const lines') ? false :
      { hasTextInput:true, hasLoginInput:true },
    goto: async () => { throw new Error('an existing login tab must not be reloaded'); },
    bringToFront: async () => { throw new Error('the verified account tab should be shown'); } };
  let front = false;
  const business = { isClosed: () => false,
    url: () => 'https://business.oceanengine.com/ebp/account-manage/ecp/bidding/universe/account',
    evaluate: async () => ({ hasAccountControl:true, hasHomeContent:true }),
    bringToFront: async () => { front = true; } };
  engine.sessions.set('provider-qianchuan', { page: login, context:{ pages: () => [login, business] } });
  assert.equal((await engine.checkQianchuanLogin()).state, 'logged_in');
  await engine.openProviderLogin('qianchuan');
  assert.equal(engine.sessions.get('provider-qianchuan').page, business);
  assert.equal(front, true);
});
function syntheticSelectionPage(ids, { enterWorkspace = true, initialUrl = 'https://qianchuan.jinritemai.com/login' } = {}) {
  let current = initialUrl;
  let bodyText = `选择账户\n退出登录\n${ids.map(id => `合成户\nID: ${id}`).join('\n')}`;
  let filled = '';
  let clicked = null;
  let navigations = 0;
  const input = { type:'text', placeholder:'请输入账户名称/ID', getClientRects: () => [1] };
  const rows = ids.map(id => ({ innerText:`ID: ${id}`, children:[], attributes:{},
    getClientRects: () => [1], setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }, id }));
  const document = {
    body: { get innerText() { return bodyText; } },
    querySelectorAll(selector) {
      if (selector === 'input' || selector.startsWith('input[')) return [input];
      if (selector === 'body *') return rows;
      if (selector === '[data-liveops-qianchuan-target]')
        return rows.filter(row => row.attributes['data-liveops-qianchuan-target']);
      return [];
    },
  };
  const page = {
    isClosed: () => false, url: () => current,
    evaluate: async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(arg)`, {
      document, arg, getComputedStyle: () => ({ visibility:'visible' }),
    }),
    waitForFunction: async (fn, arg) => {
      const found = vm.runInNewContext(`(${fn.toString()})(arg)`, { document, arg });
      if (!found) throw new Error('no matching account row');
    },
    locator: selector => ({
      fill: async value => { assert.equal(selector, 'input[placeholder="请输入账户名称/ID"]'); filled = value; },
      click: async () => {
        assert.equal(selector, '[data-liveops-qianchuan-target="true"]');
        const row = rows.find(item => item.attributes['data-liveops-qianchuan-target'] === 'true');
        clicked = row?.id || null;
        if (enterWorkspace) { current = 'https://qianchuan.jinritemai.com/dashboard'; bodyText = '工作台'; }
      },
      waitFor: async () => {},
    }),
    waitForURL: async predicate => { if (!predicate(new URL(current))) throw new Error('still selecting'); },
    goto: async url => {
      assert.equal(url, 'https://qianchuan.jinritemai.com/login');
      navigations++;
      current = 'https://qianchuan.jinritemai.com/login';
    },
    bringToFront: async () => {},
  };
  return { page, get filled() { return filled; }, get clicked() { return clicked; },
    get navigations() { return navigations; } };
}
test('Qianchuan selection is logged in and stays on the existing page', async () => {
  const fixture = syntheticSelectionPage(['0'.repeat(16)]);
  const engine = new BrowserEngine('/unused', () => {});
  engine.sessions.set('provider-qianchuan', { page:fixture.page, context:{ pages: () => [fixture.page] } });
  assert.equal((await engine.qianchuanStatus()).state, 'logged_in');
  assert.equal((await engine.checkQianchuanLogin()).state, 'logged_in');
  await engine.openProviderLogin('qianchuan');
  assert.equal(fixture.navigations, 0);
});
test('Qianchuan enters only the exact saved account and confirms the workspace', async () => {
  const accountId = '0'.repeat(16);
  const nearId = '0'.repeat(15) + '1';
  const fixture = syntheticSelectionPage([nearId, accountId]);
  const engine = new BrowserEngine('/unused', () => {});
  engine.sessions.set('provider-qianchuan', { page:fixture.page, context:{ pages: () => [fixture.page] } });
  assert.deepEqual(await engine.enterQianchuanAccount(accountId), {
    entered: true, origin: 'https://qianchuan.jinritemai.com', pathname: '/dashboard',
  });
  assert.equal(fixture.filled, accountId);
  assert.equal(fixture.clicked, accountId);
  assert.equal(fixture.navigations, 0);
});
test('Qianchuan navigates from a logged-in official page to account selection', async () => {
  const accountId = '0'.repeat(16);
  const fixture = syntheticSelectionPage([accountId], {
    initialUrl:'https://business.oceanengine.com/ebp/account-manage/ecp/bidding/universe/account',
  });
  const engine = new BrowserEngine('/unused', () => {});
  engine.sessions.set('provider-qianchuan', { page:fixture.page, context:{ pages: () => [fixture.page] } });
  engine.checkQianchuanLogin = async () => ({ state:'logged_in' });
  assert.equal((await engine.enterQianchuanAccount(accountId)).entered, true);
  assert.equal(fixture.navigations, 1);
  assert.equal(fixture.clicked, accountId);
});
test('Qianchuan page diagnostics redact numeric path segments', async () => {
  const accountId = '0'.repeat(16);
  const page = { isClosed:() => false,
    url:() => `https://qianchuan.jinritemai.com/account/${accountId}`,
    evaluate:async () => ({ hasWorkspaceText:true }),
  };
  const engine = new BrowserEngine('/unused', () => {});
  engine.sessions.set('provider-qianchuan', { page, context:{ pages:() => [page] } });
  const status = await engine.qianchuanStatus();
  assert.equal(status.pages[0].pathname, '/account/[已隐藏]');
  assert.equal(JSON.stringify(status).includes(accountId), false);
});
test('Qianchuan entry rejects missing ID, unmatched ID and an unconfirmed click', async () => {
  const accountId = '0'.repeat(16);
  const nearId = '0'.repeat(15) + '1';
  const fixture = syntheticSelectionPage([nearId]);
  const engine = new BrowserEngine('/unused', () => {});
  engine.sessions.set('provider-qianchuan', { page:fixture.page, context:{ pages: () => [fixture.page] } });
  await assert.rejects(engine.enterQianchuanAccount(''), /填写并保存户 ID/);
  assert.equal(fixture.filled, '');
  await assert.rejects(engine.enterQianchuanAccount(accountId), /未找到已保存的当前户 ID/);
  assert.equal(fixture.clicked, null);
  const unconfirmed = syntheticSelectionPage([accountId], { enterWorkspace:false });
  engine.sessions.set('provider-qianchuan', { page:unconfirmed.page, context:{ pages: () => [unconfirmed.page] } });
  await assert.rejects(engine.enterQianchuanAccount(accountId), /未确认进入工作台/);
  assert.equal(unconfirmed.clicked, accountId);
  engine.checkQianchuanLogin = async () => ({ state:'needs_login' });
  await assert.rejects(engine.enterQianchuanAccount(accountId), /需要登录/);
});
function setup(handler = task => structuredClone(responses[task])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-rpa-test-'));
  const store = new Store(root);
  const engine = { request: async (_id, task, options) => handler(task, options), open: async () => ({}), close: async () => {} };
  const collector = new Collector(store, engine);
  collector.historyRequestSpacingMs = 0;
  store.setTargetName(responses.account.data.account_name);
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
test('collector guard stays exclusive until its owning process releases it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-collector-guard-'));
  try {
    const first = acquireCollectorGuard(root);
    try { assert.throws(() => acquireCollectorGuard(root), /已有罗盘采集器/); }
    finally { first.close(); }
    acquireCollectorGuard(root).close();
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('collector process guard blocks another process until exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-collector-guard-process-'));
  const moduleUrl = new URL('../rpa/collector.mjs', import.meta.url).href;
  const holdScript = `import { acquireCollectorGuard } from ${JSON.stringify(moduleUrl)};
    const guard = acquireCollectorGuard(process.argv[1]);
    process.stdout.write('ready\\n');
    process.stdin.resume();
    process.stdin.on('end', () => guard.close());`;
  const probeScript = `import { acquireCollectorGuard } from ${JSON.stringify(moduleUrl)};
    acquireCollectorGuard(process.argv[1]).close();`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holdScript, root],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
      holder.once('exit', code => reject(new Error(`collector holder exited early (${code})`)));
    });
    const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', probeScript, root],
      { encoding: 'utf8', timeout: 10000 });
    const blocked = probe();
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /已有罗盘采集器/);
    holder.stdin.end();
    await new Promise((resolve, reject) => {
      holder.once('exit', code => code === 0 ? resolve() : reject(new Error(`collector holder exited (${code})`)));
      holder.once('error', reject);
    });
    const released = probe();
    assert.equal(released.status, 0, released.stderr);
  } finally {
    if (holder.exitCode === null) holder.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(measure({ value: 3, unit: 'nan' }).unit, '');
  assert.equal(findMetric({ compare: { online_user_cnt: 1000 }, current: { online_user_cnt: 9 } }, 'online_user_cnt').value, 9);
});
test('room IDs stay precise and unknown status is not treated as live', () => {
  assert.equal(roomList(responses.rooms)[0].id, roomId);
  assert.equal(roomList({ data: { card_list: [{ room_id: '1', status: 0 }] } })[0].state, 'unknown');
  const liveId = '9007199254740999001';
  assert.deepEqual(roomList({ data: { card_list: [{ live_id: liveId, live_title: '合成直播',
    start_time: '2026-11-12 10:00', operation: { live_id: liveId } }] } }),
  [{ id: liveId, title: '合成直播', state: 'unknown', startedAt: '2026-11-12 10:00' }]);
  assert.throws(() => roomList({ data: { card_list: [{ operation: { live_id: liveId } }] } }), /场次 ID 格式未识别/);
  assert.throws(() => roomList({ data: { card_list: [{ room_id: Number(roomId) }] } }));
  assert.throws(() => roomList({ data: { card_list: [{ live_id: Number(liveId), live_title: '合成直播' }] } }), /安全精度/);
  assert.throws(() => roomList({ data: { card_list: [{ live_id: 'bad',
    operation: { live_id: '0000000000000000001' } }] } }), error => {
    assert.match(error.shape.join('\n'), /live_id=string\(19,digits=true,unsafe=false\)/);
    return true;
  });
  assert.throws(() => roomList({ data: { items: [] } }));
});
test('historical request and response have bounded pagination and exact string IDs', () => {
  const window = historyWindow(new Date('2026-11-10T10:00:00+08:00'));
  assert.deepEqual(window, { beginDate: 1786550400, beginDateFormat: '2026-08-13T00:00:00+08:00' });
  assert.deepEqual(historyBounds(new Date('2026-11-10T10:00:00+08:00')), { earliest: '2026-08-13', latest: '2026-11-10' });
  assert.deepEqual(historyRange('2026-09-01', '2026-09-30', new Date('2026-11-10T10:00:00+08:00')),
    { startDate: '2026-09-01', endDate: '2026-09-30', ...window });
  for (const range of [['2026-08-12', '2026-09-01'], ['2026-11-11', '2026-11-11'],
    ['2026-09-30', '2026-09-01'], ['2026-09-31', '2026-10-01']])
    assert.throws(() => historyRange(...range, new Date('2026-11-10T10:00:00+08:00')));
  assert.equal(historyStartDate('2026-08-23 08:04:00'), '2026-08-23');
  assert.equal(historyStartDate('2026-08-22T17:00:00Z'), '2026-08-23');
  assert.equal(historyStartDate('1787443200'), '2026-08-23');
  assert.equal(historyStartDate('2026-02-30 08:04:00'), null);
  assert.equal(historyStartDate('unknown'), null);
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
  const measuredTime = { ...body, data: { ...body.data, data_result: [{ ...body.data.data_result[0], start_time: { unit: 'time', value: 1787443200 } }] } };
  assert.equal(historyRoomPage(measuredTime, 2).rooms[0].startedAt, new Date(1787443200 * 1000).toISOString());
  const actualTime = { ...body, data: { ...body.data, data_result: [{ ...body.data.data_result[0], start_time: { live_duration: '11小时58分24秒', start_time: '2026/10/29 11:04' } }] } };
  assert.equal(historyRoomPage(actualTime, 2).rooms[0].startedAt, '2026-10-29T11:04:00+08:00');
  assert.equal(historyStartDate(historyRoomPage(actualTime, 2).rooms[0].startedAt), '2026-10-29');
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
test('room workspace joins saved rooms with local reports and keeps missing metrics distinct', async () => {
  const t = setup();
  try {
    const endDate = historyBounds().latest;
    const startDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - 29 * 86400e3).toISOString().slice(0, 10);
    const historyId = '7612345678901234567';
    const liveId = '7612345678901234568';
    t.store.save({ ...t.store.account(t.id), uid: '99887766', name: '测试罗盘', state: 'ready' });
    t.store.saveRoom(t.id, { id: historyId, title: '结束场次', state: 'ended', startedAt: `${endDate}T10:00:00+08:00` });
    t.store.saveHistoryReport(t.id, historyId, { retrievedAt: new Date().toISOString(),
      endpoints: { historyBasic: { ok: true }, historyCore: { ok: true }, historyTrade: { ok: true } },
      metrics: [
        { key: 'watch_ucnt', value: 0, display: '0', rawUnit: 'number', unit: '', source: 'historyCore' },
        { key: 't7payin8d_predstl_ord_cnt', value: 7, display: '7', rawUnit: 'number', unit: '', source: 'historyTrade' },
        { key: 't7payin8d_predstl_ord_amt', value: 12345, display: '123.45', rawUnit: 'price', unit: '元', source: 'historyTrade' },
        { key: 'refund_cnt', category: '售后', value: 2, display: '2', rawUnit: 'number', unit: '', source: 'historyCore' },
        { key: 'real_refund_amt', category: '售后', value: 350, display: '3.50', rawUnit: 'price', unit: '元', source: 'historyCore' },
      ] }, {});
    t.store.saveRoom(t.id, { id: liveId, title: '直播场次', state: 'live', startedAt: `${endDate}T11:00:00+08:00` });
    t.store.snapshot(t.id, liveId, { ...normalizeSnapshot({
      base: { ok: true, body: { data: { room_status: 2 } } },
      core: { ok: true, body: { data: { online_user_cnt: 0, pay_combo_cnt: 2 } } },
      products: { ok: true, body: { data: {} } },
    }), spendReconciliation: reconcileSpend(liveId,
      { roomId: liveId, amount: '1', unit: '元', sampledAt: '2026-11-13T10:00:00Z' },
      { roomId: liveId, amount: '1.00', unit: '元', sampledAt: '2026-11-13T10:00:10Z' }) }, {});
    const data = await t.collector.command('room.workspace', { accounts: [t.id], startDate, endDate, limit: 20 });
    assert.equal(data.total, 2);
    assert.equal(data.accounts[0].recentSessions, 2);
    assert.equal(data.totals.entryVisits.value, 0);
    assert.equal(data.totals.entryVisits.coveredRooms, 1);
    assert.equal(data.totals.validOrders.value, 7);
    assert.equal(data.totals.validSales.display, '123.45');
    assert.equal(data.totals.refundCount.value, 2);
    assert.equal(data.totals.refundAmount.value, 3.5);
    assert.equal(data.totals.refundAmount.coveredRooms, 1);
    assert.equal(data.rows.find(row => row.room.id === historyId).metrics.refundCount.value, 2);
    assert.equal(data.rows.find(row => row.room.id === liveId).metrics.refundAmount, null);
    assert.equal(data.rooms.find(row => row.id === historyId).metrics.real_refund_amt.display, '3.50');
    assert.equal(data.rows.find(row => row.room.id === historyId).metrics.entryVisits.value, 0);
    assert.equal(data.rows.find(row => row.room.id === liveId).metrics.entryVisits, null);
    assert.equal(data.rows.find(row => row.room.id === liveId).metrics.onlineUsers.value, 0);
    assert.equal(data.rooms.find(row => row.id === liveId).spendReconciliation.status, '匹配');
    assert.equal(data.rooms.find(row => row.id === historyId).spendReconciliation, null);
    assert.equal(data.coverage.uniqueViewers.available, false);
    assert.equal(data.coverage.adSpend.available, true);
    assert.equal(data.coverage.adSpend.reconciled, 1);
    assert.equal(data.coverage.adSpend.qianchuanCovered, 1);
    const endedOnly = await t.collector.command('room.workspace', { accounts: [t.id], startDate, endDate, omitLive: true });
    assert.equal(endedOnly.total, 1);
    const sorted = await t.collector.command('room.workspace', { accounts: [t.id], startDate, endDate,
      sortBy: 'pay_combo_cnt', sortDirection: 'desc', limit: 20 });
    assert.equal(sorted.rows[0].room.id, historyId);
    await assert.rejects(t.collector.command('room.workspace', { accounts: [t.id], startDate, endDate, sortBy: 'unknown' }));
    await assert.rejects(t.collector.command('room.workspace', { accounts: ['missing'], startDate, endDate }));
  } finally { await t.cleanup(); }
});

test('official slash-formatted room times remain visible in date-filtered workspace', async () => {
  const t = setup();
  try {
    const day = historyBounds().latest;
    t.store.saveRoom(t.id, { id: roomId, title: '测试直播', state: 'unknown',
      startedAt: `${day.replaceAll('-', '/')} 08:00`, today: true });
    const data = await t.collector.command('room.workspace', {
      accounts: [t.id], startDate: day, endDate: day, limit: 20 });
    assert.equal(data.total, 1);
    assert.equal(data.rooms[0].id, roomId);
    assert.equal(data.accounts[0].recentSessions, 1);
  } finally { await t.cleanup(); }
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
    assert.match(retained.warning, /沿用上次成功结果/);
    assert.equal(retained.report.endpoints.historyCore.ok, true);
    assert.equal(retained.report.endpoints.historyCore.reused, true);
    assert.equal(retained.report.endpoints.historyCore.retrievedAt, complete.report.endpoints.historyCore.retrievedAt);
    assert.deepEqual(retained.report.metrics.map(item => item.key), complete.report.metrics.map(item => item.key));
    t.collector.engine.request = async (_id, task) => {
      if (task !== 'identity') throw new CollectError('接口全部失败');
      return structuredClone(responses.identity);
    };
    await assert.rejects(t.collector.command('history.report', { id: t.id, room: roomId }), /三个历史详情接口均未成功/);
    assert.deepEqual(t.store.historyReport(t.id, roomId), retained.report);
  } finally { await t.cleanup(); }
});
test('disjoint partial history reads accumulate successful endpoints with their source times', async () => {
  let attempt = 0;
  const t = setup(task => {
    if (task === 'identity') return structuredClone(responses.identity);
    if (task === 'historyBasic') { attempt++; return structuredClone(historyResponses[task]); }
    if ((attempt === 1 && task === 'historyTrade') || (attempt === 2 && task === 'historyCore'))
      throw new CollectError('接口临时不可用');
    return structuredClone(historyResponses[task]);
  });
  try {
    savedHistoryRoom(t);
    const first = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.equal(first.report.endpoints.historyTrade.ok, false);
    const second = await t.collector.command('history.report', { id: t.id, room: roomId });
    assert.equal(second.report.endpoints.historyTrade.ok, true);
    assert.equal(second.report.endpoints.historyCore.ok, true);
    assert.equal(second.report.endpoints.historyCore.reused, true);
    assert.equal(second.report.endpoints.historyCore.retrievedAt, first.report.endpoints.historyCore.retrievedAt);
    assert.equal(second.report.metrics.some(item => item.category === '成交'), true);
    assert.equal(second.report.metrics.some(item => item.category === '流量/转化'), true);
    const reopened = new Store(t.root);
    assert.equal(reopened.historyReport(t.id, roomId).endpoints.historyCore.reused, true);
    reopened.close();
  } finally { await t.cleanup(); }
});
test('manual history pages resume after restart without snapshots or Feishu writes', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `76123456789012345${String(i).padStart(2, '0')}`);
  const day = historyBounds().latest;
  const calls = [];
  const t = setup((task, options) => {
    calls.push({ task, options });
    if (task === 'identity') return structuredClone(responses.identity);
    if (task === 'history') return { data: { data_result: (options.pageNo === 1 ? ids : [ids[0]]).map(id => ({ live_room: `历史场次 ${id}`, start_time: `${day} 08:00:00`, operation: { live_id: id } })), page_result: { page_no: options.pageNo, page_size: 10, total: 11 } } };
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
test('history range only imports dated rooms and ties continuation to UID and range', async () => {
  const { earliest, latest } = historyBounds();
  const ids = ['7612345678901234561', '7612345678901234562', '7612345678901234563'];
  const t = setup((task, options) => {
    if (task === 'identity') return structuredClone(responses.identity);
    if (task === 'history') return { data: { data_result: [
      { operation: { live_id: ids[0] }, start_time: `${latest} 08:00:00` },
      { operation: { live_id: ids[1] }, start_time: `${earliest} 08:00:00` },
      { operation: { live_id: ids[2] } },
    ], page_result: { page_no: options.pageNo, page_size: 10, total: 3 } } };
    throw new Error('unexpected task');
  });
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    const first = await t.collector.command('history.page', { id: t.id, reset: true, startDate: latest, endDate: latest });
    assert.deepEqual([first.scanned, first.imported, first.outsideRange, first.unknownDates], [3, 1, 1, 1]);
    assert.deepEqual(t.store.rooms(t.id).map(room => room.id), [ids[0]]);
    assert.equal(first.uid, '99887766');
    assert.deepEqual(await t.collector.command('history.page', { id: t.id, startDate: latest, endDate: latest }), first);
    await assert.rejects(t.collector.command('history.page', { id: t.id, startDate: earliest, endDate: latest }), /重新读取/);
    const reopened = new Store(t.root);
    assert.equal(reopened.historyProgress(t.id).startDate, latest);
    reopened.close();
    t.store.save({ ...t.store.account(t.id), uid: 'different' });
    await assert.rejects(t.collector.command('history.page', { id: t.id }), /重新读取/);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
  } finally { await t.cleanup(); }
});
test('batch history backfill is bounded, durable and isolated from Feishu', async () => {
  const t = setup(task => structuredClone(task === 'identity' ? responses.identity : historyResponses[task]));
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    t.store.saveRoom(t.id, { id: '7612345678901234568', title: '直播中', state: 'live', startedAt: `${date} 09:00:00` });
    t.collector.feishu.config = { appToken: 'app_test', tableId: 'tbl_test', accountIds: [t.id], enabled: true };
    const started = t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    const first = await started;
    assert.equal(first.batch.selected, 1);
    assert.equal(first.batch.status, 'running');
    await t.collector.historyBusy.get(t.id);
    const batch = t.store.historyBatch(t.id);
    assert.deepEqual([batch.status, batch.nextIndex, batch.succeeded, batch.failed], ['completed', 1, 1, 0]);
    assert.equal(t.store.historyReport(t.id, roomId).metrics.length, 5);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
    assert.equal(t.collector.feishu.pending().length, 0);
    assert.equal(t.store.account(t.id).enabled, false);
    const repeated = await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    assert.deepEqual([repeated.batch.status, repeated.batch.skippedExisting, repeated.batch.roomIds.length], ['completed', 1, 0]);
  } finally { await t.cleanup(); }
});
test('batch pause cancels an in-flight report without moving its cursor, then resumes', async () => {
  let resolveBasic;
  const t = setup(task => task === 'historyBasic' ? new Promise(resolve => { resolveBasic = resolve; }) :
    structuredClone(task === 'identity' ? responses.identity : historyResponses[task]));
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    while (!resolveBasic) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date }), /正在执行其他读取任务/);
    const paused = await t.collector.command('history.batch.pause', { id: t.id });
    assert.equal(paused.batch.status, 'paused');
    resolveBasic(structuredClone(historyResponses.historyBasic));
    await t.collector.historyBusy.get(t.id);
    assert.equal(t.store.historyBatch(t.id).nextIndex, 0);
    assert.equal(t.store.historyReport(t.id, roomId), null);
    t.collector.engine.request = async (_id, task) => structuredClone(task === 'identity' ? responses.identity : historyResponses[task]);
    await t.collector.command('history.batch.resume', { id: t.id });
    await t.collector.historyBusy.get(t.id);
    assert.deepEqual([t.store.historyBatch(t.id).status, t.store.historyBatch(t.id).succeeded], ['completed', 1]);
  } finally { await t.cleanup(); }
});
test('batch stops on account switch without saving or advancing', async () => {
  let reads = 0;
  const t = setup(task => task === 'identity'
    ? { data: { author_id: ++reads === 1 ? '99887766' : 'other' } }
    : structuredClone(historyResponses[task]));
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    await t.collector.historyBusy.get(t.id);
    const batch = t.store.historyBatch(t.id);
    assert.deepEqual([batch.status, batch.nextIndex], ['error', 0]);
    assert.match(batch.error, /身份已变化/);
    assert.equal(t.store.historyReport(t.id, roomId), null);
  } finally { await t.cleanup(); }
});
test('batch rate limit keeps cursor and defers automatic sync', async () => {
  const t = setup(task => {
    if (task === 'historyCore') throw new CollectError('请求过快', 'rate_limited');
    return structuredClone(task === 'identity' ? responses.identity : historyResponses[task]);
  });
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    await t.collector.historyBusy.get(t.id);
    const batch = t.store.historyBatch(t.id);
    assert.equal(batch.status, 'rate_limited');
    assert.equal(batch.nextIndex, 0);
    assert.ok(Date.parse(batch.retryAfter) > Date.now());
    assert.ok(t.collector.next.get(t.id) > Date.now());
    await assert.rejects(t.collector.command('history.batch.resume', { id: t.id }), /请求受限/);
    await assert.rejects(t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date }), /请求受限/);
    await assert.rejects(t.collector.command('history.page', { id: t.id, reset: true }), /请求受限/);
    await assert.rejects(t.collector.command('history.report', { id: t.id, room: roomId }), /请求受限/);
    const manual = await t.collector.command('sync', { id: t.id });
    assert.equal(manual.queued, false);
    assert.equal(manual.retryAfter, batch.retryAfter);
    assert.equal(t.store.historyReport(t.id, roomId), null);
  } finally { await t.cleanup(); }
});
test('429 from ordinary reads persists one account cooldown across every request path and restart', async () => {
  for (const blockedTask of ['rooms', 'history', 'historyCore']) {
    const t = setup(task => {
      if (task === blockedTask) throw new CollectError('请求过快', 'rate_limited');
      return structuredClone(task === 'identity' ? responses.identity :
        Object.hasOwn(historyResponses, task) ? historyResponses[task] : responses[task]);
    });
    try {
      savedHistoryRoom(t);
      if (blockedTask === 'rooms') {
        assert.equal((await t.collector.command('sync', { id: t.id })).queued, true);
        await t.collector.busy.get(t.id);
      } else if (blockedTask === 'history') {
        await assert.rejects(t.collector.command('history.page', { id: t.id, reset: true }), /请求过快/);
      } else {
        await assert.rejects(t.collector.command('history.report', { id: t.id, room: roomId }), /请求过快/);
      }
      const until = t.store.account(t.id).retryAfter;
      assert.ok(Date.parse(until) > Date.now());
      assert.equal(t.store.historyBatch(t.id), null);
      const reopened = new Store(t.root);
      try {
        assert.equal(reopened.account(t.id).retryAfter, until);
        const resumed = new Collector(reopened, t.collector.engine);
        assert.equal((await resumed.command('sync', { id: t.id })).retryAfter, until);
        await assert.rejects(resumed.command('history.page', { id: t.id, reset: true }), /请求受限/);
        await assert.rejects(resumed.command('history.report', { id: t.id, room: roomId }), /请求受限/);
        const date = historyBounds().latest;
        assert.throws(() => resumed.startHistoryBatch(t.id, date, date), /请求受限/);
      } finally { reopened.close(); }
      t.store.save({ ...t.store.account(t.id), retryAfter: new Date(Date.now() - 1000).toISOString() });
      t.collector.tick();
      assert.equal(t.store.account(t.id).retryAfter, null);
      assert.equal(t.store.account(t.id).state, 'paused');
    } finally { await t.cleanup(); }
  }
});
test('batch counts partial reports separately and continues to the next room', async () => {
  const secondRoom = '7612345678901234568';
  const t = setup((task, room) => {
    if (task === 'historyTrade' && room === roomId) throw new CollectError('交易明细暂缺');
    return structuredClone(task === 'identity' ? responses.identity : historyResponses[task]);
  });
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    t.store.saveRoom(t.id, { id: secondRoom, title: '第二场', state: 'ended', startedAt: `${date} 10:00:00` });
    await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    await t.collector.historyBusy.get(t.id);
    const batch = t.store.historyBatch(t.id);
    assert.deepEqual([batch.status, batch.succeeded, batch.partial, batch.failed], ['completed', 1, 1, 0]);
    assert.equal(t.store.historyReport(t.id, roomId).endpoints.historyTrade.ok, false);
    assert.equal(t.store.historyReport(t.id, secondRoom).endpoints.historyTrade.ok, true);
  } finally { await t.cleanup(); }
});
test('batch resume skips a complete report saved before its cursor checkpoint', async () => {
  const calls = [];
  const t = setup(task => { calls.push(task); return structuredClone(task === 'identity' ? responses.identity : historyResponses[task]); });
  try {
    savedHistoryRoom(t);
    const date = historyBounds().latest;
    t.store.saveRoom(t.id, { ...t.store.room(t.id, roomId), startedAt: `${date} 08:00:00` });
    const originalSave = t.store.saveHistoryBatch.bind(t.store);
    let fail = true;
    t.store.saveHistoryBatch = (id, batch) => {
      if (batch.nextIndex === 1 && fail) { fail = false; throw new Error('checkpoint failed'); }
      return originalSave(id, batch);
    };
    await t.collector.command('history.batch.start', { id: t.id, startDate: date, endDate: date });
    await t.collector.historyBusy.get(t.id);
    assert.equal(t.store.historyBatch(t.id).nextIndex, 0);
    assert.equal(t.store.historyBatch(t.id).status, 'error');
    assert.equal(t.store.historyReport(t.id, roomId).endpoints.historyCore.ok, true);
    const detailsBefore = calls.filter(task => task.startsWith('history')).length;
    await t.collector.command('history.batch.resume', { id: t.id });
    await t.collector.historyBusy.get(t.id);
    assert.equal(calls.filter(task => task.startsWith('history')).length, detailsBefore);
    assert.deepEqual([t.store.historyBatch(t.id).status, t.store.historyBatch(t.id).skippedOnResume], ['completed', 1]);
    const second = new Store(t.root);
    assert.equal(second.historyBatch(t.id).status, 'completed');
    second.close();
  } finally { await t.cleanup(); }
});
test('opening the database does not pause a live batch; startup recovery does', async () => {
  const t = setup();
  try {
    const date = historyBounds().latest;
    t.store.saveHistoryBatch(t.id, { status: 'running', uid: '99887766', startDate: date,
      endDate: date, roomIds: [roomId], nextIndex: 0 });
    const reader = new Store(t.root);
    assert.equal(reader.historyBatch(t.id).status, 'running');
    reader.close();
    t.store.recoverHistoryBatches();
    assert.equal(t.store.historyBatch(t.id).status, 'paused');
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
test('verified identity survives an unrecognized room list without saving rooms', async () => {
  const syntheticId = '9007199254740999002';
  const t = setup(task => task === 'rooms'
    ? { data: { card_list: [{ live_title: '合成直播', live_id: 'invalid', operation: { live_id: syntheticId } }] } }
    : structuredClone(responses[task]));
  try {
    await t.collector.sync(t.id);
    const account = t.store.account(t.id);
    assert.equal(account.uid, responses.identity.data.author_id);
    assert.equal(account.name, responses.account.data.account_name);
    assert.equal(account.state, 'error');
    assert.match(account.error, /场次 ID 格式未识别/);
    assert.equal(t.store.rooms(t.id).length, 0);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 0);
    const evidence = t.store.events().map(event => event.message).filter(message => message.startsWith('今日场次形态：')).join('\n');
    assert.match(evidence, /card_list\[0\].operation: live_id=string\(19,digits=true,unsafe=true\)/);
    assert.match(evidence, /live_id=string\(7,digits=false,unsafe=false\)/);
    assert.doesNotMatch(evidence, /9007199254740999002|invalid/);
  } finally { await t.cleanup(); }
});
test('switching login identity cannot append another account’s data', async () => {
  const t = setup();
  try {
    await t.collector.sync(t.id);
    t.collector.engine.request = async (_id, task) => task === 'identity'
      ? { data: { author_id: 'other' } } : { data: { account_name: '另一个达人' } };
    await t.collector.sync(t.id);
    assert.equal(t.store.account(t.id).state, 'account_changed');
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal(t.store.account(t.id).name, '测试账号');
    assert.equal(t.store.account(t.id).observedName, '另一个达人');
    assert.equal(t.store.detail(t.id, roomId).history.length, 1);
  } finally { await t.cleanup(); }
});
test('opening the persistent login window pauses collection until a fresh verification', async () => {
  const t = setup();
  try {
    let opened = false;
    t.collector.engine.open = async (_id, visible) => { opened = visible; return {}; };
    await t.collector.command('login', { id: t.id });
    assert.equal(opened, true);
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal(t.store.account(t.id).verifiedAt, null);
    assert.equal(t.collector.busy.size, 0);
  } finally { await t.cleanup(); }
});
test('a live verification replaces a stale saved name and never trusts a similar label', async () => {
  const t = setup(task => task === 'account'
    ? { data: { account_name: '演示直播号甲分号' } } : structuredClone(responses[task]));
  try {
    t.store.setTargetName('演示直播号甲');
    t.store.save({ ...t.store.account(t.id), label: '演示直播号甲', name: '演示直播号甲' });
    const verified = await t.collector.command('verify', { id: t.id });
    assert.equal(verified.observedName, '演示直播号甲分号');
    assert.equal(verified.matchesTarget, false);
    assert.equal(t.store.account(t.id).name, '演示直播号甲分号');
    assert.equal(t.store.account(t.id).enabled, false);
    await assert.rejects(t.collector.command('monitor', { id: t.id, enabled: true }), /请先校正/);
    assert.equal(t.store.rooms(t.id).length, 0);
  } finally { await t.cleanup(); }
});
test('a missing current live name cannot leave automatic sync enabled', async () => {
  const t = setup();
  try {
    t.store.setTargetName('');
    t.collector.tick();
    assert.equal(t.store.account(t.id).enabled, false);
    await assert.rejects(t.collector.command('monitor', { id: t.id, enabled: true }), /当前直播号/);
    assert.equal(t.store.account(t.id).enabled, false);
  } finally { await t.cleanup(); }
});
test('automatic sync stops before room reads when the observed name changes', async () => {
  let name = '演示直播号甲';
  const calls = [];
  const t = setup(task => {
    calls.push(task);
    return task === 'account' ? { data: { account_name: name } } : structuredClone(responses[task]);
  });
  try {
    t.store.setTargetName(name);
    await t.collector.sync(t.id);
    const saved = t.store.detail(t.id, roomId).history.length;
    name = '演示直播号甲分号';
    calls.length = 0;
    await t.collector.sync(t.id);
    assert.deepEqual(calls, ['identity', 'account']);
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal(t.store.account(t.id).observedName, name);
    assert.equal(t.store.detail(t.id, roomId).history.length, saved);
  } finally { await t.cleanup(); }
});
test('confirming a freshly verified performer can set the current live name', async () => {
  const t = setup();
  try {
    t.store.setTargetName('旧直播号');
    await t.collector.command('verify', { id: t.id });
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal((await t.collector.command('target.confirm', { id: t.id })).targetName, '测试账号');
    await t.collector.command('monitor', { id: t.id, enabled: true });
    assert.equal(t.store.account(t.id).enabled, true);
    await t.collector.busy.get(t.id);
    assert.equal(t.store.account(t.id).state, 'ready');
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

test('confirmed review reader returns saved snapshot history beyond the detail preview window', async () => {
  const t = setup();
  try {
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    t.store.saveRoom(t.id, { id: roomId, title: '跨日场次', state: 'ended', startedAt: '2026-11-09T23:20:00+08:00' });
    for (let i = 0; i < 130; i++) t.store.snapshot(t.id, roomId, {
      metrics: [{ key: 'online_user_cnt', value: i, display: String(i), unit: '人' }],
    }, {});
    assert.equal(t.store.detail(t.id, roomId).history.length, 120);
    const review = await t.collector.command('room.review', { account: t.id, room: roomId });
    assert.equal(review.history.length, 130);
    assert.equal(review.history[0].metrics[0].value, 0);
    assert.equal(review.history[129].metrics[0].value, 129);
    assert.equal(review.account.state, 'paused');
    assert.equal(t.collector.busy.size, 0);
  } finally { await t.cleanup(); }
});

test('historical summary counts only matching, safe values and reports coverage', async () => {
  const t = setup();
  try {
    const { earliest, latest } = historyBounds();
    t.store.save({ ...t.store.account(t.id), uid: '99887766', enabled: false, state: 'paused' });
    for (const [id, date] of [['100001', latest], ['100002', latest], ['100003', earliest]]) {
      t.store.saveRoom(t.id, { id, state: 'ended', startedAt: `${date}T10:00:00+08:00` });
    }
    t.store.saveRoom(t.id, { id: '100004', state: 'live', startedAt: `${latest}T11:00:00+08:00` });
    const endpoints = { historyBasic: { ok: true }, historyCore: { ok: true }, historyTrade: { ok: true } };
    const metric = (key, value, rawUnit, source) => ({ key, value, rawUnit, source });
    t.store.saveHistoryReport(t.id, '100001', { endpoints, metrics: [
      metric('t7payin8d_predstl_ord_amt', 12345, 'price', 'historyTrade'),
      metric('t7payin8d_predstl_ord_cnt', 0, 'number', 'historyTrade'),
      metric('watch_ucnt', 10, 'number', 'historyCore'),
      { ...metric('refund_cnt', 1, 'number', 'historyCore'), category:'售后' },
      { ...metric('real_refund_amt', 250, 'price', 'historyCore'), category:'售后' },
    ] }, {});
    t.store.saveHistoryReport(t.id, '100002', { endpoints: { ...endpoints, historyTrade: { ok: false } }, metrics: [
      metric('t7payin8d_predstl_ord_amt', 99999, 'price', 'historyTrade'),
      metric('watch_ucnt', 5, 'number', 'historyCore'),
    ] }, {});
    t.store.saveHistoryReport(t.id, '100003', { endpoints, metrics: [
      metric('t7payin8d_predstl_ord_amt', 7, 'yuan', 'historyTrade'),
      metric('watch_ucnt', 2, 'number', 'historyCore'),
      metric('refund_cnt', 99, 'number', 'historyCore'),
    ] }, {});
    const result = await t.collector.command('history.summary', { account: t.id, startDate: earliest, endDate: latest });
    assert.equal(result.selectedRooms, 3);
    assert.equal(result.reportedRooms, 3);
    assert.equal(result.completeRooms, 2);
    assert.deepEqual(result.metrics.map(m => [m.display, m.coveredRooms, m.complete]), [
      ['123.45', 1, false], ['0', 1, false], ['17', 3, true], ['1', 1, false], ['2.50', 1, false],
    ]);
    assert.equal(t.store.account(t.id).enabled, false);
    assert.equal(t.collector.busy.size, 0);
    await assert.rejects(t.collector.command('history.summary', { account: t.id, startDate: '2020-01-01', endDate: latest }));
  } finally { await t.cleanup(); }
});
