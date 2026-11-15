(() => {
  const $ = id => document.getElementById(id);
  const empty = message => `<div class="review-timeline-empty">${esc(message)}</div>`;
  const time = value => value && !Number.isNaN(Date.parse(value)) ? formatTime(value) : '—';
  const stamp = value => value ? Date.parse(value) : NaN;
  const val = metric => metric && metric.display != null && metric.display !== '' && metric.display !== '—'
    ? `${esc(metric.display)}${metric.unit ? ` ${esc(metric.unit)}` : ''}` : '—';
  let sessionId = '';
  let data = null;
  let cursor = NaN;
  let selectedMetric = '';
  let rangeStart = NaN;
  let rangeEnd = NaN;
  let lastLoad = 0;
  let requestVersion = 0;

  function metricRows() {
    const business = data?.business || {};
    return Array.isArray(business.snapshots) ? business.snapshots.filter(row => Number.isFinite(stamp(row.sampledAt)))
      .map(row => ({time:row.sampledAt, metrics:row.metrics, source:row.source})) : [];
  }
  function metricAt(row, key) { return (row?.metrics || []).find(item => item.key === key); }
  function currentRow() { return metricRows().filter(row => stamp(row.time) <= cursor).at(-1); }
  function fullBounds() {
    const identity = data?.identity || {};
    const start = stamp(data?.originAt || identity.recordingStartedAt);
    const candidates = [stamp(identity.recordingEndedAt), stamp(identity.businessEndedAt), ...((data?.segments || []).map(s => stamp(s.lastObservedAt))),
      ...metricRows().map(row => stamp(row.time))].filter(Number.isFinite);
    const end = Math.max(start, ...candidates);
    return {start, end: Number.isFinite(end) ? end : start};
  }
  function bounds() {
    const full = fullBounds();
    return {start:Number.isFinite(rangeStart) ? Math.max(full.start, rangeStart) : full.start,
      end:Number.isFinite(rangeEnd) ? Math.min(full.end, rangeEnd) : full.end};
  }
  function localInput(value) {
    return Number.isFinite(value) ? new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  }
  function renderRange() {
    const {start, end} = fullBounds();
    const available = Number.isFinite(start) && end > start;
    for (const [id, value] of [['reviewTimelineFrom', Number.isFinite(rangeStart) ? rangeStart : start],
                               ['reviewTimelineTo', Number.isFinite(rangeEnd) ? rangeEnd : end]]) {
      $(id).disabled = !available;
      $(id).value = localInput(value);
    }
    $('reviewTimelineFull').disabled = !available || (!Number.isFinite(rangeStart) && !Number.isFinite(rangeEnd));
  }
  function seek(value) {
    const {start, end} = bounds();
    if (!Number.isFinite(start)) return;
    cursor = Math.min(end, Math.max(start, value));
    $('reviewTimelineCursor').value = String(Math.round((cursor - start) / 1000));
    document.dispatchEvent(new CustomEvent('liveops:review-cursor', {detail:{at:new Date(cursor).toISOString()}}));
    renderCursor();
  }
  function renderIdentity() {
    const session = data?.identity;
    const link = data?.business?.link;
    if (!session) { $('reviewTimelineIdentity').innerHTML = ''; return; }
    const parts = [
      `平台 ${session.platform === 'douyin_ecommerce' ? '抖音电商（已确认关联）' : '未核验'}`,
      `直播号 UID ${session.liveAccountUid || '未核验'}`,
      `录制器房间 ID ${session.recordingRoomId || '—'}`,
      `录制场次 ID ${data.recordingSessionId || '—'}`,
      `经营场次 ID ${session.roomId || '未关联'}`,
      `录制开始 ${time(session.recordingStartedAt)}`,
      `录制结束 ${session.recordingEndedAt ? time(session.recordingEndedAt) : '未确认'}`,
      `经营开始 ${time(session.businessStartedAt)}`,
      `经营结束 ${time(session.businessEndedAt)}`,
      `源时区 ${session.timeZone ? `UTC${session.timeZone}` : '未核验'}`
    ];
    $('reviewTimelineIdentity').innerHTML = parts.map(part => `<span>${esc(part)}</span>`).join('');
  }
  function renderHealth() {
    const business = data?.business || {};
    const source = data?.sources || {};
    const labels = {ready:'就绪', available:'可用', completed:'已完成', missing:'缺失',
      paused:'暂停', needs_login:'需要登录', identity_changed:'身份已变化', account_changed:'账号已变化',
      authorization_unknown:'授权未知', unauthorized:'未授权', not_connected:'未接入', unlinked:'未关联',
      unavailable:'不可用', offline:'离线', error:'异常', failed:'失败', partial:'部分可用',
      rate_limited:'请求限流', queued:'排队中', processing:'处理中', room_missing:'场次缺失',
      no_snapshot:'无快照', unknown:'状态未核验'};
    const items = [
      ['recording', '录制'], ['archive', '归档'], ['compass', '罗盘/RPA'], ['shop', '店铺'],
      ['subtitles', '字幕'], ['comments', '评论'], ['products', '商品事件'], ['shifts', '轮班']
    ];
    $('reviewTimelineHealth').innerHTML = items.map(([key, name]) => {
      const health = source[key] || {};
      // Keep each source's state, even when cached business values remain readable.
      const state = health.status || 'unknown';
      const details = [labels[state] || `未识别状态（${state}）`];
      if (key === 'recording' && data?.segments?.length) details.push(`${data.segments.length} 段已观察`);
      if (key === 'compass') {
        if (business.status === 'ready') details.push('本机已存数据可查看');
        if (health.lastSuccessAt) details.push(`最近成功 ${time(health.lastSuccessAt)}`);
      }
      if (health.note) details.push(health.note);
      const label = details.join('；');
      return `<span data-state="${esc(state)}" title="${esc(label)}">${esc(name)} · ${esc(label)}</span>`;
    }).join('');
  }
  function renderSegments() {
    const segments = data?.segments || [];
    $('reviewTimelineSegments').innerHTML = segments.length ? segments.map((segment, index) => {
      const observed = stamp(segment.lastObservedAt);
      const durationMs = Number(segment.mediaDurationMs);
      const estimatedStart = Number.isFinite(observed) && Number.isFinite(durationMs) ? observed - durationMs : stamp(segment.firstObservedAt);
      const range = `${time(segment.firstObservedAt)} 至 ${time(segment.lastObservedAt)}`;
      const available = segment.recordingPath || data?.archive?.videoPath;
      const active = cursor >= estimatedStart && cursor <= observed;
      const offset = active && Number.isFinite(durationMs) ? ` · 约片段偏移 ${Math.floor((cursor - estimatedStart) / 1000)} 秒，未校准` : '';
      return `<div class="review-timeline-row" data-active="${active}"><button type="button" data-review-seek="${Number.isFinite(estimatedStart) ? estimatedStart : ''}">片段 ${index + 1}</button><small>${esc(range)} · 观察边界，画面起点未精确核验${esc(offset)}</small>${available ? `<button type="button" data-recording-path="${esc(available)}" title="在文件管理器中显示文件">打开</button>` : ''}</div>`;
    }).join('') : empty('尚无已观察录制片段。');
    const gaps = data?.gaps || [];
    $('reviewTimelineEvents').innerHTML = gaps.length ? gaps.map(gap => `<div class="review-timeline-row" data-gap="true"><button type="button" data-review-seek="${stamp(gap.fromAt)}">${gap.status === 'observation_gap' ? '观察中断' : gap.status === 'unobserved' ? '未观察区间' : '连续性未知'}</button><small>${time(gap.fromAt)} 至 ${time(gap.toAt)} · ${esc(gap.note || '间断范围未知，不代表连续画面')}</small></div>`).join('') : empty('未记录文件切换；接入前仍可能缺少片段。');
  }
  function renderChart() {
    const {start, end} = bounds();
    const rows = metricRows().filter(row => stamp(row.time) >= start && stamp(row.time) <= end);
    const reported = data?.business?.historyReport?.metrics || [];
    const keys = [...new Map([...metricRows().flatMap(row => row.metrics || []), ...reported]
      .filter(item => item.key).map(item => [item.key, item.label || item.key])).entries()];
    const picker = $('reviewTimelineMetric');
    if (!keys.some(([key]) => key === selectedMetric)) selectedMetric = keys[0]?.[0] || '';
    picker.disabled = !keys.length;
    picker.innerHTML = keys.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
    picker.value = selectedMetric;
    const groups = [];
    let run = [];
    for (const row of rows) {
      const metric = metricAt(row, selectedMetric);
      if (Number.isFinite(metric?.value)) run.push({row, metric});
      else if (run.length) { groups.push(run); run = []; }
    }
    if (run.length) groups.push(run);
    const values = groups.flat();
    if (!values.length) { $('reviewTimelineChart').innerHTML = empty('没有可按采样时刻绘制的指标；历史最终报表不能充当分时曲线。'); return; }
    const nums = values.map(item => item.metric.value);
    const min = Math.min(...nums), max = Math.max(...nums);
    const x = t => 8 + 584 * (stamp(t) - start) / Math.max(1, end - start);
    const y = n => 112 - 96 * (n - min) / Math.max(1, max - min);
    const lines = groups.filter(group => group.length > 1).map(group => `<polyline points="${group.map(({row, metric}) => `${x(row.time).toFixed(2)},${y(metric.value).toFixed(2)}`).join(' ')}"></polyline>`).join('');
    $('reviewTimelineChart').innerHTML = `<svg class="review-chart" viewBox="0 0 600 128" preserveAspectRatio="none" role="img" aria-label="${esc(keys.find(([key]) => key === selectedMetric)?.[1] || '指标')}的本机快照曲线">${lines}${values.map(({row, metric}) => `<circle cx="${x(row.time).toFixed(2)}" cy="${y(metric.value).toFixed(2)}" r="3" data-review-seek="${stamp(row.time)}"><title>${esc(`${time(row.time)} · ${metric.display ?? '—'} ${metric.unit || ''} · 罗盘本机快照` )}</title></circle>`).join('')}</svg><div class="review-timeline-empty">${esc(values[0].metric.unit || '单位未返回')} · 本机采样时间；缺失采样之间不连线，点选圆点定位</div>`;
  }
  function renderValues() {
    const business = data?.business || {};
    const row = currentRow();
    const metric = metricAt(row, selectedMetric);
    const report = business.historyReport;
    const finalMetric = (report?.metrics || []).find(item => item.key === selectedMetric);
    const current = metric ? val(metric) : '—';
    // Snapshots have no verified cumulative source field or definition. Neither a
    // metric key, the cursor value nor the final report establishes that scope.
    const cumulative = '—';
    const final = finalMetric ? val(finalMetric) : '—';
    $('reviewTimelineValues').innerHTML = `<div>光标时刻值<strong>${current}</strong><small>${metric ? `最近采样 ${time(row.time)} · 罗盘` : '该时刻前无采样，不等于 0'}</small></div><div>截至该时刻累计值<strong>${cumulative}</strong><small>该指标无已核验累计口径</small></div><div>全场最终值<strong>${final}</strong><small>${finalMetric ? `历史报表读取 ${time(report.retrievedAt)}` : '最终报表未取得，不等于 0'}</small></div>`;
  }
  function renderFeeds() {
    const subtitles = data?.subtitles || [];
    const comments = data?.comments || [];
    const products = data?.products || [];
    const shifts = data?.shifts || [];
    const near = items => items.filter(item => Number.isFinite(stamp(item.at || item.startAt)) && Math.abs(stamp(item.at || item.startAt) - cursor) <= 60000).slice(0, 12);
    const rows = (items, label) => near(items).map(item => `<div class="review-timeline-row"><button type="button" data-review-seek="${stamp(item.at || item.startAt)}">${time(item.at || item.startAt)}</button><small>${esc(item.text || item.name || item.note || label)}${item.source ? ` · ${esc(item.source)}` : ''}${item.confidence != null ? ` · 置信度 ${esc(String(item.confidence))}` : ''}</small></div>`).join('');
    $('reviewTimelineSubtitles').innerHTML = rows(subtitles, '转写') || empty(subtitles.length ? '光标附近没有字幕。' : '归档字幕尚未校准到实际直播时刻，可在文件管理器打开原文件。');
    $('reviewTimelineComments').innerHTML = rows(comments, '评论') || empty(comments.length ? '光标附近没有评论。' : '本场评论未采集。');
    $('reviewTimelineProducts').innerHTML = rows([...products, ...shifts], '事件') || empty(products.length || shifts.length ? '光标附近没有商品或轮班记录。' : '商品事件与实际轮班尚无已核验场次来源。');
  }
  function renderCursor() {
    if (!data) return;
    const {start} = bounds();
    $('reviewTimelineTime').textContent = Number.isFinite(cursor) ? `${time(new Date(cursor).toISOString())} · +${Math.floor((cursor - start) / 1000)} 秒` : '—';
    renderSegments();
    renderValues();
    renderFeeds();
  }
  function render() {
    const {start, end} = bounds();
    $('reviewTimelineStatus').textContent = data?.business?.linked ? '已确认经营关联' : '仅本机录制，经营场次未关联';
    renderIdentity(); renderHealth(); renderRange(); renderChart();
    const slider = $('reviewTimelineCursor');
    slider.disabled = !Number.isFinite(start) || end <= start;
    slider.max = String(Math.max(0, Math.ceil((end - start) / 1000)));
    seek(Number.isFinite(cursor) ? cursor : start);
  }
  async function load(force = false) {
    if (!sessionId) return;
    if (!force && Date.now() - lastLoad < 30000) return;
    const id = sessionId, version = ++requestVersion;
    $('reviewTimelineStatus').textContent = '读取时间轴中…';
    try {
      const result = await apiRequest(`/api/session-timeline?recordingSessionId=${encodeURIComponent(id)}`);
      if (id !== sessionId || version !== requestVersion) return;
      data = result;
      lastLoad = Date.now();
      render();
    } catch (error) {
      if (id === sessionId && version === requestVersion) $('reviewTimelineStatus').textContent = '时间轴读取失败：' + error.message;
    }
  }
  document.addEventListener('liveops:review-session', event => {
    sessionId = event.detail.sessionId || '';
    data = null; cursor = NaN; selectedMetric = ''; rangeStart = NaN; rangeEnd = NaN; lastLoad = 0;
    if (sessionId) load(true);
    else { $('reviewTimelineStatus').textContent = '选择录制场次'; $('reviewTimelineIdentity').innerHTML = ''; $('reviewTimelineHealth').innerHTML = ''; $('reviewTimelineSegments').innerHTML = ''; $('reviewTimelineEvents').innerHTML = ''; $('reviewTimelineChart').innerHTML = ''; $('reviewTimelineValues').innerHTML = ''; $('reviewTimelineSubtitles').innerHTML = ''; $('reviewTimelineComments').innerHTML = ''; $('reviewTimelineProducts').innerHTML = ''; }
  });
  document.addEventListener('liveops:recording-sessions-refreshed', () => load());
  $('reviewTimelineCursor').addEventListener('input', event => seek(bounds().start + Number(event.target.value) * 1000));
  $('reviewTimelineMetric').addEventListener('change', event => { selectedMetric = event.target.value; renderChart(); renderValues(); });
  for (const id of ['reviewTimelineFrom', 'reviewTimelineTo']) {
    $(id).addEventListener('change', () => {
      const from = new Date($('reviewTimelineFrom').value).getTime();
      const to = new Date($('reviewTimelineTo').value).getTime();
      const full = fullBounds();
      const selectedStart = Math.max(full.start, from);
      const selectedEnd = Math.min(full.end, to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || selectedStart >= selectedEnd) {
        $('reviewTimelineStatus').textContent = '区间无效；请选择场次起止时间内的范围。';
        return;
      }
      rangeStart = selectedStart; rangeEnd = selectedEnd;
      render();
    });
  }
  $('reviewTimelineFull').addEventListener('click', () => { rangeStart = NaN; rangeEnd = NaN; render(); });
  $('sessionReviewPanel').addEventListener('click', event => {
    const target = event.target.closest('[data-review-seek]');
    if (target && Number.isFinite(Number(target.dataset.reviewSeek))) seek(Number(target.dataset.reviewSeek));
  });
})();
