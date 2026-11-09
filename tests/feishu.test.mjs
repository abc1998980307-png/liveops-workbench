import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../rpa/store.mjs';
import { FEISHU_FIELDS, FeishuClient, FeishuSync, parseBitableUrl, snapshotFields } from '../rpa/feishu.mjs';

// All records and credentials below are synthetic; the mock rejects unknown URLs.
const config = { url: 'https://demo.feishu.cn/base/appTest?table=tblTest', appId: 'cli_test', appSecret: 'fixture-secret' };
const room = { id: '7612345678901234567', title: '测试直播' };
const account = { id: 'local-test-account', uid: '100000000000001', label: '测试账号', name: '测试账号' };
function snapshot(value = 0) {
  return { state: 'live', metrics: [
    { key: 'online_user_cnt', value, display: String(value), unit: '人' },
    { key: 'pay_amt', value: 1200, display: '12.00', unit: '元' },
    { key: 'pay_ucnt', value: null, display: '—', unit: '' },
  ], products: [{ id: '9999999999999999999', name: '测试商品', metrics: { stock_cnt: { value: 0, display: '0', unit: '' } } }],
  endpoints: { base: { ok: true }, core: { ok: true }, products: { ok: true } } };
}
function mockApi(options = {}) {
  const calls = [], records = new Map();
  const fields = options.fields || FEISHU_FIELDS.map((field_name, i) => ({ field_id: `fld${i}`, field_name, type: 1 }));
  let tokens = 0, lost = options.loseCreateResponse || false;
  const reply = (data, code = 0, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ code, data }) });
  const fetcher = async (url, request) => {
    const parsed = new URL(url), body = request.body && JSON.parse(request.body);
    calls.push({ url, method: request.method, body, token: request.headers.Authorization });
    assert.equal(request.redirect, 'error');
    if (url === 'https://accounts.feishu.cn/oauth/v3/token') {
      assert.deepEqual(body, { grant_type: 'client_credentials', client_id: config.appId, client_secret: config.appSecret });
      tokens++;
      return { ok: true, status: 200, json: async () => ({ code: 0, access_token: `token-${tokens}`, expires_in: 7200, token_type: 'Bearer' }) };
    }
    assert.equal(parsed.origin, 'https://open.feishu.cn');
    assert.match(parsed.pathname, /^\/open-apis\/bitable\/v1\/apps\/appTest\/tables\/tblTest\//);
    assert.match(request.headers.Authorization, /^Bearer token-\d+$/);
    if (options.expiredToken && request.headers.Authorization === 'Bearer token-1') return reply(null, 99991663);
    if (parsed.pathname.endsWith('/fields')) {
      if (request.method === 'POST') {
        assert.equal(body.type, 1);
        fields.push({ ...body, field_id: `fld${fields.length}` });
        return reply({ field: fields.at(-1) });
      }
      if (options.paginateFields && !parsed.searchParams.has('page_token')) return reply({ items: fields.slice(0, 2), has_more: true, page_token: 'second page' });
      if (options.paginateFields) assert.equal(parsed.searchParams.get('page_token'), 'second page');
      return reply({ items: options.paginateFields ? fields.slice(2) : fields, has_more: false });
    }
    if (parsed.pathname.endsWith('/records/search')) {
      const key = body.filter.conditions[0].value[0];
      assert.deepEqual(body.filter, { conjunction: 'and', conditions: [{ field_name: '同步键', operator: 'is', value: [key] }] });
      return reply({ items: options.searchItems || [...records.values()].filter(r => r.fields['同步键'] === key), has_more: false });
    }
    if (parsed.pathname.endsWith('/records') && request.method === 'POST') {
      assert.match(parsed.searchParams.get('client_token'), /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
      const record = { record_id: `rec${records.size + 1}`, fields: body.fields };
      records.set(record.record_id, record);
      if (lost) { lost = false; throw new Error('synthetic lost response after server commit'); }
      return reply({ record });
    }
    if (/\/records\/rec\d+$/.test(parsed.pathname) && request.method === 'PUT') {
      const record_id = parsed.pathname.split('/').at(-1);
      assert.ok(records.has(record_id));
      const record = { record_id, fields: { ...records.get(record_id).fields, ...body.fields } };
      records.set(record_id, record);
      return reply({ record });
    }
    throw new Error(`Unexpected mock endpoint ${request.method} ${url}`);
  };
  return { fetcher, calls, records, fields, tokenCount: () => tokens };
}
function fixture(api = mockApi()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-feishu-test-'));
  const store = new Store(root);
  store.save(account); store.saveRoom(account.id, room);
  const sync = new FeishuSync(store, { clientFactory: c => new FeishuClient(c, api.fetcher) });
  sync.configure(config);
  return { root, store, sync, api, cleanup: async () => { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); } };
}

