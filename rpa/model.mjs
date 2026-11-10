export const ORIGIN = 'https://compass.jinritemai.com';
export const HOME = `${ORIGIN}/talent`;
export const METRICS = [
  ['online_user_cnt', '在线人数'], ['pay_ucnt', '支付人数'],
  ['pay_amt', '成交金额'], ['pay_combo_cnt', '成交订单'],
  ['gpm', '千次观看成交额'], ['watch_pay_ucnt_ratio', '观看支付转化'],
  ['avg_watch_duration', '平均观看时长'], ['follow_anchor_ucnt', '新增关注'],
];
export const TASKS = {
  identity: '/business_api/home/unify_track',
  account: '/ecomauth/loginv1/get_account_info?login_source=compass',
  rooms: '/compass_api/author/live/live_detail/today_live_room',
  history: '/compass_api/content_live/author/live_detail/history_live',
  base: '/compass_api/author/live/live_screen/live_base_info',
  core: '/compass_api/author/live/live_screen/core_data',
  products: '/compass_api/content_live/author/live_screen/product_list',
};
const CORE_KEYS = ['gpm', 'pay_ucnt', 'pay_combo_cnt', 'watch_pay_ucnt_ratio', 'product_click_pay_ucnt_ratio', 'online_user_cnt', 'live_show_watch_cnt_ratio', 'avg_watch_duration', 'watch_interact_ucnt_ratio', 'follow_anchor_ucnt', 'old_fans_pay_ucnt_ratio'];
const PRODUCT_KEYS = ['pay_amt', 'pay_cnt', 'pay_combo_cnt', 'product_show_ucnt', 'product_click_ucnt', 'stock_cnt', 'refund_cnt', 'real_refund_amt'];

export function taskUrl(task, roomId) {
  if (!Object.hasOwn(TASKS, task)) throw new Error('不支持的采集任务');
  const url = new URL(TASKS[task], ORIGIN);
  if (['base', 'core', 'products'].includes(task)) {
    if (!/^\d{1,30}$/.test(String(roomId))) throw new Error('直播场次 ID 无效');
    url.searchParams.set('room_id', roomId);
  }
  if (task === 'core') url.searchParams.set('index_selected', CORE_KEYS.join(','));
  if (task === 'products') {
    url.searchParams.set('index_selected', PRODUCT_KEYS.join(','));
    for (const key of ['category_id', 'product_filter_type', 'explained_filter_type']) url.searchParams.set(key, '0');
  }
  if (task === 'history') {
    const { pageNo, beginDate, beginDateFormat } = roomId || {};
    if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > 50 ||
        !Number.isSafeInteger(beginDate) || beginDate < 0 ||
        !/^\d{4}-\d{2}-\d{2}T00:00:00\+08:00$/.test(beginDateFormat || '')) throw new Error('历史场次分页参数无效');
    for (const [key, value] of Object.entries({ is_asc: 'false', page_no: pageNo, page_size: 10,
      date_type: 24, begin_date: beginDate, begin_date_format: beginDateFormat,
      index_selected: '', filter_type: 0 })) url.searchParams.set(key, String(value));
  }
  return url.href;
}

