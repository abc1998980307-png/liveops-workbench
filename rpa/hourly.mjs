import { qianchuanSpendRequest } from './spend-source.mjs';
import crypto from 'node:crypto';

const ZONE = 'Asia/Shanghai';
const SNAPSHOT_METRICS = new Map([
  ['online_user_cnt', '在线人数'], ['watch_ucnt', '进直播间人数'],
  ['product_click_ucnt', '商品点击人数'], ['pay_ucnt', '支付人数'],
  ['pay_amt', '成交金额'], ['pay_combo_cnt', '成交订单'],
  ['follow_anchor_ucnt', '新增关注'], ['watch_pay_ucnt_ratio', '观看支付转化'],
  ['gpm', '千次观看成交额'], ['avg_watch_duration', '人均观看时长'],
  ['live_show_watch_cnt_ratio', '进房率'], ['product_click_ucnt_ratio', '商品点击率'],
  ['watch_interact_ucnt_ratio', '互动率'], ['product_click_pay_ucnt_ratio', '点击支付转化率'],
]);

function sessionKey(account, room) {
  return `session:${crypto.createHash('sha256').update(`${account.uid}:${room.id}`).digest('hex').slice(0, 24)}`;
}

function streamState(state, source) {
  if (state === 'ended') return source === 'qianchuan' ? '下播后重报' : '下播后';
  if (state === 'live') return source === 'qianchuan' ? '在播读数' : '在播观测';
  return '直播状态待确认';
}

function versionState(state) {
  return state === 'ended' ? 'post-live' : state === 'live' ? 'live' : 'unknown';
}

function metricUnit(metric, key) {
  const unit = String(metric?.unit || '').trim();
  if (unit && !/^(?:nan|undefined|null)$/i.test(unit)) return unit;
  return key === 'follow_anchor_ucnt' ? '人' : '';
}