test('Feishu links accept only HTTPS Feishu base tables and strip unrelated parameters', () => {
  assert.deepEqual(parseBitableUrl(config.url + '&view=vewTest#fragment'), { appToken: 'appTest', tableId: 'tblTest', url: config.url });
  for (const url of ['http://demo.feishu.cn/base/a?table=tblA', 'https://feishu.cn.evil.test/base/a?table=tblA', 'https://evilfeishu.cn/base/a?table=tblA', 'https://user:pass@demo.feishu.cn/base/a?table=tblA', 'https://demo.feishu.cn:444/base/a?table=tblA', 'https://demo.feishu.cn/wiki/a?table=tblA', 'https://demo.feishu.cn/base/a', 'https://demo.feishu.cn/base/a?table=tblA%2F..']) assert.throws(() => parseBitableUrl(url));
});

test('export preserves long IDs, zero, missing values and original units', () => {
  const fields = snapshotFields(account, room, { ...snapshot(), time: '2026-11-06T10:00:00.000Z' });
  assert.equal(fields['账号ID'], account.uid); assert.equal(fields['直播间ID'], room.id);
  assert.equal(fields['在线人数'], '0 人'); assert.equal(fields['支付人数'], '');
  assert.equal(fields['成交金额'], '12.00 元');
  assert.equal(JSON.parse(fields['指标原值']).find(m => m.key === 'pay_amt').value, 1200);
  assert.equal(JSON.parse(fields['商品明细'])[0].id, '9999999999999999999');
  const failed = snapshot(); failed.endpoints.products.ok = false;
  assert.equal(snapshotFields(account, room, failed)['商品数量'], '');
  const empty = snapshot(); empty.products = [];
  assert.equal(snapshotFields(account, room, empty)['商品数量'], '0');
});

test('configuration state is redacted, secrets retained only for unchanged application', async () => {
  const t = fixture();
  try {
    assert.equal(t.sync.state().hasSecret, true);
    assert.ok(!JSON.stringify(t.sync.state()).includes(config.appSecret));
    assert.ok(!JSON.stringify(t.sync.state()).includes('appSecret'));
    t.sync.configure({ url: config.url, appId: config.appId });
    assert.equal(t.sync.state().hasSecret, true);
    assert.throws(() => t.sync.configure({ url: config.url, appId: 'cli_other' }));
    assert.equal(t.api.calls.length, 0);
  } finally { await t.cleanup(); }
});

test('read-only connection check paginates fields and refreshes expired tenant token once', async () => {
  const t = fixture(mockApi({ expiredToken: true, paginateFields: true }));
  try {
    t.sync.test(); await t.sync.busy;
    assert.equal(t.sync.state().verified, true); assert.equal(t.sync.state().error, null);
    assert.equal(t.api.tokenCount(), 2);
    assert.ok(t.api.calls.filter(c => c.url.includes('/open-apis/')).every(c => c.method === 'GET'));
    assert.equal(t.api.records.size, 0);
  } finally { await t.cleanup(); }
});

test('connection check reports missing columns; first sync creates them before writing', async () => {
  const t = fixture(mockApi({ fields: [] }));
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.test(); await t.sync.busy;
    assert.deepEqual(t.sync.state().missingFields, FEISHU_FIELDS);
    assert.equal(t.api.fields.length, 0);
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.sync.state().error, null);
    assert.deepEqual(t.api.fields.map(f => f.field_name), FEISHU_FIELDS);
    assert.equal(t.api.records.size, 1); assert.equal(t.sync.state().pending, 0);
  } finally { await t.cleanup(); }
});

