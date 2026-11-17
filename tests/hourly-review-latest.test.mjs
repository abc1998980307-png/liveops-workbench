import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRows } from '../rpa/hourly-review.mjs';

const base = {
  account: 'local-synthetic', room: 'room-synthetic', sessionKey: 'session:synthetic',
  hourStart: '2026-11-15 08:00:00', hourEnd: '2026-11-15 09:00:00',
  sampledAt: '2026-11-15T00:10:00Z', version: 'live:synthetic',
  status: '已读取', grain: '官方小时',
};
const now = Date.parse('2026-11-15T00:30:00Z');
const fields = rows => reviewRows(rows, now)[0].fields;

test('latest missing sample clears an earlier value from the same source and window', () => {
  const earlier = { ...base, source: '巨量千川', metricKey: 'stat_cost',
    value: 12, display: '12', unit: '元' };
  const later = { ...earlier, sampledAt: '2026-11-15T00:20:00Z',
    value: null, display: '', status: '缺失' };
  const result = fields([earlier, later]);
  assert.equal(result['投放消耗·本小时'], '');
  assert.equal(result['投放消耗·性质'], '未采集');
  assert.equal(result['千川合计·消耗·本小时'], '');
});

test('review fields accept only their verified platform source', () => {
  const costFromCompass = { ...base, source: '电商罗盘', metricKey: 'stat_cost',
    value: 3, display: '3', unit: '元' };
  const revenueFromQianchuan = { ...base, source: '巨量千川', metricKey: 'pay_amt',
    value: 6, display: '6', unit: '元' };
  const result = fields([costFromCompass, revenueFromQianchuan]);
  assert.equal(result['投放消耗·本小时'], '');
  assert.equal(result['罗盘消耗对照·本小时'], '3 元');
  assert.equal(result['成交金额·本小时'], '');
});

test('CPM needs matching official numerator and denominator, not a reported CPM alone', () => {
  const cost = { ...base, source: '巨量千川', metricKey: 'stat_cost',
    value: 6, display: '6', unit: '元' };
  const exposure = { ...base, source: '巨量千川', metricKey: 'live_show_cnt',
    value: 3000, display: '3000', unit: '次' };
  const reported = { ...base, source: '电商罗盘', metricKey: 'cpm',
    value: 2, display: '2', unit: '元' };
  assert.equal(fields([reported])['CPM·性质'], '未采集');
  assert.equal(fields([cost, exposure])['CPM·本小时'], '2.00 元');
  assert.equal(fields([cost, { ...exposure, value: 0, display: '0' }])['CPM·性质'], '未采集');
  assert.equal(fields([cost, { ...exposure, source: '电商罗盘' }])['CPM·性质'], '未采集');
  assert.equal(fields([cost, { ...exposure, account: 'other-synthetic' }])['CPM·性质'], '未采集');
  assert.equal(fields([cost, { ...exposure, hourEnd: '2026-11-15 10:00:00' }])['CPM·性质'], '未采集');
});

test('standalone source ratios and GPM stay empty without verified hourly inputs', () => {
  const reported = id => ({ ...base, source: '电商罗盘', metricKey: id,
    value: 2, display: '2', unit: id === 'gpm' ? '元' : '%' });
  const result = fields([reported('gpm'), reported('watch_pay_ucnt_ratio'),
    reported('product_click_pay_ucnt_ratio')]);
  for (const name of ['GPM', '观看支付转化率', '点击支付率']) {
    assert.equal(result[`${name}·本小时`], '');
    assert.equal(result[`${name}·性质`], '未采集');
  }
});
