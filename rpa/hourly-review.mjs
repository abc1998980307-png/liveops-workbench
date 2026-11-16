// A null source means the official room-level field or reporting dimension is unverified.
const CORE_METRICS = [
  ['直播间曝光人数', null], ['直播间进入人数', 'watch_ucnt'],
  ['商品曝光人数', null], ['商品点击人数', null], ['商品成交人数', null],
  ['观看点击率', null], ['商品曝光率', null], ['商品点击率', null],
  ['点击支付率', 'product_click_pay_ucnt_ratio'], ['CPM', 'cpm'],
  ['GPM', 'gpm'], ['观看支付转化率', 'watch_pay_ucnt_ratio'],
];
const ROOM_METRICS = [
  ['支付人数', 'pay_ucnt', true], ['成交金额', 'pay_amt', true], ['成交订单', 'pay_combo_cnt'],
  ['客单价', 'customer_unit_price'], ['平均在线人数', null], ['最高在线人数', null],
  ['在线人数快照', 'online_user_cnt'], ['人均观看时长', 'avg_watch_duration'],
  ['新增关注', 'follow_anchor_ucnt'], ['转粉率', null],
  ['评论人数', null], ['评论率', null], ['点赞人数', null], ['点赞率', null],
  ['加团人数', null], ['加团率', null],
  ['进房率（罗盘原字段）', 'live_show_watch_cnt_ratio'],
  ['互动率（罗盘原字段）', 'watch_interact_ucnt_ratio'],
  ['商品点击人数（罗盘候选）', 'product_click_ucnt'],
  ['投放消耗', 'stat_cost', true], ['罗盘消耗对照', 'compass_stat_cost'],
];
const PROMOTION_TYPES = ['直投', '短视频', '合计'];
const PROMOTION_METRICS = ['消耗', '展现', '点击', 'CPM', '点击率',
  '转化数', '转化率', '转化成本', '转化目标', '成交金额', 'ROI'];
const TRAFFIC_SOURCES = ['千川', '随心推', '自然短视频', '直播推荐', '关注', '搜索', '主页'];

export const REVIEW_METRICS = [
  ...CORE_METRICS.map(([name, id]) => [name, id, true]),
  ...ROOM_METRICS.map(([name, id, compare]) => [name, id, Boolean(compare)]),
  ...PROMOTION_TYPES.flatMap(type => PROMOTION_METRICS.map(metric =>
    [`千川${type}·${metric}`, type === '合计' && metric === '消耗' ? 'stat_cost' : null, false])),
  ...TRAFFIC_SOURCES.flatMap(source => [
    [`流量${source}·进房人数`, null, false], [`流量${source}·转化人数`, null, false],
  ]),
];

export const REVIEW_FIELDS = [
  '同步键', '场次稳定键', '小时开始', '小时结束', '版本', '直播状态', '读取时间',
  ...REVIEW_METRICS.flatMap(([name, , compare]) => compare ? [
    `${name}·本小时`, `${name}·性质`, `${name}·上一小时`, `${name}·上一小时性质`, `${name}·变化`, `${name}·变化性质`,
  ] : [`${name}·本小时`, `${name}·性质`]),
];

const hourMillis = value => Date.parse(String(value).replace(' ', 'T') + '+08:00');
const versionOf = row => String(row.version || '').split(':')[0];
const groupKey = row => [row.sessionKey, row.hourStart, row.hourEnd, versionOf(row)].join('|');
const metricId = row => row.source === '电商罗盘' && row.metricKey === 'stat_cost'
  ? 'compass_stat_cost' : row.metricKey;
const quality = row => row?.status === '已读取' && Number.isFinite(row.value)
  ? row.grain === '官方小时' ? '官方小时值' : row.grain === '本机计算' ? '本机计算值'
    : row.grain === '边界快照' ? '边界快照' : '独立对照'
  : '未采集';
const display = row => {
  if (!row || quality(row) === '未采集') return '';
  const text = row.display || String(row.value);
  return row.unit && !text.trim().endsWith(row.unit) ? `${text} ${row.unit}` : text;
};

function choose(rows, frozen) {
  const sorted = rows.filter(row => Number.isFinite(Date.parse(row.sampledAt)))
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  const usable = sorted.filter(row => quality(row) !== '未采集');
  const official = usable.filter(row => row.grain === '官方小时');
  if (official.length) return frozen ? official[0] : official.at(-1);
  return (frozen ? usable[0] || sorted[0] : usable.at(-1) || sorted.at(-1)) || null;
}

