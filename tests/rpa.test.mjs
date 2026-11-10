import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskUrl, validateResponse, measure, findMetric, roomList, normalizeSnapshot, CollectError } from '../rpa/model.mjs';
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
function setup(handler = task => structuredClone(responses[task])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-rpa-test-'));
  const store = new Store(root);
  const engine = { request: async (_id, task) => handler(task), open: async () => ({}), close: async () => {} };
  const collector = new Collector(store, engine);
  const a = store.create('测试'); store.save({ ...a, enabled: true });
  return { root, store, collector, id: a.id, cleanup: async () => { await collector.close(); fs.rmSync(root, { recursive: true }); } };
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
