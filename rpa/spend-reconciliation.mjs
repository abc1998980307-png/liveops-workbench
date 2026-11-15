const ROOM_ID = /^\d{1,30}$/;
const AMOUNT = /^\d+(?:\.\d+)?$/;
export const SPEND_TOLERANCE_YUAN = '5';

function normalizedSample(roomId, sample, now, maxAgeMs) {
  if (sample == null) return { value: null, reason: '未采集' };
  if (sample.ok === false) return { value: null, reason: String(sample.reason || '采集失败').slice(0, 120) };
  if (sample.roomId !== roomId || !ROOM_ID.test(sample.roomId))
    throw new Error('消耗采样与直播间 ID 不一致');
  if (typeof sample.amount !== 'string' || !AMOUNT.test(sample.amount) ||
      typeof sample.unit !== 'string' || !sample.unit.trim() ||
      !Number.isFinite(Date.parse(sample.sampledAt)))
    throw new Error('消耗采样缺少已核验的数值、单位或时间');
  const age = now == null ? null : now - Date.parse(sample.sampledAt);
  if (age != null && (age > maxAgeMs || age < -120000))
    return { value: null, reason: '采样已过期' };
  return { value: { roomId, amount: sample.amount, display: sample.amount,
    unit: sample.unit.trim(), time: sample.sampledAt }, reason: null };
}

function decimalParts(amount) {
  const [integer, fraction = ''] = amount.split('.');
  return { digits: integer + fraction, places: fraction.length };
}

function amountDifference(left, right, tolerance) {
  const a = decimalParts(left), b = decimalParts(right), limit = decimalParts(tolerance);
  const places = Math.max(a.places, b.places, limit.places);
  const scaled = part => BigInt(part.digits) * 10n ** BigInt(places - part.places);
  const difference = scaled(a) - scaled(b);
  return { equal: difference === 0n,
    withinTolerance: (difference < 0n ? -difference : difference) <= scaled(limit) };
}

export function reconcileSpend(roomId, compassSample, qianchuanSample, options = {}) {
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) throw new Error('直播间 ID 无效');
  const { maxGapMs = 120000, maxAgeMs = 600000, now = null,
    toleranceYuan = SPEND_TOLERANCE_YUAN } =
    typeof options === 'number' ? { maxGapMs: options } : options;
  if (![maxGapMs, maxAgeMs].every(Number.isFinite) || (now != null && !Number.isFinite(now)) ||
      maxGapMs < 0 || maxAgeMs < 0)
    throw new Error('消耗采样时间窗口无效');
  if (typeof toleranceYuan !== 'string' || !AMOUNT.test(toleranceYuan))
    throw new Error('消耗对账容差须为非负的元金额字符串');
  const compassResult = normalizedSample(roomId, compassSample, now, maxAgeMs);
  const qianchuanResult = normalizedSample(roomId, qianchuanSample, now, maxAgeMs);
  const compass = compassResult.value, qianchuan = qianchuanResult.value;
  const reasons = { compass: compassResult.reason, qianchuan: qianchuanResult.reason };
  if (!compass || !qianchuan)
    return { compass, qianchuan, status: compass || qianchuan ? '缺一边' : '尚未采集', reasons };
  if (compass.unit !== qianchuan.unit)
    return { compass, qianchuan, status: '不匹配', reason: '单位未对齐' };
  if (Math.abs(Date.parse(compass.time) - Date.parse(qianchuan.time)) > maxGapMs)
    return { compass, qianchuan, status: '不匹配', reason: '采样时间未对齐' };
  const difference = amountDifference(compass.amount, qianchuan.amount, toleranceYuan);
  return { compass, qianchuan,
    status: difference.withinTolerance ? '匹配' : '不匹配', toleranceYuan,
    ...difference.withinTolerance && !difference.equal &&
      { reason: `差额在 ${toleranceYuan} 元容差内（用户确认）` } };
}