function shanghaiHour(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) throw new Error('小时采样时间无效');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00:00`;
}

export function hourWindow(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2})(?::00(?::00)?)?$/.exec(String(value));
  if (!match || Number(match[2]) > 23) throw new Error('官方小时桶格式未核实');
  const start = `${match[1]} ${match[2]}:00:00`;
  const time = Date.parse(`${match[1]}T${match[2]}:00:00+08:00`);
  if (!Number.isFinite(time) || shanghaiHour(time) !== start) throw new Error('官方小时桶日期无效');
  return { hourStart: start, hourEnd: shanghaiHour(time + 3600000) };
}

export function boundaryWindow(sampledAt, minutes = 5) {
  const date = new Date(sampledAt);
  if (!Number.isFinite(date.valueOf())) throw new Error('罗盘采样时间无效');
  const hourEnd = shanghaiHour(date);
  const boundary = Date.parse(hourEnd.replace(' ', 'T') + '+08:00');
  if (date.valueOf() - boundary > minutes * 60000) return null;
  return { hourStart: shanghaiHour(boundary - 3600000), hourEnd };
}

export function compassHourlyRows(account, room, snapshot, sampledAt) {
  const window = boundaryWindow(sampledAt);
  if (!window) return [];
  const state = ['live', 'ended'].includes(snapshot.state) ? snapshot.state :
    room.state === 'live' || (room.state === 'ended' && snapshot.metrics?.some(metric => Number.isFinite(metric.value)))
      ? room.state : 'unknown';
  const common = { account: account.id, room: room.id, sessionKey: sessionKey(account, room),
    accountAlias: account.name || account.label, source: '电商罗盘', grain: '边界快照',
    statisticalWindow: '目标直播间实时大屏；小时边界读数，字段级小时映射未核实',
    sampledAt, streamState: streamState(state, 'compass'),
    valueKind: '官方页面快照', ...window };
  const rows = [];
  for (const [key, metricName] of SNAPSHOT_METRICS) {
    const metric = snapshot.metrics?.find(item => item.key === key);
    rows.push({ ...common, metricKey: key, metricName,
      value: Number.isFinite(metric?.value) ? metric.value : null,
      display: metric?.display === '—' ? '' : metric?.display || '',
      unit: metricUnit(metric, key),
      status: Number.isFinite(metric?.value) ? '已读取' : '缺失',
      reason: Number.isFinite(metric?.value) ? '' : '小时边界快照指标未返回可核验数值',
      version: `${versionState(state)}:${window.hourEnd}` });
  }
  const spend = snapshot.spendReconciliation?.compass;
  rows.push({ ...common, metricKey: 'stat_cost', metricName: '千川消耗', grain: '独立对照',
    statisticalWindow: '罗盘目标直播间实时大屏；账户范围及准确统计起止未定义；非小时消耗',
    value: spend ? Number(spend.amount) : null, display: spend?.display || '', unit: '元',
    status: spend ? '已读取' : '缺失', reason: spend ? '' : snapshot.spendReconciliation?.reasons?.compass || '罗盘千川消耗未返回',
    version: `${versionState(state)}:${window.hourEnd}` });
  return rows;
}

export function qianchuanHourlyRequest(accountId, room, now = new Date()) {
  const request = qianchuanSpendRequest(accountId, room.id, room.startedAt, now);
  request.body.Dimensions = ['room_id', 'stat_time_hour'];
  request.body.PageParams = { Offset: 0, Limit: 1000 };
  return request;
}

function assertSinglePage(body, rows) {
  if (rows.length >= 1000) throw new Error('千川分时报表达到单页上限，分页完整性未核实');
  const stats = body.data.StatsData;
  for (const container of [stats, body.data]) {
    for (const key of ['HasMore', 'has_more']) {
      if (container[key] === true) throw new Error('千川分时报表仍有后页，分页完整性未核实');
      if (container[key] !== undefined && typeof container[key] !== 'boolean')
        throw new Error('千川分时报表分页标记无效');
    }
    for (const key of ['Total', 'TotalCount', 'total', 'total_count']) {
      if (container[key] === undefined) continue;
      const total = container[key];
      if (!Number.isSafeInteger(total) || total < 0 || total !== rows.length)
        throw new Error('千川分时报表总数与单页不符，分页完整性未核实');
    }
  }
}

function localInstant(value) {
  const raw = String(value || '').replaceAll('/', '-');
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return NaN;
  return Date.parse(local ? `${local[1]}T${local[2]}:${local[3]}:${local[4] || '00'}+08:00` : raw);
}

export function qianchuanHourCoverage(rows, room, sampledAt) {
  const start = localInstant(room.startedAt);
  const end = room.state === 'ended' ? localInstant(room.endedAt) : Date.parse(sampledAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      !['live', 'ended'].includes(room.state))
    return { status: '待确认', expected: null, observed: rows.length, missing: [] };
  const first = Date.parse(`${shanghaiHour(start).replace(' ', 'T')}+08:00`);
  const boundary = Date.parse(`${shanghaiHour(end).replace(' ', 'T')}+08:00`);
  const exclusive = room.state === 'ended' && end > boundary ? boundary + 3600000 : boundary;
  const expected = (exclusive - first) / 3600000;
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 1000)
    return { status: '待确认', expected: null, observed: rows.length, missing: [] };
  const seen = new Set(rows.map(row => row.hourStart));
  const missing = [];
  for (let time = first; time < exclusive; time += 3600000) {
    const hour = shanghaiHour(time);
    if (!seen.has(hour)) missing.push(hour);
  }
  return { status: missing.length ? '有缺口' : '已覆盖', expected,
    observed: rows.length, missing };
}

export function qianchuanHourlyRows(body, account, room, sampledAt) {
  if (String(body?.status_code) !== '0') throw new Error('千川分时报表未返回成功状态');
  const rows = body?.data?.StatsData?.Rows;
  if (!Array.isArray(rows)) throw new Error('千川分时报表缺少 Rows');
  assertSinglePage(body, rows);
  const started = String(room.startedAt || '').match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!started) throw new Error('千川分时报表场次开播日期无效');
  const startDay = `${started[1]}-${started[2]}-${started[3]}`;
  const endDay = shanghaiHour(sampledAt).slice(0, 10);
  const statisticalWindow = `${startDay} 00:00:00 至 ${endDay} 23:59:59；当前户、目标直播间、全域直播间报表`;
  const startInstant = localInstant(room.startedAt);
  const sampledInstant = Date.parse(sampledAt);
  const endedInstant = room.endedAt ? localInstant(room.endedAt) : NaN;
  if (!Number.isFinite(sampledInstant)) throw new Error('千川分时报表采样时间无效');
  const parsed = []; const seen = new Set();
  for (const row of rows) {
    if (String(row?.Dimensions?.room_id?.Value ?? row?.Dimensions?.room_id?.ValueStr ?? '') !== room.id)
      throw new Error('千川分时报表混入其他直播间');
    const rawHour = row?.Dimensions?.stat_time_hour?.ValueStr ?? row?.Dimensions?.stat_time_hour?.Value;
    const window = hourWindow(rawHour);
    const bucket = Date.parse(`${window.hourStart.replace(' ', 'T')}+08:00`);
    if (Number.isFinite(startInstant) && bucket < Date.parse(`${shanghaiHour(startInstant).replace(' ', 'T')}+08:00`) ||
        bucket > Date.parse(`${shanghaiHour(sampledInstant).replace(' ', 'T')}+08:00`) ||
        Number.isFinite(endedInstant) && bucket > Date.parse(`${shanghaiHour(endedInstant).replace(' ', 'T')}+08:00`))
      throw new Error('千川分时报表小时桶超出目标场次或采样范围');
    if (seen.has(window.hourStart)) throw new Error('千川分时报表小时桶重复');
    seen.add(window.hourStart);
    const metric = row?.Metrics?.stat_cost;
    const display = String(metric?.ValueStr ?? '').replaceAll(',', '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(display) || !Number.isFinite(metric?.Value) ||
        Math.abs(Number(display) - metric.Value) > 0.005)
      throw new Error('千川小时消耗缺少可核验的官方元金额');
    parsed.push({ account: account.id, room: room.id, sessionKey: sessionKey(account, room),
      accountAlias: '当前千川户', source: '巨量千川', metricKey: 'stat_cost', metricName: '整体消耗(元)',
      value: Number(display), display, unit: '元', grain: '官方小时',
      statisticalWindow,
      sampledAt, streamState: streamState(room.state, 'qianchuan'),
      valueKind: '官方值', status: '已读取', reason: '', ...window,
      version: `${versionState(room.state)}:${shanghaiHour(sampledAt)}` });
  }
  const coverage = qianchuanHourCoverage(parsed, room, sampledAt);
  return parsed.map(row => ({ ...row, paginationVerified: true, hourCoverage: coverage.status,
    missingHours: coverage.missing }));
}

export function qianchuanHourlyFailure(account, room, sampledAt, reason) {
  const window = { hourStart: shanghaiHour(sampledAt), hourEnd: shanghaiHour(Date.parse(sampledAt) + 3600000) };
  return { account: account.id, room: room.id, sessionKey: sessionKey(account, room),
    accountAlias: '当前千川户', source: '巨量千川', metricKey: 'stat_cost', metricName: '整体消耗(元)',
    value: null, display: '', unit: '元', grain: '官方小时',
    statisticalWindow: '当前户、目标直播间、全域直播间报表；官方小时桶未取得',
    sampledAt, streamState: streamState(room.state, 'qianchuan'),
    valueKind: '未取得官方值', status: '失败', reason: String(reason).slice(0, 120), ...window,
    version: `${versionState(room.state)}:${shanghaiHour(sampledAt)}` };
}