test('same-name column of incompatible type blocks all record mutations', async () => {
  const t = fixture(mockApi({ fields: [{ field_name: '同步键', type: 2 }] }));
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.sync(); await t.sync.busy;
    assert.match(t.sync.state().error, /文本类型/);
    assert.equal(t.sync.state().pending, 1);
    assert.equal(t.api.records.size, 0);
    assert.ok(!t.api.calls.some(c => c.url.includes('/records')));
  } finally { await t.cleanup(); }
});

test('lost create response survives restart; reconciliation updates one row and preserves newer pending snapshot', async () => {
  const t = fixture(mockApi({ loseCreateResponse: true }));
  let secondStore, second;
  try {
    t.store.snapshot(account.id, room.id, snapshot(1), {});
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.api.records.size, 1); assert.equal(t.sync.state().pending, 1);
    const attempt = t.store.db.prepare('SELECT token,fields FROM feishu_attempt').get();
    assert.equal(JSON.parse(attempt.fields)['在线人数'], '1 人');
    t.store.snapshot(account.id, room.id, snapshot(9), {});
    await t.sync.close();
    secondStore = new Store(t.root);
    second = new FeishuSync(secondStore, { clientFactory: c => new FeishuClient(c, t.api.fetcher) });
    assert.equal(secondStore.db.prepare('SELECT token FROM feishu_attempt').get().token, attempt.token);
    second.sync(); await second.busy;
    assert.equal(second.state().error, null);
    assert.equal(second.state().pending, 1);
    assert.equal([...t.api.records.values()][0].fields['在线人数'], '1 人');
    second.sync(); await second.busy;
    assert.equal(second.state().pending, 0);
    assert.equal([...t.api.records.values()][0].fields['在线人数'], '9 人');
    assert.equal(t.api.calls.filter(c => c.method === 'POST' && new URL(c.url).pathname.endsWith('/records')).length, 1);
    assert.equal(t.api.records.size, 1);
  } finally { if (second) await second.close(); secondStore?.close(); await t.cleanup(); }
});

test('duplicate business keys block writes instead of choosing or deleting user records', async () => {
  const t = fixture(mockApi({ searchItems: [{ record_id: 'rec1' }, { record_id: 'rec2' }] }));
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.sync(); await t.sync.busy;
    assert.match(t.sync.state().error, /重复/);
    assert.equal(t.sync.state().pending, 1);
    assert.ok(!t.api.calls.some(c => ['PUT','DELETE'].includes(c.method)));
    assert.ok(!t.api.calls.some(c => c.method === 'POST' && new URL(c.url).pathname.endsWith('/records')));
  } finally { await t.cleanup(); }
});

test('malformed matching record without ID must not create a duplicate', async () => {
  const t = fixture(mockApi({ searchItems: [{ fields: { 同步键: `compass:${account.uid}:${room.id}` } }] }));
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.sync(); await t.sync.busy;
    assert.ok(t.sync.state().error);
    assert.equal(t.api.records.size, 0);
    assert.equal(t.sync.state().pending, 1);
  } finally { await t.cleanup(); }
});

test('immediate pause after scheduling stops remote mutations', async () => {
  const t = fixture();
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.monitor(true); t.sync.monitor(false); await t.sync.busy;
    assert.equal(t.sync.state().enabled, false);
    assert.equal(t.api.records.size, 0);
    assert.equal(t.sync.state().pending, 1);
  } finally { await t.cleanup(); }
});

test('rate limits retain pending rows and respect retry deadline while remote messages stay redacted', async () => {
  const api = mockApi();
  let fail = true, time = 1_800_000_000_000;
  const original = api.fetcher;
  api.fetcher = async (url, request) => {
    if (url.includes('/fields') && fail) {
      api.calls.push({ url, method: request.method });
      return { ok: false, status: 429, json: async () => ({ code: 99991400, msg: `echo ${config.appSecret} token-1` }) };
    }
    return original(url, request);
  };
  const t = fixture(api);
  t.sync.now = () => time;
  try {
    t.store.snapshot(account.id, room.id, snapshot(), {});
    t.sync.monitor(true); await t.sync.busy;
    const state = t.sync.state();
    assert.equal(state.pending, 1); assert.ok(state.nextRetry);
    assert.ok(!state.error.includes(config.appSecret)); assert.ok(!state.error.includes('token-1'));
    const count = api.calls.length;
    t.sync.tick(); assert.equal(api.calls.length, count); assert.equal(t.sync.busy, null);
    time = Date.parse(state.nextRetry); fail = false;
    t.sync.tick(); await t.sync.busy;
    assert.equal(t.sync.state().error, null); assert.equal(t.sync.state().pending, 0);
    assert.equal(api.records.size, 1);
  } finally { await t.cleanup(); }
});

