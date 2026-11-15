const ROOM_ID = /^\d{1,30}$/;
const ACCOUNT_ID = /^\d{1,64}$/;
const YUAN = /^\d+(?:\.\d{1,2})?$/;

function datePart(startedAt) {
  const match = String(startedAt || '').match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!match) throw new Error('直播场次开播日期无法确认');
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)))
    throw new Error('直播场次开播日期无效');
  return date;
}

export function compassSpendSample(body, roomId, sampledAt) {
  if (!ROOM_ID.test(roomId) || !Number.isFinite(Date.parse(sampledAt)))
    throw new Error('罗盘消耗缺少场次或采样时间');
  const data = body?.data;
  if (!Array.isArray(data?.index_selected) || !data.index_selected.includes('stat_cost'))
    throw new Error('罗盘未选取 stat_cost 指标');
  const items = Array.isArray(data.core_data) ? data.core_data.filter(item => item?.index_name === 'stat_cost') : [];
  const rawPrice = items[0]?.value?.value;
  const roundedCents = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice >= 0 &&
    rawPrice <= Number.MAX_SAFE_INTEGER ? Math.round(rawPrice) : NaN;
  if (items.length !== 1 || items[0].index_display !== '千川消耗' ||
      items[0].value?.unit !== 'price' ||
      !Number.isSafeInteger(roundedCents))
    throw new Error('罗盘 stat_cost 缺少可核验的数值或 price 单位');
  const cents = BigInt(roundedCents);
  return { roomId, amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
    unit: '元', sampledAt };
}

export function qianchuanSpendRequest(accountId, roomId, startedAt, now = new Date()) {
  if (!ACCOUNT_ID.test(accountId) || !ROOM_ID.test(roomId))
    throw new Error('千川当前户或直播场次 ID 无效');
  const start = datePart(startedAt);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (start > today) throw new Error('直播场次日期晚于当前日期');
  const url = new URL('/ad/api/data/v1/common/statQuery', 'https://qianchuan.jinritemai.com');
  url.searchParams.set('reqFrom', 'promotion-unitable');
  url.searchParams.set('aavid', accountId);
  return { url: url.href, body: {
    DataSetKey: 'site_promotion_post_overview_living', Metrics: ['stat_cost'],
    Dimensions: ['room_id', 'room_name', 'room_start_time', 'room_end_time'],
    StartTime: `${start} 00:00:00`, EndTime: `${today} 23:59:59`,
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'advertiser_id', Values: [accountId], Operator: 7 },
      { Field: 'marketing_goal', Values: ['2'], Operator: 7 },
      { Field: 'room_id', Values: [roomId], Operator: 7 },
      { Field: 'fill_stat_time', Values: ['off'], Operator: 7 },
      { Field: 'adlab_mode_fork', Values: ['1'], Operator: 7 },
    ] }, PageParams: { Offset: 0, Limit: 10 }, aavid: accountId,
  } };
}

export function qianchuanSpendSample(body, roomId, sampledAt) {
  if (!ROOM_ID.test(roomId) || !Number.isFinite(Date.parse(sampledAt)))
    throw new Error('千川消耗缺少场次或采样时间');
  if (String(body?.status_code) !== '0') throw new Error('千川同场报表未返回成功状态');
  const rows = body?.data?.StatsData?.Rows;
  if (!Array.isArray(rows)) throw new Error('千川同场报表缺少 Rows');
  const matched = rows.filter(row =>
    String(row?.Dimensions?.room_id?.Value ?? row?.Dimensions?.room_id?.ValueStr ?? '') === roomId);
  if (matched.length !== 1 || rows.length !== 1)
    throw new Error('千川报表未唯一对应当前直播间');
  const metric = matched[0].Metrics?.stat_cost;
  const displayed = String(metric?.ValueStr ?? '').replaceAll(',', '');
  if (!Number.isFinite(metric?.Value) || metric.Value < 0 || !YUAN.test(displayed) ||
      Math.abs(metric.Value - Number(displayed)) > 0.005)
    throw new Error('千川 stat_cost 缺少可核验的元金额');
  return { roomId, amount: Number(displayed).toFixed(2), unit: '元', sampledAt };
}
