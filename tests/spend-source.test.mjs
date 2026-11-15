import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserEngine } from '../rpa/engine.mjs';
import { compassSpendSample, qianchuanSpendRequest, qianchuanSpendSample } from '../rpa/spend-source.mjs';

const roomId = '11';
const accountId = '22';
const sampledAt = '2026-11-13T10:00:00Z';
const room = { id: roomId, startedAt: '2026/11/13 08:00' };
const compass = value => ({ data: { index_selected: ['stat_cost'], core_data: [
  { index_name: 'stat_cost', index_display: '千川消耗', value: { unit: 'price', value } },
] } });
const report = (id = roomId, cost = 12.34, display = '12.34') => ({ status_code: 0,
  data: { StatsData: { Rows: [{ Dimensions: { room_id: { Value: id } },
    Metrics: { stat_cost: { Value: cost, ValueStr: display } } }] } } });

test('Compass spend requires selected numeric price metric and converts cents', () => {
  assert.deepEqual(compassSpendSample(compass(1234), roomId, sampledAt),
    { roomId, amount: '12.34', unit: '元', sampledAt });
  assert.equal(compassSpendSample(compass(0), roomId, sampledAt).amount, '0.00');
  assert.equal(compassSpendSample(compass(1234.56789123), roomId, sampledAt).amount, '12.35');
  assert.throws(() => compassSpendSample({ ...compass(1234), data: {
    ...compass(1234).data, index_selected: [] } }, roomId, sampledAt), /未选取/);
  assert.throws(() => compassSpendSample(compass(null), roomId, sampledAt), /数值/);
  assert.throws(() => compassSpendSample(compass(Infinity), roomId, sampledAt), /数值/);
  assert.throws(() => compassSpendSample(compass(Number.MAX_SAFE_INTEGER + 1), roomId, sampledAt), /数值/);
  assert.throws(() => compassSpendSample({ data: { index_selected: ['stat_cost'], core_data: [
    { index_name: 'stat_cost', index_display: '千川消耗', value: { unit: '元', value: 1234 } },
  ] } }, roomId, sampledAt), /price/);
});

test('Qianchuan request is bound to saved account, room and official report dimensions', () => {
  const request = qianchuanSpendRequest(accountId, roomId, room.startedAt,
    new Date('2026-11-13T12:00:00Z'));
  assert.equal(new URL(request.url).origin, 'https://qianchuan.jinritemai.com');
  assert.equal(request.body.DataSetKey, 'site_promotion_post_overview_living');
  assert.deepEqual(request.body.Metrics, ['stat_cost']);
  assert.ok(request.body.Dimensions.includes('room_id'));
  assert.deepEqual(request.body.Filters.Conditions.filter(item =>
    ['advertiser_id', 'room_id'].includes(item.Field)).map(item => item.Values[0]), [accountId, roomId]);
  assert.equal(request.body.StartTime, '2026-11-13 00:00:00');
  assert.throws(() => qianchuanSpendRequest('', roomId, room.startedAt), /无效/);
});

test('Qianchuan spend requires one matching room row and numeric yuan display', () => {
  assert.deepEqual(qianchuanSpendSample(report(), roomId, sampledAt),
    { roomId, amount: '12.34', unit: '元', sampledAt });
  assert.throws(() => qianchuanSpendSample(report('33'), roomId, sampledAt), /唯一对应/);
  assert.throws(() => qianchuanSpendSample(report(roomId, 0, '-'), roomId, sampledAt), /元金额/);
  assert.throws(() => qianchuanSpendSample(report(roomId, 12.34, '13.34'), roomId, sampledAt), /元金额/);
  assert.throws(() => qianchuanSpendSample({ status_code: 1 }, roomId, sampledAt), /成功状态/);
});

test('Qianchuan engine stops when current account or login cannot be verified', async () => {
  const engine = new BrowserEngine('/unused', () => {});
  let currentUrl = `https://qianchuan.jinritemai.com/home?aavid=${accountId}`;
  let loggedIn = true, fetches = 0;
  const page = { isClosed: () => false, url: () => currentUrl,
    evaluate: async (_fn, request) => {
      if (!request) return loggedIn;
      fetches++;
      assert.equal(request.body.Filters.Conditions.find(item => item.Field === 'room_id').Values[0], roomId);
      return { status: 200, body: report() };
    } };
  engine.sessions.set('provider-qianchuan', { page, context: { pages: () => [page] } });
  assert.equal((await engine.qianchuanSpend(accountId, room)).amount, '12.34');
  currentUrl = 'https://qianchuan.jinritemai.com/home?aavid=33';
  await assert.rejects(() => engine.qianchuanSpend(accountId, room), /当前户/);
  assert.equal(fetches, 1);
  currentUrl = `https://qianchuan.jinritemai.com/home?aavid=${accountId}`;
  loggedIn = false;
  await assert.rejects(() => engine.qianchuanSpend(accountId, room), /登录态/);
  assert.equal(fetches, 1);
});