test('a failed create retries the same persisted UUID and payload even after a newer sample arrives', async () => {
  const api = mockApi();
  const original = api.fetcher;
  const attempts = [];
  api.fetcher = async (url, request) => {
    if (request.method === 'POST' && new URL(url).pathname.endsWith('/records')) {
      attempts.push({ token: new URL(url).searchParams.get('client_token'), body: request.body });
      if (attempts.length === 1) throw new Error('synthetic network failure before commit');
    }
    return original(url, request);
  };
  const t = fixture(api);
  try {
    t.store.snapshot(account.id, room.id, snapshot(1), {});
    t.sync.sync(); await t.sync.busy;
    assert.equal(api.records.size, 0); assert.equal(t.sync.state().pending, 1);
    t.store.snapshot(account.id, room.id, snapshot(3), {});
    t.sync.sync(); await t.sync.busy;
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(api.records.size, 1);
    assert.equal([...api.records.values()][0].fields['在线人数'], '1 人');
    assert.equal(t.sync.state().pending, 1);
  } finally { await t.cleanup(); }
});

test('saved account scope excludes later accounts and rejects invalid selections', async () => {
  const t = fixture();
  try {
    const other = { ...account, id: 'other-account', uid: '8123456789012345678' };
    t.store.save(other); t.store.saveRoom(other.id, room);
    t.store.snapshot(account.id, room.id, snapshot(1), {});
    t.store.snapshot(other.id, room.id, snapshot(9), {});
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.sync.state().error, null); assert.equal(t.api.records.size, 1);
    assert.equal([...t.api.records.values()][0].fields['账号ID'], account.uid);
    assert.throws(() => t.sync.configure({ ...config, accountIds: [] }));
    assert.throws(() => t.sync.configure({ ...config, accountIds: ['does-not-exist'] }));
    t.sync.configure({ ...config, accountIds: [other.id] });
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.api.records.size, 2);
    assert.ok([...t.api.records.values()].some(record => record.fields['账号ID'] === other.uid));
  } finally { await t.cleanup(); }
});


test('persisted incomplete write is recovered even after source snapshot retention expires', async () => {
  const t = fixture(mockApi({ loseCreateResponse: true }));
  try {
    t.store.snapshot(account.id, room.id, snapshot(7), {});
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.api.records.size, 1);
    t.store.db.exec('DELETE FROM snapshots');
    assert.equal(t.sync.state().pending, 1);
    t.sync.sync(); await t.sync.busy;
    assert.equal(t.sync.state().error, null);
    assert.equal(t.sync.state().pending, 0);
    assert.equal(t.api.records.size, 1);
  } finally { await t.cleanup(); }
});


test('a table can be bound before credentials without granting write access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-feishu-destination-'));
  const store = new Store(root); store.save(account);
  const api = mockApi();
  const sync = new FeishuSync(store, { clientFactory: c => new FeishuClient(c, api.fetcher) });
  try {
    const state = sync.saveDestination({ url: config.url });
    assert.equal(state.url, config.url);
    assert.equal(state.configured, false); assert.equal(state.enabled, false);
    assert.throws(() => sync.sync(), /凭据/);
    sync.tick(); assert.equal(api.calls.length, 0);
    const second = new FeishuSync(store);
    assert.equal(second.state().url, config.url);
    assert.deepEqual(second.state().accountIds, [account.id]);
    assert.throws(() => second.saveDestination({ url: config.url, accountIds: ['unknown'] }));
  } finally { await sync.close(); store.close(); fs.rmSync(root, { recursive: true }); }
});
