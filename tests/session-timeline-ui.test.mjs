import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../session-timeline-ui.js', import.meta.url), 'utf8');
const startAt = '2026-11-09T10:00:00Z';
const sampleAt = '2026-11-09T10:10:00Z';
const endAt = '2026-11-09T11:00:00Z';
const metricKeys = ['pay_amt', 'pay_ucnt', 'pay_combo_cnt', 'follow_anchor_ucnt'];
const sourceNames = {
  recording: '录制', archive: '归档', compass: '罗盘/RPA', shop: '店铺',
  subtitles: '字幕', comments: '评论', products: '商品事件', shifts: '轮班',
};

function fixture() {
  return {
    recordingSessionId: 'a'.repeat(32), originAt: startAt,
    identity: {recordingStartedAt: startAt, recordingEndedAt: endAt},
    segments: [], gaps: [],
    business: {status: 'ready', linked: true, snapshots: [], latest: null, historyReport: null},
    sources: {
      recording: {status: 'missing'}, archive: {status: 'missing'},
      compass: {status: 'ready'}, shop: {status: 'authorization_unknown'},
      subtitles: {status: 'missing'}, comments: {status: 'not_connected'},
      products: {status: 'not_connected'}, shifts: {status: 'unlinked'},
    },
  };
}

function metric(key, value) {
  return {key, label: key, value, display: value == null ? null : String(value), unit: key === 'pay_amt' ? '元' : '人'};
}

function eventTarget() {
  const listeners = new Map();
  return {
    innerHTML: '', textContent: '', value: '', disabled: false,
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  };
}

// Exercise the production script through its existing document events and controls.
async function loadTimeline(data) {
  const elements = new Map();
  const document = eventTarget();
  const element = id => {
    if (!elements.has(id)) elements.set(id, eventTarget());
    return elements.get(id);
  };
  document.getElementById = element;
  const esc = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const context = vm.createContext({
    document, esc, formatTime: value => value,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    apiRequest: async path => {
      assert.equal(path, `/api/session-timeline?recordingSessionId=${data.recordingSessionId}`);
      return data;
    },
  });
  vm.runInContext(script, context, {filename: 'session-timeline-ui.js'});
  document.dispatchEvent({type: 'liveops:review-session', detail: {sessionId: data.recordingSessionId}});
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(element('reviewTimelineStatus').textContent, /读取失败/);
  return {
    element,
    select(key) {
      const picker = element('reviewTimelineMetric');
      picker.value = key;
      picker.dispatchEvent({type: 'change', target: picker});
    },
    seek(seconds) {
      const cursor = element('reviewTimelineCursor');
      cursor.value = String(seconds);
      cursor.dispatchEvent({type: 'input', target: cursor});
    },
    values() {
      const html = element('reviewTimelineValues').innerHTML;
      return [...html.matchAll(/<div>([^<]+)<strong>(.*?)<\/strong><small>(.*?)<\/small><\/div>/g)]
        .map(([, label, value, note]) => ({label, value, note}));
    },
    health() {
      const html = element('reviewTimelineHealth').innerHTML;
      return Object.fromEntries([...html.matchAll(/<span\b([^>]*)>(.*?)<\/span>/g)].map(([, attrs, label]) => {
        const state = attrs.match(/\bdata-state="([^"]*)"/)?.[1];
        return [label.split(' · ')[0], {state, label}];
      }));
    },
  };
}

for (const key of metricKeys) {
  test(`${key}: cursor snapshots do not establish a cumulative value`, async () => {
    for (const value of [17, 0, null]) {
      const data = fixture();
      data.business.snapshots = [{sampledAt: sampleAt, metrics: [metric(key, value)], source: 'compass_live_snapshot'}];
      data.business.latest = {sampledAt: endAt, metrics: [metric(key, 999)]};
      const ui = await loadTimeline(data);
      ui.select(key);
      assert.deepEqual(ui.values().map(cell => cell.value), ['—', '—', '—'], 'before the first sample nothing is inferred');
      ui.seek(600);
      const cells = ui.values();
      assert.deepEqual(cells.map(cell => cell.label), ['光标时刻值', '截至该时刻累计值', '全场最终值']);
      assert.equal(cells[0].value, value == null ? '—' : `${value} ${key === 'pay_amt' ? '元' : '人'}`);
      assert.equal(cells[1].value, '—', `${key} snapshot ${value} must not be repeated as cumulative`);
      assert.match(cells[1].note, /无已核验累计口径/);
      assert.equal(cells[2].value, '—', 'latest is not a final report');
      ui.seek(3600);
      assert.equal(ui.values()[1].value, '—', 'the end of the recording does not verify a cumulative definition');
    }
  });
}

test('historyReport supplies final values independently of cursor snapshots and latest', async () => {
  const data = fixture();
  data.business.snapshots = [{sampledAt: sampleAt, metrics: metricKeys.map(key => metric(key, 3))}];
  data.business.latest = {sampledAt: endAt, metrics: metricKeys.map(key => metric(key, 999))};
  data.business.historyReport = {
    retrievedAt: '2026-11-09T12:00:00Z', source: 'compass_history_detail',
    metrics: [metric('pay_amt', 28), metric('pay_ucnt', 0), metric('pay_combo_cnt', null)],
  };
  const ui = await loadTimeline(data);
  for (const [key, expectedFinal] of [['pay_amt', '28 元'], ['pay_ucnt', '0 人'], ['pay_combo_cnt', '—'], ['follow_anchor_ucnt', '—']]) {
    ui.select(key);
    ui.seek(0);
    assert.deepEqual(ui.values().map(cell => cell.value), ['—', '—', expectedFinal]);
    ui.seek(600);
    assert.deepEqual(ui.values().map(cell => cell.value), [`3 ${key === 'pay_amt' ? '元' : '人'}`, '—', expectedFinal]);
  }
});