function delta(current, previous) {
  if (!current || !previous || quality(current) === '未采集' || quality(previous) === '未采集' ||
      quality(current) !== quality(previous) || current.unit !== previous.unit) return ['', ''];
  const displayed = row => {
    const text = String(row.display || '').replaceAll(',', '').trim();
    return /^-?\d+(?:\.\d+)?%?$/.test(text) ? Number(text.replace('%', '')) : null;
  };
  const a = displayed(current), b = displayed(previous);
  if (a === null || b === null) return ['', ''];
  const difference = a - b;
  if (!Number.isFinite(difference)) return ['', ''];
  const percent = String(current.display).includes('%') && String(previous.display).includes('%');
  const value = `${Number(difference.toFixed(6))}${percent ? ' 个百分点' : current.unit ? ` ${current.unit}` : ''}`;
  const nature = quality(current) === '边界快照' ? '边界读数差，非小时增量'
    : quality(current) === '独立对照' ? '独立对照读数差，非小时增量'
      : quality(current) === '本机计算值' ? '本机计算值差' : '官方小时值差';
  return [value, nature];
}

function calculated(metricKey, numerator, denominator, multiplier = 1000) {
  if (quality(numerator) !== '官方小时值' || quality(denominator) !== '官方小时值' ||
      numerator.source !== denominator.source ||
      denominator.value <= 0 || numerator.unit !== '元' ||
      !['人', '次', ''].includes(denominator.unit)) return null;
  const value = numerator.value * multiplier / denominator.value;
  if (!Number.isFinite(value)) return null;
  return { metricKey, value, display: value.toFixed(2), unit: '元',
    grain: '本机计算', status: '已读取' };
}

export function reviewRows(rows, now = Date.now()) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.sessionKey || !row.hourStart || !row.hourEnd ||
        !['live', 'post-live', 'unknown'].includes(versionOf(row))) continue;
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, { sessionKey: row.sessionKey, account: row.account,
      room: row.room, hourStart: row.hourStart, hourEnd: row.hourEnd, version: versionOf(row), rows: [] });
    groups.get(key).rows.push(row);
  }
  const mapped = [...groups.values()].map(group => {
    const frozen = hourMillis(group.hourEnd) <= now;
    const metrics = new Map();
    for (const [, id] of REVIEW_METRICS) {
      if (!id) continue;
      const picked = choose(group.rows.filter(row => metricId(row) === id), frozen);
      if (picked) metrics.set(id, picked);
    }
    const official = id => choose(group.rows.filter(row => row.metricKey === id &&
      row.grain === '官方小时'), frozen);
    if (quality(metrics.get('gpm')) !== '官方小时值') {
      const gpm = calculated('gpm', official('pay_amt'), official('watch_ucnt'));
      if (gpm) metrics.set('gpm', gpm);
    }
    if (quality(metrics.get('cpm')) !== '官方小时值') {
      const cost = official('stat_cost'), exposure = official('live_show_cnt');
      const cpm = cost?.source === exposure?.source ? calculated('cpm', cost, exposure) : null;
      if (cpm) metrics.set('cpm', cpm);
    }
    const customerPrice = calculated('customer_unit_price', official('pay_amt'), official('pay_ucnt'), 1);
    if (customerPrice) metrics.set('customer_unit_price', customerPrice);
    return { ...group, frozen, metrics,
      key: [group.sessionKey, group.hourStart, group.hourEnd, group.version].join(':'),
      sampledAt: group.rows.map(row => row.sampledAt).sort().at(frozen ? 0 : -1) || '',
    };
  });
  const byKey = new Map(mapped.map(row => [groupKey(row), row]));
  for (const row of mapped) {
    const previousStart = new Date(hourMillis(row.hourStart) - 3600000 + 8 * 3600000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const previous = byKey.get([row.sessionKey, previousStart, row.hourStart, row.version].join('|'));
    const fields = {
      同步键: row.key, 场次稳定键: row.sessionKey, 小时开始: row.hourStart, 小时结束: row.hourEnd,
      版本: row.version, 直播状态: ({ live: '在播', 'post-live': '下播后', unknown: '待确认' })[row.version],
      读取时间: row.sampledAt,
    };
    for (const [name, id, compare] of REVIEW_METRICS) {
      const current = id ? row.metrics.get(id) : null;
      fields[`${name}·本小时`] = display(current);
      fields[`${name}·性质`] = current ? quality(current) : '未采集';
      if (!compare) continue;
      const prior = id ? previous?.metrics.get(id) : null;
      const [change, changeKind] = delta(current, prior);
      fields[`${name}·上一小时`] = display(prior);
      fields[`${name}·上一小时性质`] = previous ? prior ? quality(prior) : '未采集' : '';
      fields[`${name}·变化`] = change;
      fields[`${name}·变化性质`] = changeKind;
    }
    row.fields = fields;
  }
  return mapped.sort((a, b) => a.hourStart.localeCompare(b.hourStart) || a.key.localeCompare(b.key));
}
