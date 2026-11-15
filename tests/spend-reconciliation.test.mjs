import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSpend } from '../rpa/spend-reconciliation.mjs';

const roomId = '123456789';
const sampledAt = '2026-11-13T10:00:00.000Z';
const sample = (amount, changes = {}) => ({ roomId, amount, unit: '元', sampledAt, ...changes });
const options = { now: Date.parse('2026-11-13T10:00:20.000Z') };

test('same room spend matches exactly and within the confirmed five-yuan tolerance', () => {
  const equal = reconcileSpend(roomId, sample('1.00'), sample('1'), options);
  assert.equal(equal.status, '匹配');
  assert.equal(equal.reason, undefined);
  const boundary = reconcileSpend(roomId, sample('10.01'), sample('5.01'), options);
  assert.equal(boundary.status, '匹配');
  assert.equal(boundary.reason, '差额在 5 元容差内（用户确认）');
  assert.equal(reconcileSpend(roomId, sample('10.01'), sample('5'), options).status, '不匹配');
  const negative = reconcileSpend(roomId, sample('5'), sample('10'), options);
  assert.equal(negative.status, '匹配');
  assert.equal(negative.reason, boundary.reason);
  assert.equal(reconcileSpend(roomId, sample('5'), sample('10.01'), options).status, '不匹配');
  assert.equal(reconcileSpend(roomId, sample('1'), null, options).status, '缺一边');
  assert.equal(reconcileSpend(roomId, null, null, options).status, '尚未采集');
});

test('tolerance is configurable and compares decimal strings without rounding', () => {
  const large = '9007199254740993.001';
  const other = '9007199254740998.001';
  assert.equal(reconcileSpend(roomId, sample(large), sample(other), options).status, '匹配');
  const strict = reconcileSpend(roomId, sample('1'), sample('1.01'),
    { ...options, toleranceYuan: '0' });
  assert.equal(strict.status, '不匹配');
  assert.throws(() => reconcileSpend(roomId, sample('1'), sample('1'),
    { ...options, toleranceYuan: '-1' }), /容差/);
});

test('room, unit and time boundaries prevent a false match', () => {
  assert.throws(() => reconcileSpend(roomId, sample('1'), sample('1', { roomId: '987654321' }), options));
  const unitMismatch = reconcileSpend(roomId, sample('1'), sample('1', { unit: '分' }), options);
  assert.equal(unitMismatch.status, '不匹配');
  assert.equal(unitMismatch.reason, '单位未对齐');
  const timeMismatch = reconcileSpend(roomId, sample('1'),
    sample('1', { sampledAt: '2026-11-13T10:03:00.000Z' }),
    { ...options, now: Date.parse('2026-11-13T10:03:10.000Z') });
  assert.equal(timeMismatch.status, '不匹配');
  assert.equal(timeMismatch.reason, '采样时间未对齐');
  assert.throws(() => reconcileSpend(roomId, sample('unknown'), sample('1'), options));
});

test('failed and stale samples never appear as a fresh match', () => {
  const failed = reconcileSpend(roomId, sample('1'), { roomId, ok: false }, options);
  assert.equal(failed.status, '缺一边');
  assert.equal(failed.qianchuan, null);
  assert.equal(failed.reasons.qianchuan, '采集失败');
  const invalidAccount = reconcileSpend(roomId, sample('1'),
    { ok: false, reason: '当前户不符' }, options);
  assert.equal(invalidAccount.status, '缺一边');
  assert.equal(invalidAccount.reasons.qianchuan, '当前户不符');

  const stale = reconcileSpend(roomId, sample('1'),
    sample('1', { sampledAt: '2026-11-13T09:49:00.000Z' }), options);
  assert.equal(stale.status, '缺一边');
  assert.equal(stale.qianchuan, null);
  assert.equal(stale.reasons.qianchuan, '采样已过期');

  const bothStale = reconcileSpend(roomId,
    sample('1', { sampledAt: '2026-11-13T09:49:00.000Z' }),
    sample('1', { sampledAt: '2026-11-13T09:49:00.000Z' }), options);
  assert.equal(bothStale.status, '尚未采集');
  assert.equal(bothStale.compass, null);
  assert.equal(bothStale.qianchuan, null);
});