test('an explicit missing display is rendered as a dash while a zero stays visible', async () => {
  const data = fixture();
  data.business.snapshots = [{sampledAt: sampleAt, metrics: [
    {...metric('pay_amt', null), display: '—'}, {...metric('pay_ucnt', 0), display: 0},
  ]}];
  const ui = await loadTimeline(data);
  ui.seek(600);
  ui.select('pay_amt');
  assert.deepEqual(ui.values().map(cell => cell.value), ['—', '—', '—']);
  ui.select('pay_ucnt');
  assert.deepEqual(ui.values().map(cell => cell.value), ['0 人', '—', '—']);
});

test('health preserves the eight API sources and distinguishes their labels', async () => {
  const data = fixture();
  Object.assign(data.sources, {
    recording: {status: 'available'}, archive: {status: 'completed'},
    compass: {status: 'paused', note: '采集已暂停'}, shop: {status: 'authorization_unknown', note: '本机配置不代表平台授权'},
  });
  const ui = await loadTimeline(data);
  const health = ui.health();
  assert.deepEqual(Object.keys(health).sort(), Object.values(sourceNames).sort());
  for (const [key, name] of Object.entries(sourceNames)) assert.equal(health[name].state, data.sources[key].status);
  for (const [name, label] of [['录制', /就绪|可用/], ['归档', /完成/], ['罗盘/RPA', /暂停/], ['店铺', /授权未知/],
    ['字幕', /缺失/], ['评论', /未接入/], ['商品事件', /未接入/], ['轮班', /未关联/]]) {
    assert.match(health[name].label, label);
  }
  assert.match(health['店铺'].label, /本机配置不代表平台授权/);
});

for (const [state, label] of [
  ['ready', /就绪/], ['missing', /缺失/], ['paused', /暂停/], ['needs_login', /需要登录/],
  ['identity_changed', /身份已变化/], ['account_changed', /账号已变化/], ['unavailable', /不可用/],
  ['offline', /离线/], ['unlinked', /未关联/], ['rate_limited', /限流/], ['partial', /部分可用/],
  ['no_snapshot', /无快照/], ['room_missing', /场次缺失/], ['error', /异常/],
]) {
  test(`RPA health keeps ${state} despite readable local snapshots`, async () => {
    const data = fixture();
    data.business.snapshots = [{sampledAt: sampleAt, metrics: [metric('pay_amt', 5)]}];
    data.sources.compass = {status: state, lastSuccessAt: sampleAt};
    const ui = await loadTimeline(data);
    assert.equal(ui.health()['罗盘/RPA'].state, state);
    assert.match(ui.health()['罗盘/RPA'].label, label);
    assert.match(ui.health()['罗盘/RPA'].label, /本机已存数据可查看/);
  });
}

test('archive job states and read errors are not replaced by a generic missing state', async () => {
  for (const state of ['completed', 'queued', 'processing', 'failed', 'error', 'missing']) {
    const data = fixture();
    data.sources.archive = {status: state, note: '归档来源说明'};
    // The source status wins over an older archive object.
    data.archive = {status: 'completed'};
    const ui = await loadTimeline(data);
    assert.equal(ui.health()['归档'].state, state);
    assert.match(ui.health()['归档'].label, /归档来源说明/);
  }
});

test('RPA connection failure and shop authorization retain different states and explanations', async () => {
  for (const state of ['authorization_unknown', 'unauthorized']) {
    const data = fixture();
    data.sources.compass = {status: 'unavailable', note: '连接本机采集器失败'};
    data.sources.shop = {status: state, note: '授权状态来自店铺源'};
    const ui = await loadTimeline(data);
    const health = ui.health();
    assert.equal(health['罗盘/RPA'].state, 'unavailable');
    assert.equal(health['店铺'].state, state);
    assert.match(health['罗盘/RPA'].label, /不可用.*连接本机采集器失败/);
    assert.match(health['店铺'].label, state === 'unauthorized' ? /未授权/ : /授权未知/);
    assert.notEqual(health['罗盘/RPA'].label, health['店铺'].label);
  }
});

test('absent source states remain unknown even when recording and business data exist', async () => {
  const data = fixture();
  data.sources = {};
  data.segments = [{firstObservedAt: startAt, lastObservedAt: endAt}];
  data.archive = {status: 'completed', subtitlesPath: 'subtitles.srt'};
  data.business.snapshots = [{sampledAt: sampleAt, metrics: [metric('pay_amt', 5)]}];
  const ui = await loadTimeline(data);
  for (const name of Object.values(sourceNames)) assert.equal(ui.health()[name].state, 'unknown', name);
});

test('health styles distinguish connection failures, authorization and other actionable states', () => {
  const css = readFileSync(new URL('../workbench-ui.css', import.meta.url), 'utf8');
  const styleFor = state => {
    const style = {};
    for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const matches = selectors.split(',').map(selector => selector.trim());
      if (!matches.includes('.review-health span') && !matches.includes(`.review-health span[data-state="${state}"]`)) continue;
      for (const declaration of declarations.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon !== -1) style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    return style;
  };
  const states = ['ready', 'missing', 'paused', 'needs_login', 'identity_changed',
    'authorization_unknown', 'unauthorized', 'not_connected', 'unlinked', 'unavailable'];
  const styles = states.map(state => JSON.stringify(styleFor(state)));
  assert.equal(new Set(styles).size, states.length, 'these distinct health conditions need distinct styles');
  for (const authorization of ['authorization_unknown', 'unauthorized']) {
    assert.notEqual(styleFor('unavailable').background, styleFor(authorization).background);
    assert.notEqual(styleFor('unavailable').color, styleFor(authorization).color);
  }
});