export class CollectError extends Error {
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

export function validateResponse(response) {
  if ([401, 403].includes(response.status)) throw new CollectError('登录已失效或账号无权查看，请在罗盘窗口重新登录。', 'needs_login');
  if (response.status === 429) throw new CollectError('罗盘请求频率受限，稍后会降低频率重试。', 'rate_limited');
  if (response.status !== 200) throw new CollectError(`罗盘接口返回 HTTP ${response.status}`);
  if (!response.body || typeof response.body !== 'object') throw new CollectError('罗盘返回了网页而非数据，请检查登录状态。', 'needs_login');
  const body = response.body;
  const code = body.st ?? body.code ?? body.status_code;
  if (code != null && String(code) !== '0') {
    const msg = String(body.msg || body.message || body.status_msg || '').slice(0, 150);
    const login = /登录|登陆|login|unauthoriz|not.?logged/i.test(msg);
    throw new CollectError(login ? '罗盘登录已失效，请重新登录。' : `罗盘业务错误 ${code}${msg ? '：' + msg : ''}`, login ? 'needs_login' : 'error');
  }
  return body;
}

// Keep response numbers and explicitly supplied units. Never guess cents/yuan or ratios/percentages.
export function measure(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { value, display: String(value), unit: '' } : null;
  if (typeof value === 'string') {
    const plain = value.trim().replaceAll(',', '');
    const number = /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : null;
    return { value: number, display: value.slice(0, 100), unit: '' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const nested = measure(value.value ?? value.index_value ?? value.value_str ?? value.value_text ?? value.display_value);
  if (!nested) return null;
  const text = value.value_str ?? value.value_text ?? value.display_value;
  return { ...nested, display: typeof text === 'string' ? text.slice(0, 100) : nested.display, unit: typeof value.unit === 'string' ? value.unit.slice(0, 30) : nested.unit };
}

export function findMetric(root, key) {
  const queue = [root]; let visited = 0;
  while (queue.length && visited++ < 10000) {
    const obj = queue.shift();
    if (!obj || typeof obj !== 'object') continue;
    if (!Array.isArray(obj)) {
      if (Object.hasOwn(obj, key)) { const found = measure(obj[key]); if (found) return found; }
      if ([obj.index_name, obj.index_key, obj.key, obj.metric].includes(key)) {
        const found = measure(obj); if (found) return found;
      }
    }
    for (const [name, value] of Object.entries(obj)) {
      if (!/compare|previous|yesterday|trend|history|growth|change|ratio_change/i.test(name) && value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function objects(root, limit = 10000) {
  const result = [], queue = [root];
  while (queue.length && result.length < limit) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    result.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push(child);
  }
  return result;
}

export function liveState(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  for (const key of ['is_live', 'is_living']) {
    if (value[key] === true || value[key] === 1) return 'live';
    if (value[key] === false || value[key] === 0) return 'ended';
  }
  // These are the Douyin room-status values, not arbitrary business-response status codes.
  if (Number(value.room_status) === 2) return 'live';
  if (Number(value.room_status) === 4) return 'ended';
  return 'unknown';
}

export function roomList(body) {
  const cards = body?.data?.card_list;
  if (!Array.isArray(cards)) throw new CollectError('今日场次接口的结构已变化：缺少 card_list。');
  const rooms = new Map();
  for (const card of cards) {
    for (const obj of objects(card)) {
      const id = obj.room_id ?? obj.live_room_id;
      if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new CollectError('场次 ID 以超出安全精度的数值返回，已停止本轮同步。');
      if (id == null || !/^\d{1,30}$/.test(String(id))) continue;
      const previous = rooms.get(String(id));
      const state = liveState(obj);
      rooms.set(String(id), {
        id: String(id), title: String(obj.room_title || obj.room_name || obj.title || previous?.title || `直播场次 ${id}`).slice(0, 200),
        state: state !== 'unknown' ? state : previous?.state || 'unknown',
        startedAt: obj.start_time || obj.live_start_time || previous?.startedAt || null,
      });
    }
  }
  if (cards.length && !rooms.size) throw new CollectError('已返回场次列表，但场次 ID 格式未识别。请查看同步记录。');
  return [...rooms.values()];
}

export function historyWindow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 89);
  return { beginDate: (midnight - 8 * 3600e3) / 1000,
    beginDateFormat: `${new Date(midnight).toISOString().slice(0, 10)}T00:00:00+08:00` };
}

export function historyRoomPage(body, requestedPage) {
  const data = body?.data, rows = data?.data_result, page = data?.page_result;
  if (!Array.isArray(rows) || !page || typeof page !== 'object') throw new CollectError('历史场次接口结构已变化。');
  const pageNo = page.page_no, pageSize = page.page_size, total = page.total;
  if (!Number.isSafeInteger(pageNo) || pageNo !== requestedPage ||
      pageSize !== 10 || !Number.isSafeInteger(total) || total < 0 || rows.length > 10)
    throw new CollectError('历史场次分页结果无效。');
  const rooms = new Map();
  for (const row of rows) {
    const id = row?.operation?.live_id;
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new CollectError('历史场次 ID 无法保持精确字符串，已停止导入。');
    const name = row.live_room;
    const title = typeof name === 'string' ? name : name?.room_title || name?.room_name || name?.title;
    const rawTime = row.start_time;
    let startedAt = rawTime == null ? null : String(rawTime).slice(0, 80);
    if (/^\d{10,13}$/.test(startedAt || '')) {
      const time = Number(startedAt) * (startedAt.length === 10 ? 1000 : 1);
      startedAt = Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
    rooms.set(id, { id, title: String(title || `直播场次 ${id}`).slice(0, 200),
      state: 'ended', startedAt, today: false, source: 'compass_history' });
  }
  if (!rooms.size && total > (pageNo - 1) * pageSize) throw new CollectError('历史场次分页为空，但仍有未读取记录。');
  return { rooms: [...rooms.values()], pageNo, pageSize, total };
}

export function normalizeSnapshot(results) {
  const base = results.base?.ok ? results.base.body?.data : null;
  const core = results.core?.ok ? results.core.body?.data : null;
  const metrics = METRICS.map(([key, label]) => ({ key, label, ...(findMetric(core, key) || findMetric(base, key) || { value: null, display: '—', unit: '' }) }));
  const all = results.products?.ok ? objects(results.products.body?.data) : [];
  const products = new Map();
  for (const item of all) {
    const id = item.product_id ?? item.promotion_id;
    if (id == null || typeof id === 'object') continue;
    const name = item.product_name || item.product_title || item.title || item.name;
    if (!name) continue;
    products.set(String(id), { id: String(id), name: String(name).slice(0, 300), metrics: Object.fromEntries(PRODUCT_KEYS.map(k => [k, findMetric(item, k)])) });
  }
  const state = objects(base).map(liveState).find(s => s !== 'unknown') || 'unknown';
  return { metrics, products: [...products.values()].slice(0, 500), state, endpoints: Object.fromEntries(Object.entries(results).map(([name, r]) => [name, { ok: r.ok, error: r.error || null }])) };
}
