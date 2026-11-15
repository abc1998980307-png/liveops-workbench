(() => {
  let state = null, selected = localStorage.getItem('rpaAccount') || '', room = '', metric = 'online_user_cnt';
  let loading = null, detailVersion = 0, currentDetail = null, actionBusy = false, renderedAccount = '';
  let roomPage = 0, roomList = null, roomListVersion = 0;
  let historySummary = null, summaryKey = '', summaryVersion = 0;
  let egoLoading = null;
  let qianchuanState = 'unknown', qianchuanLoading = null;
  let qianchuanAccount = null, qianchuanAccountLoading = null;
  let workspaceView = localStorage.getItem('rpaWorkspaceView') || 'accounts';
  let platformFilter = 'all', roomPlatformFilter = 'all', roomAccounts = new Set(), roomAccountsInitialized = false, roomPageView = 0, chartMode = 'chart', aggregationMode = 'exact';
  let roomSort = 'startedAt', roomSortDirection = 'desc';
  let rangePreset = '30', rangeStart = '', rangeEnd = '', omitLiveRooms = false, exactValues = false;
  let customMetrics = ['watch_ucnt', 'pay_ucnt', 'pay_combo_cnt', 'pay_amt', 'refund_cnt', 'real_refund_amt'];
  let roomDetails = new Map(), roomDetailLoads = new Set(), roomViewBusy = false;
  let accountSummaries = new Map(), summaryLoads = new Set();
  let roomWorkspaceData = null, roomWorkspaceKey = '', roomWorkspaceLoadingKey = '', roomWorkspaceError = '';
  const VIEW_PAGE_SIZE = 30;
  const PLATFORM_FILTERS = [
    ['all', '全部'], ['douyin_ecom', '抖音电商'], ['douyin_local', '抖音本地生活'],
    ['kuaishou', '快手'], ['video_account', '视频号'], ['xiaohongshu', '小红书'],
  ];
  const ROOM_METRICS = [
    ['watch_ucnt', '进入直播间人次', '人次'], ['pay_ucnt', '支付人数', '人'],
    ['pay_combo_cnt', '成交订单', '单'], ['pay_amt', '成交金额', '元'],
    ['follow_anchor_ucnt', '新增关注', '人'],
    ['refund_cnt', '退款笔数', '笔'], ['real_refund_amt', '退款金额', '元'],
  ];
  const $ = id => document.getElementById(id);
  const labels = { ready:'同步正常', needs_login:'等待登录', paused:'已暂停', partial:'部分数据失败', error:'同步失败', rate_limited:'等待重试', account_changed:'账号已切换' };
  const qianchuanLabels = { logged_in:'已登录', needs_login:'需要登录', unknown:'待确认' };
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '尚未同步';
  const chip = account => `<span class="rpa-chip ${esc(account.state)}">${esc(account.busy || account.historyBusy ? '正在同步…' : labels[account.state] || '等待同步')}</span>`;
  const value = item => item ? `${esc(item.display)}${item.unit ? ' ' + esc(item.unit) : ''}` : '—';
  const account = () => state?.accounts.find(a => a.id === selected);
  const retryAfter = a => {
    const deadlines = [a?.retryAfter, a?.historyBatch?.status === 'rate_limited' ? a.historyBatch.retryAfter : null]
      .filter(value => value && Date.parse(value) > Date.now());
    return deadlines.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  };
  const roomState = r => r.state === 'live' ? '直播中' : r.state === 'ended' ? '已结束' : '状态待确认';
  function status(message, error = false) { $('rpaStatus').textContent = message; $('rpaStatus').classList.toggle('error', error); }

  const dateKey = value => {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(parsed);
  };
  const localISODate = value => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const addDays = (value, amount) => { const d = new Date(`${value}T12:00:00`); d.setDate(d.getDate()+amount); return localISODate(d); };
  function setRangePreset(preset) {
    const today = localISODate(new Date());
    rangePreset = preset;
    if (preset === 'today') rangeStart = rangeEnd = today;
    else if (preset === 'yesterday') rangeStart = rangeEnd = addDays(today, -1);
    else if (preset === '7') rangeStart = addDays(today, -6), rangeEnd = today;
    else if (preset === '30') rangeStart = addDays(today, -29), rangeEnd = today;
    else if (preset === 'week') {
      const weekday = new Date(`${today}T12:00:00`).getDay() || 7;
      rangeStart = addDays(today, 1-weekday); rangeEnd = today;
    } else if (preset === 'month') rangeStart = `${today.slice(0,7)}-01`, rangeEnd = today;
  }
  function effectiveRange() {
    const bounds = state?.historyBounds || {};
    return { start: rangeStart || bounds.earliest || addDays(localISODate(new Date()), -29), end: rangeEnd || bounds.latest || localISODate(new Date()) };
  }
  function allStoredRooms(accountId) {
    const map = roomDetails.get(`rooms:${accountId}`);
    return map || state?.accounts.find(item => item.id === accountId)?.rooms || [];
  }
  function selectedAccounts() {
    const list = state?.accounts || [];
    return list.filter(item => roomAccounts.has(item.id) && (roomPlatformFilter === 'all' || roomPlatformFilter === 'douyin_ecom'));
  }
  function allVisibleRooms() {
    const { start, end } = effectiveRange();
    return selectedAccounts().flatMap(item => allStoredRooms(item.id).map(entry => ({...entry, accountId:item.id, accountName:item.name || item.label})))
      .filter(item => {
        const day = dateKey(item.startedAt);
        if (day && (day < start || day > end)) return false;
        if (!day && start !== (state?.historyBounds?.earliest || start)) return false;
        return !(omitLiveRooms && item.state === 'live');
      }).sort((a,b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }
  function metricFrom(data, key) {
    return data?.metrics?.find(item => item.key === key) || null;
  }
  function historicalMetricKey(key) {
    return ({ pay_amt:'t7payin8d_predstl_ord_amt', pay_combo_cnt:'t7payin8d_predstl_ord_cnt' })[key] || key;
  }
  function formatRoomMetric(data, key) {
    const workspaceMetric = data?.metrics && !Array.isArray(data.metrics) ? data.metrics[key] : null;
    const refundUnit = ({refund_cnt:'number', real_refund_amt:'price'})[key];
    const candidate = metricFrom(data?.historyReport, historicalMetricKey(key));
    const reportMetric = refundUnit && (candidate?.category !== '售后' || candidate?.rawUnit !== refundUnit) ? null : candidate;
    const preferHistory = data?.historyReport && data.state !== 'live';
    const showMetric = item => `${esc(item.display ?? item.value)}${item.unit ? ` ${esc(item.unit)}` : ''}<small class="rpa-metric-source">${esc(item.source || '罗盘')} · ${esc(date(item.retrievedAt || (item === reportMetric ? data.historyReport?.retrievedAt : null)))}</small>${exactValues ? `<small class="rpa-raw-value">接口值 ${esc(String(item.value))} ${esc(item.rawUnit||'')}</small>` : ''}`;
    if (preferHistory && reportMetric?.value != null) return showMetric(reportMetric);
    if (workspaceMetric?.value != null) return showMetric(workspaceMetric);
    if (reportMetric?.value != null) return showMetric(reportMetric);
    const latestMetric = refundUnit ? null : metricFrom(data?.latest, key);
    if (latestMetric && latestMetric.value != null) return `${esc(latestMetric.display)}${latestMetric.unit ? ` ${esc(latestMetric.unit)}` : ''}${exactValues ? `<small class="rpa-raw-value">接口值 ${esc(String(latestMetric.value))} ${esc(latestMetric.unit||'')}</small>` : ''}`;
    return '<span class="rpa-missing">未采集</span>';
  }
  function roomMetricValue(data, key) {
    const workspaceMetric = data?.metrics && !Array.isArray(data.metrics) ? data.metrics[key] : null;
    const historical = metricFrom(data?.historyReport, historicalMetricKey(key));
    const refundUnit = ({refund_cnt:'number', real_refund_amt:'price'})[key];
    const validHistorical = refundUnit && (historical?.category !== '售后' || historical?.rawUnit !== refundUnit) ? null : historical;
    if (validHistorical?.value != null && data?.state !== 'live') return { value: validHistorical.value, display: validHistorical.display, unit: validHistorical.unit, source:'罗盘历史详情', rawUnit:validHistorical.rawUnit, retrievedAt:data.historyReport.retrievedAt };
    if (workspaceMetric?.value != null) return workspaceMetric;
    if (validHistorical?.value != null) return { value: validHistorical.value, display: validHistorical.display, unit: validHistorical.unit, source:'罗盘历史详情', rawUnit:validHistorical.rawUnit, retrievedAt:data.historyReport.retrievedAt };
    const live = refundUnit ? null : metricFrom(data?.latest, key);
    if (live?.value != null) return { value:live.value, display:live.display, unit:live.unit, source:'罗盘实时采样' };
    return null;
  }
  async function loadAccountSummary(accountId) {
    const range = effectiveRange(), key = `${accountId}:${range.start}:${range.end}`;
    if (!accountId || accountSummaries.has(key) || summaryLoads.has(key)) return;
    summaryLoads.add(key);
    try {
      const result = await apiRequest(`/api/rpa/history-summary?account=${encodeURIComponent(accountId)}&startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`);
      accountSummaries.set(key, result);
      if (selected === accountId && $('rpaWorkspaceView')) renderWorkspaceView();
    } catch { accountSummaries.set(key, null); }
    finally { summaryLoads.delete(key); }
  }
  function currentRoomWorkspaceKey() {
    const range = effectiveRange();
    return `${selectedAccounts().map(item => item.id).join(',')}:${range.start}:${range.end}:${omitLiveRooms ? 1 : 0}:${roomSort}:${roomSortDirection}:${roomPageView}`;
  }
  async function loadRoomWorkspace() {
    const selected = selectedAccounts(), range = effectiveRange();
    if (!selected.length) { roomWorkspaceData = null; roomWorkspaceKey = currentRoomWorkspaceKey(); return; }
    const key = currentRoomWorkspaceKey();
    if (roomWorkspaceKey === key || roomWorkspaceLoadingKey === key) return;
    roomWorkspaceLoadingKey = key; roomWorkspaceError = '';
    const params = new URLSearchParams({ accounts: selected.map(item => item.id).join(','),
      startDate: range.start, endDate: range.end, omitLive: omitLiveRooms ? '1' : '0',
      sortBy: roomSort, sortDirection: roomSortDirection,
      offset: String(roomPageView * VIEW_PAGE_SIZE), limit: String(VIEW_PAGE_SIZE) });
    try {
      const data = await apiRequest(`/api/rpa/room-workspace?${params.toString()}`);
      if (key === currentRoomWorkspaceKey()) { roomWorkspaceData = data; roomWorkspaceKey = key; }
    } catch (error) {
      if (key === currentRoomWorkspaceKey()) { roomWorkspaceError = error.message; roomWorkspaceKey = key; roomWorkspaceData = null; }
    } finally {
      if (roomWorkspaceLoadingKey === key) roomWorkspaceLoadingKey = '';
      if (workspaceView === 'rooms' && key === currentRoomWorkspaceKey()) renderWorkspaceView();
    }
  }
  async function loadAllRoomsForAccount(accountId) {
    const key = `rooms:${accountId}`;
    if (roomDetails.has(key) || roomDetailLoads.has(key)) return;
    roomDetailLoads.add(key);
    const rooms = [];
    try {
      let offset = 0, hasMore = true;
      while (hasMore) {
        const page = await apiRequest(`/api/rpa/rooms?account=${encodeURIComponent(accountId)}&offset=${offset}&limit=100`);
        rooms.push(...(page.rooms || []));
        hasMore = page.hasMore === true;
        offset += page.rooms?.length || 0;
        if (!page.rooms?.length || offset >= 10000) break;
      }
      roomDetails.set(key, rooms);
    } catch { roomDetails.set(key, rooms.length ? rooms : (state?.accounts.find(item => item.id === accountId)?.rooms || [])); }
    finally { roomDetailLoads.delete(key); if (workspaceView === 'rooms') renderWorkspaceView(); }
  }
  async function loadRoomDetails(accountId, roomId) {
    const key = `detail:${accountId}:${roomId}`;
    if (roomDetails.has(key) || roomDetailLoads.has(key)) return roomDetails.get(key);
    roomDetailLoads.add(key);
    try {
      const data = await apiRequest(`/api/rpa/session?account=${encodeURIComponent(accountId)}&room=${encodeURIComponent(roomId)}`);
      roomDetails.set(key, data);
      return data;
    } catch (error) { toast(error.message); return null; }
    finally { roomDetailLoads.delete(key); if (workspaceView === 'rooms') renderWorkspaceView(); }
  }
  function summaryRoomRow(item, columns) {
    const data = accountSummaries.get(`${item.id}:${effectiveRange().start}:${effectiveRange().end}`);
    const metrics = Object.fromEntries((data?.metrics || []).map(metric => [metric.key,metric]));
    const metricCell = key => {
      const metric = metrics[historicalMetricKey(key)];
      if (!metric || metric.display === '—') return '<td><span class="rpa-missing">未采集</span></td>';
      return `<td>${esc(metric.display)}${metric.unit ? ` ${esc(metric.unit)}` : ''}<small class="rpa-coverage">覆盖 ${metric.coveredRooms}/${data.selectedRooms} 场</small></td>`;
    };
    return `<tr><td class="rpa-room-title-cell"><strong>${esc(item.name||item.label)}</strong><small>账号汇总 · ${data?.selectedRooms ?? '未采集'} 场</small></td><td>${esc(item.name || '身份未核验')}</td><td>${esc(effectiveRange().start)} 至 ${esc(effectiveRange().end)}</td>${columns.map(([key])=>metricCell(key)).join('')}<td>逐场查看</td><td>逐场查看</td><td>逐场查看</td><td>${data?`报表覆盖 ${data.reportedRooms}/${data.selectedRooms}`:'汇总读取中'}</td><td><button type="button" class="btn small" data-open-account="${esc(item.id)}">账号详情</button></td></tr>`;
  }
  function changeRange(start, end) {
    const bounds = state?.historyBounds || {};
    if (!start || !end || start > end) { toast('请选择有效日期范围'); return false; }
    if ((bounds.earliest && start < bounds.earliest) || (bounds.latest && end > bounds.latest)) {
      toast(`罗盘历史范围为 ${bounds.earliest} 至 ${bounds.latest}`); return false;
    }
    rangeStart = start; rangeEnd = end; rangePreset = 'custom';
    return true;
  }
  async function importRoomDirectories() {
    const selected = selectedAccounts(), range = effectiveRange();
    const eligible = selected.filter(item => item.uid);
    if (!eligible.length) { toast('所选账号尚未完成罗盘身份核验'); return; }
    if (!window.confirm(`将按 ${range.start} 至 ${range.end} 逐个账号读取罗盘历史场次目录，继续吗？`)) return;
    roomViewBusy = true; renderWorkspaceView();
    for (const item of eligible) {
      try {
        const history = item.history;
        let reset = !history?.uid || history.uid !== item.uid || history.startDate !== range.start || history.endDate !== range.end || history.complete;
        let progress = history;
        for (let page = 0; page < 50 && !progress?.complete; page++) {
          progress = await apiRequest(`/api/rpa/accounts/${encodeURIComponent(item.id)}/history`, {
            method:'POST', body:JSON.stringify({startDate:range.start,endDate:range.end,reset}),
          });
          reset = false;
          await refresh();
          if (progress.error || !progress.nextPage) break;
          if (!progress.complete) await new Promise(resolve => setTimeout(resolve, 800));
        }
      } catch (error) { toast(`${item.name||item.label}：${error.message}`); }
    }
    roomViewBusy = false; roomWorkspaceData = null; roomWorkspaceKey = ''; await refresh();
  }
  async function batchSyncRooms() {
    const eligible = selectedAccounts().filter(item => item.uid);
    if (!eligible.length) { toast('请先选择已核验的罗盘账号'); return; }
    const range = effectiveRange();
    if (!window.confirm(`将对 ${eligible.length} 个账号启动 ${range.start} 至 ${range.end} 的历史报表批量读取。只处理本机已保存且已结束的场次，继续吗？`)) return;
    roomViewBusy = true; renderWorkspaceView();
    for (const item of eligible) {
      try {
        await apiRequest(`/api/rpa/accounts/${encodeURIComponent(item.id)}/history-batch-start`, {method:'POST',body:JSON.stringify({startDate:range.start,endDate:range.end})});
      } catch (error) { toast(`${item.name||item.label}：${error.message}`); }
    }
    roomViewBusy = false; toast('批量历史同步已提交；进度在“罗盘连接与采集”中查看'); await refresh();
  }
  async function exportRoomRows() {
    const selected = selectedAccounts(), range = effectiveRange();
    if (!selected.length) { toast('请选择至少一个罗盘账号'); return; }
    const rows = [];
    let offset = 0, hasMore = true;
    try {
      while (hasMore) {
        const params = new URLSearchParams({ accounts:selected.map(item=>item.id).join(','),
          startDate:range.start, endDate:range.end, omitLive:omitLiveRooms?'1':'0', offset:String(offset), limit:'100' });
        params.set('sortBy', roomSort); params.set('sortDirection', roomSortDirection);
        const page = await apiRequest(`/api/rpa/room-workspace?${params.toString()}`);
        rows.push(...(page.rooms || []));
        offset += page.rooms?.length || 0;
        hasMore = page.hasMore === true;
        if ((hasMore && !page.rooms?.length) || rows.length > 100000) throw new Error('导出场次超过本机导出上限');
      }
    } catch (error) { toast(`导出失败：${error.message}`); return; }
    const columns = customMetrics.map(key=>ROOM_METRICS.find(metric=>metric[0]===key)).filter(Boolean);
    const header = ['直播间','账号','场次 ID','状态','开播时间','时长',...columns.map(([,label])=>label),'字段来源'];
    const output = rows.map(item => {
      const values = columns.map(([key])=>roomMetricValue(item,key)?.display ?? '');
      const duration = item.startedAt && item.endedAt ? `${Math.max(0,Math.round((Date.parse(item.endedAt)-Date.parse(item.startedAt))/60000))} 分钟` : '';
      const sources = columns.map(([key])=>roomMetricValue(item,key)?.source || '未采集').join('; ');
      return [item.title,item.accountName,item.id,roomState(item),item.startedAt||'',duration,...values,sources];
    });
    downloadCsv('我的直播间.csv',[header,...output]); toast(`${rows.length} 场目录已导出；未采集字段保持为空`);
  }
  function chooseCustomMetrics() {
    openModal('自定义指标', `<div class="rpa-metric-choices">${ROOM_METRICS.map(([key,label,unit])=>`<label><input type="checkbox" name="rpaCustomMetric" value="${key}" ${customMetrics.includes(key)?'checked':''}><span>${esc(label)}${unit?` · ${esc(unit)}`:''}</span></label>`).join('')}</div><p class="rpa-note">消耗对账在官方字段核验前显示“未采集”。</p>`, '<button class="btn" id="rpaMetricCancel">取消</button><button class="btn primary" id="rpaMetricSave">应用</button>');
    $('rpaMetricCancel').onclick = closeModal;
    $('rpaMetricSave').onclick = () => {
      const choices = [...document.querySelectorAll('input[name="rpaCustomMetric"]:checked')].map(input=>input.value);
      customMetrics = choices.length ? choices : ['pay_amt']; closeModal(); renderWorkspaceView();
    };
  }
  function ensureWorkspaceShell() {
    if ($('rpaWorkspaceView')) return;
    $('rpaWorkspace').innerHTML = `<div class="rpa-workspace-shell"><nav class="rpa-view-tabs" role="tablist" aria-label="直播账号与场次"><button type="button" role="tab" data-rpa-view="accounts" aria-selected="false">我的直播号</button><button type="button" role="tab" data-rpa-view="rooms" aria-selected="false">我的直播间</button><button type="button" role="tab" data-rpa-view="settings" aria-selected="false">账号连接与采集</button></nav><div id="rpaWorkspaceView"></div></div>`;
    renderedAccount = '';
  }
  function renderWorkspaceView() {
    ensureWorkspaceShell();
    document.querySelectorAll('[data-rpa-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.rpaView === workspaceView)));
    if (workspaceView === 'settings') {
      const host = $('rpaWorkspaceView');
      if (!$('rpaLegacyHost')) host.innerHTML = `<section class="rpa-provider-section"><div class="rpa-provider-heading"><div><h2>数据源账号</h2><p>两个平台分别登录；官网会话保存在本机，失效后需重新登录。同场消耗按采样结果对账。</p></div></div><div class="rpa-provider-grid"><article class="rpa-provider-card"><div class="rpa-provider-card-head"><span class="rpa-provider-mark compass-mark">罗</span><div><strong>电商罗盘</strong><small>直播场次与经营数据</small></div><span class="rpa-provider-state ready">支持采集</span></div><p>打开罗盘官网，在独立浏览器窗口选择密码或扫码登录。登录后会保留在该账号的本机会话中。</p><button type="button" class="btn small" data-rpa-action="connect">连接罗盘账号</button></article><article class="rpa-provider-card"><div class="rpa-provider-card-head"><span class="rpa-provider-mark qianchuan-mark">川</span><div><strong>巨量千川</strong><small>广告账户与消耗报表</small></div><span class="rpa-provider-state ready">按场次采集</span></div><p>打开千川官网选择密码或扫码登录，状态保留在独立本机会话中；失效后重新登录。已接入同场消耗报表，登录或当前户失效时停止赋值。</p><button type="button" class="btn small" data-qianchuan-login>打开千川登录</button></article></div></section><div id="rpaLegacyHost"></div>`;
      const card = host.querySelector('.qianchuan-mark').closest('.rpa-provider-card');
      if (!card.querySelector('.rpa-qianchuan-login'))
        card.querySelector('p').insertAdjacentHTML('afterend', `<div class="rpa-qianchuan-login"><span>登录状态</span><span class="rpa-provider-state ${qianchuanState === 'logged_in' ? 'ready' : 'pending'}">${qianchuanLabels[qianchuanState]}</span></div>`);
      if (!card.querySelector('[data-qianchuan-check]'))
        card.querySelector('[data-qianchuan-login]').insertAdjacentHTML('afterend', '<button type="button" class="btn small" data-qianchuan-check>完成登录后检查</button>');
      renderQianchuanAccount(card);
      renderLegacy();
      return;
    }
    renderedAccount = '';
    if (workspaceView === 'rooms') renderRoomView();
    else renderAccountView();
  }
  function accountRoomCount(item, start, end) {
    const count = (item.rooms || []).filter(entry => {
      const day = dateKey(entry.startedAt);
      return entry.state !== 'unknown' && !!day && day >= start && day <= end;
    }).length;
    const complete = item.history?.complete && item.history.startDate <= start && item.history.endDate >= end &&
      (item.history.total == null || item.history.total <= (item.rooms || []).length);
    return {count, complete, hasDirectory:!!item.history || (item.rooms || []).length > 0};
  }
  function renderAccountView() {
    const accounts = (state?.accounts || []).filter(item => platformFilter === 'all' || platformFilter === 'douyin_ecom');
    const { start, end } = effectiveRange();
    const picked = account();
    const key = picked ? `${picked.id}:${start}:${end}` : '';
    const summary = accountSummaries.get(key);
    const byKey = Object.fromEntries((summary?.metrics || []).map(item => [item.key, item]));
    const cardRooms = picked?.rooms || [];
    const recent = cardRooms.filter(entry => { const day = dateKey(entry.startedAt); return day && day >= addDays(localISODate(new Date()), -29) && day <= localISODate(new Date()); });
    const daily = new Map();
    for (const entry of cardRooms) { const day = dateKey(entry.startedAt); if (day && day >= start && day <= end) daily.set(day, (daily.get(day) || 0) + 1); }
    const days = [];
    for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
    const maxDay = Math.max(1, ...days.map(day => daily.get(day) || 0));
    const chart = chartMode === 'chart' ? `<div class="rpa-activity-chart" role="img" aria-label="所选日期范围内本机已保存场次数量">${days.slice(-31).map(day => `<div class="rpa-activity-day" title="${esc(day)} · ${daily.get(day) || 0} 场"><span style="--bar:${Math.max(3,((daily.get(day)||0)/maxDay)*100)}%"></span><small>${esc(day.slice(5))}</small></div>`).join('')}</div><p class="rpa-note">趋势按本机已保存场次目录计数，不代表完整开播数据；最近 100 场以外的日期可能未载入。</p>` : `<div class="table-wrap"><table><thead><tr><th>日期</th><th>开播场次</th><th>状态</th></tr></thead><tbody>${[...daily.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([day,count]) => `<tr><td>${esc(day)}</td><td>${count}</td><td>罗盘目录</td></tr>`).join('') || '<tr><td colspan="3">该范围内没有已保存场次</td></tr>'}</tbody></table></div>`;
    const metricTile = (label, item, unit, missingNote='该接口未返回') => `<div class="rpa-overview-stat"><span>${esc(label)}</span><strong>${item && item.display !== '—' ? `${esc(item.display)}${item.unit ? ` ${esc(item.unit)}` : unit ? ` ${esc(unit)}` : ''}` : '<i>未采集</i>'}</strong>${item ? `<small>覆盖 ${item.coveredRooms}/${summary?.selectedRooms || 0} 场</small>` : `<small>${esc(missingNote)}</small>`}</div>`;
    $('rpaWorkspaceView').innerHTML = `<div class="rpa-view-head"><div><h2>我的直播号</h2><p>查看已连接的罗盘账号、近 30 天场次与经营汇总。</p></div><button class="btn primary" data-rpa-action="connect">＋ 添加直播号</button></div><div class="rpa-platform-tabs" role="group" aria-label="平台筛选">${PLATFORM_FILTERS.map(([id,label])=>`<button type="button" data-platform="${id}" aria-pressed="${platformFilter===id}">${esc(label)}</button>`).join('')}</div><div class="rpa-accounts-board"><div class="rpa-account-cards">${accounts.map(item => { const count=accountRoomCount(item,addDays(localISODate(new Date()),-29),localISODate(new Date())); return `<button type="button" class="rpa-account-card ${item.id===selected?'selected':''}" data-rpa-account="${esc(item.id)}"><span class="rpa-platform-mark">抖</span><strong>${esc(item.name || item.label)}</strong>${chip(item)}<small>${count.complete ? `近 30 天开播 ${count.count} 场` : count.hasDirectory ? `本机目录已保存 ${count.count} 场` : '场次目录未导入'}</small><small>${item.observedName ? '已现场核验' : '等待现场核验'}</small></button>`; }).join('')}${!accounts.length ? `<div class="rpa-account-empty">${state?.accounts.length ? '当前筛选平台还没有接入账号。' : '还没有接入直播号。点击“添加直播号”后，在罗盘登录完成授权。'}</div>` : ''}<button type="button" class="rpa-add-card" data-rpa-action="connect">＋ 添加直播号</button></div><section class="panel rpa-account-summary"><div class="panel-head"><div><div class="panel-title">直播数据概览</div><div class="panel-subtitle">${esc(picked?.name || picked?.label || '选择一个已连接账号')} · 仅展示已授权罗盘返回的数据</div></div><div class="rpa-toolbar-compact">${[['today','今日'],['yesterday','昨日'],['7','7日'],['30','30日'],['week','本周'],['month','本月']].map(([id,label])=>`<button type="button" data-range-preset="${id}" aria-pressed="${rangePreset===id}">${label}</button>`).join('')}<label>从<input type="date" data-range-start value="${esc(start)}"></label><label>至<input type="date" data-range-end value="${esc(end)}"></label></div></div><div class="rpa-overview-stats"><div class="rpa-overview-stat"><span>开播场次</span><strong>${summary ? summary.selectedRooms : '<i>未采集</i>'}</strong><small>结束场次目录 · ${esc(start)} 至 ${esc(end)}</small></div>${metricTile('进入直播间人次',byKey.watch_ucnt,'人次','历史详情未读取')}${metricTile('成交订单',byKey.t7payin8d_predstl_ord_cnt,'单','历史详情未读取')}${metricTile('结算成交金额',byKey.t7payin8d_predstl_ord_amt,'元','历史详情未读取')}<div class="rpa-overview-stat"><span>巨量千川消耗</span><strong><i>—</i></strong><small>以本轮同场采样为准</small></div></div><div class="rpa-heading rpa-overview-heading"><div><h3>场次趋势与直播间预览</h3><span class="rpa-note">${esc(start)} 至 ${esc(end)} · 目录 ${picked?.rooms?.length || 0} 场 · 近 30 天目录 ${recent.length} 场</span></div><div class="rpa-heading-actions"><button type="button" class="btn small" data-chart-mode="chart" aria-pressed="${chartMode==='chart'}">趋势</button><button type="button" class="btn small" data-chart-mode="list" aria-pressed="${chartMode==='list'}">列表</button><button type="button" class="btn small" data-rpa-view="rooms">查看直播间</button></div></div>${summary ? chart : '<div class="rpa-data-empty">正在读取本机已保存历史汇总…</div>'}<div class="rpa-room-preview"><div class="rpa-room-preview-title">最近直播间 <button type="button" class="btn text" data-rpa-view="rooms">全部场次 →</button></div>${[...cardRooms].sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||''))).slice(0,5).map(entry=>`<button type="button" class="rpa-preview-row" data-room-detail="${esc(entry.id)}" data-room-account="${esc(picked.id)}"><span><strong>${esc(entry.title || `直播场次 ${entry.id}`)}</strong><small>${esc(entry.startedAt ? date(entry.startedAt) : '开播时间未返回')} · ${roomState(entry)}</small></span><span>查看详情 →</span></button>`).join('') || '<div class="rpa-data-empty">本机暂未保存直播场次。可在“罗盘连接与采集”同步今日场次，或导入历史目录。</div>'}</div><p class="rpa-note">数据来源：电商罗盘本机登录态 · 历史汇总覆盖 ${summary?.completeRooms ?? 0}/${summary?.selectedRooms ?? '—'} 场完整报表。已采集指标按罗盘实际来源展示；以本轮同场采样为准。</p></section></div>`;
    if (picked && !summary && !summaryLoads.has(key)) loadAccountSummary(picked.id);
  }
  function renderRoomView() {
    const selected = selectedAccounts();
    const start = effectiveRange().start, end = effectiveRange().end;
    const requestedKey = currentRoomWorkspaceKey();
    const workspace = roomWorkspaceKey === requestedKey ? roomWorkspaceData : null;
    const rows = workspace?.rooms || allVisibleRooms();
    const totalRows = workspace?.total ?? allVisibleRooms().length;
    const keys = customMetrics;
    const limited = workspace ? rows : rows.slice(roomPageView * VIEW_PAGE_SIZE, (roomPageView + 1) * VIEW_PAGE_SIZE);
    const summary = selected.map(item => accountSummaries.get(`${item.id}:${start}:${end}`)).filter(Boolean);
    const totalRoomCount = workspace?.total ?? summary.reduce((sum,item)=>sum+item.selectedRooms,0);
    const sumMetric = key => {
      const aggregateKey = ({watch_ucnt:'entryVisits',t7payin8d_predstl_ord_cnt:'validOrders',t7payin8d_predstl_ord_amt:'validSales'})[key];
      const aggregate = aggregateKey ? workspace?.totals?.[aggregateKey] : null;
      if (aggregate) return aggregate.value == null ? '<i>未采集</i>' : `${esc(aggregate.display)}${aggregate.unit ? ` ${esc(aggregate.unit)}` : ''}`;
      const items = summary.flatMap(item=>item.metrics).filter(item=>item.key===key&&item.display!=='—');
      if (!items.length) return '<i>未采集</i>';
      const values = items.map(item=>Number(String(item.display).replaceAll(',',''))).filter(Number.isFinite);
      if (values.length !== items.length) return '<i>未采集</i>';
      return values.reduce((sum,value)=>sum+value,0).toLocaleString('zh-CN',{maximumFractionDigits:2});
    };
    const columns = keys.map(key => ROOM_METRICS.find(item=>item[0]===key)).filter(Boolean);
    const displayedRows = aggregationMode === 'account' ? selected : limited;
    const tableRows = aggregationMode === 'account' ? displayedRows.map(item=>summaryRoomRow(item,columns)) : displayedRows.map(item=>roomTableRow(item, columns));
    const sessionTile = workspace ? workspace.total : summary.length ? totalRoomCount : totalRows;
    $('rpaWorkspaceView').innerHTML = `<div class="rpa-view-head"><div><h2>我的直播间</h2><p>按账号与日期筛选本机已保存的直播场次，查看可用指标和同步进度。</p></div><div class="rpa-heading-actions"><button type="button" class="btn" data-rpa-action="rooms-import" ${roomViewBusy?'disabled':''}>导入历史目录</button><button type="button" class="btn" data-rpa-action="rooms-refresh" ${roomViewBusy?'disabled':''}>刷新目录</button><button type="button" class="btn" data-rpa-action="rooms-export">导出数据</button><button type="button" class="btn" data-rpa-action="custom-metrics">自定义指标</button><button type="button" class="btn primary" data-rpa-action="rooms-batch" ${roomViewBusy?'disabled':''}>RPA 数据批量同步</button></div></div><section class="panel rpa-room-filters"><div class="rpa-room-filter-row"><label>平台<select data-room-platform><option value="all">全部平台</option><option value="douyin_ecom" selected>抖音电商 · 罗盘</option><option value="douyin_local">抖音本地生活</option><option value="kuaishou">快手</option><option value="video_account">视频号</option><option value="xiaohongshu">小红书</option></select></label><div class="rpa-date-controls">${[['today','今日'],['yesterday','昨日'],['7','7日'],['30','30日'],['week','本周'],['month','本月']].map(([id,label])=>`<button type="button" data-range-preset="${id}" aria-pressed="${rangePreset===id}">${label}</button>`).join('')}<label>从<input type="date" data-range-start value="${esc(start)}"></label><label>至<input type="date" data-range-end value="${esc(end)}"></label></div><label class="rpa-inline-check"><input type="checkbox" data-omit-live ${omitLiveRooms?'checked':''}>不看直播中</label><label>汇总模式<select data-aggregation><option value="exact" ${aggregationMode==='exact'?'selected':''}>逐场数据</option><option value="account" ${aggregationMode==='account'?'selected':''}>按账号汇总</option></select></label></div><div class="rpa-room-account-picks"><label><input type="checkbox" data-select-all-accounts ${selected.length===state.accounts.length&&state.accounts.length?'checked':''}>全选账号（${state.accounts.length}）</label>${state.accounts.map(item=>`<label><input type="checkbox" data-room-account-check="${esc(item.id)}" ${roomAccounts.has(item.id)?'checked':''}><span>${esc(item.name||item.label)}</span>${chip(item)}</label>`).join('')}</div></section><div class="rpa-overview-stats rpa-room-total-stats"><div class="rpa-overview-stat"><span>${aggregationMode==='account'?'结束场次':'目录场次'}</span><strong>${sessionTile || 0}</strong><small>${workspace ? `${workspace.total} 场符合筛选` : summary.length ? `${totalRoomCount} 场有历史报表范围` : '本机已保存场次目录'}</small></div><div class="rpa-overview-stat"><span>进入直播间人次</span><strong>${sumMetric('watch_ucnt')}</strong><small>按场相加，非去重人数</small></div><div class="rpa-overview-stat"><span>成交订单</span><strong>${sumMetric('t7payin8d_predstl_ord_cnt')}</strong><small>${workspace?.totals?.validOrders ? `覆盖 ${workspace.totals.validOrders.coveredRooms}/${workspace.totals.validOrders.selectedRooms} 场` : '结算有效订单'}</small></div><div class="rpa-overview-stat"><span>结算成交金额</span><strong>${sumMetric('t7payin8d_predstl_ord_amt')}</strong><small>${workspace?.totals?.validSales ? `覆盖 ${workspace.totals.validSales.coveredRooms}/${workspace.totals.validSales.selectedRooms} 场` : '结算有效成交金额'}</small></div><div class="rpa-overview-stat"><span>千川消耗</span><strong><i>—</i></strong><small>等待官方字段与场次关联核验</small></div></div><div class="rpa-room-list-head"><h3>直播间列表 <span>${aggregationMode==='account'?`${selected.length} 个账号`:workspace ? `${workspace.total} 场` : `${totalRows} 场`}</span></h3><label class="rpa-inline-check"><input type="checkbox" data-exact-values ${exactValues?'checked':''}>查看精确值</label><span>目录来源：罗盘本机已保存场次</span></div><div class="table-wrap rpa-room-table-wrap"><table class="rpa-room-table"><thead><tr><th>${aggregationMode==='account'?'账号':'直播间'}</th><th>${aggregationMode==='account'?'达人':'账号'}</th><th>${aggregationMode==='account'?'统计范围':'开播时间 / 时长'}</th>${columns.map(item=>`<th>${esc(item[1])}</th>`).join('')}<th>采集状态</th><th>操作</th></tr></thead><tbody>${tableRows.join('') || `<tr><td colspan="${columns.length+5}"><div class="rpa-data-empty">${roomWorkspaceError?esc(roomWorkspaceError):workspace ? (selected.length?'当前条件下没有已保存场次。可在“罗盘连接与采集”导入历史场次目录。':'请选择至少一个罗盘账号。') : '正在读取本机直播间数据…'}</div></td></tr>`}</tbody></table></div>${aggregationMode==='exact'?`<div class="rpa-room-pagination"><span>显示 ${workspace ? (rows.length ? workspace.offset+1 : 0) : rows.length?roomPageView*VIEW_PAGE_SIZE+1:0}–${workspace ? Math.min(workspace.offset+rows.length,workspace.total) : Math.min((roomPageView+1)*VIEW_PAGE_SIZE,rows.length)} / ${workspace?.total ?? totalRows}</span><button class="btn small" type="button" data-room-page="prev" ${roomPageView===0?'disabled':''}>上一页</button><button class="btn small" type="button" data-room-page="next" ${(workspace ? !workspace.hasMore : (roomPageView+1)*VIEW_PAGE_SIZE>=totalRows)?'disabled':''}>下一页</button></div>`:''}<p class="rpa-note">日期范围：${esc(start)} 至 ${esc(end)}。历史金额、订单及进入人次来自罗盘历史详情报表；实时数据来自最近本机采样。缺失字段显示“未采集”。消耗按本机同场采样更新；去重观看人数当前未采集。列表只展示已保存到本机的数据。</p>`;
    const spendHeaders = ['罗盘消耗', '千川消耗', '对账状态'];
    const headerRow = $('rpaWorkspaceView').querySelector('.rpa-room-table thead tr');
    const statusHeader = headerRow?.children[headerRow.children.length - 2];
    for (const label of spendHeaders) statusHeader?.insertAdjacentHTML('beforebegin', `<th>${label}</th>`);
    const emptyCell = $('rpaWorkspaceView').querySelector('.rpa-room-table tbody td[colspan]');
    if (emptyCell) emptyCell.colSpan += spendHeaders.length;
    if (aggregationMode === 'exact') {
      const headers = [...document.querySelectorAll('.rpa-room-table thead th')];
      const specs = [['title','直播间'],['accountName','账号'],['startedAt','开播时间 / 时长'],...columns.map(([key,label])=>[key,label])];
      const button = (key,label) => `<button type="button" class="rpa-sort-button" data-room-sort="${esc(key)}" aria-label="按${esc(label)}排序" aria-sort="${roomSort===key?(roomSortDirection==='asc'?'ascending':'descending'):'none'}">${esc(label)} <span aria-hidden="true">${roomSort===key?(roomSortDirection==='asc'?'↑':'↓'):'↕'}</span></button>`;
      specs.forEach(([key,label], index) => { if (headers[index]) headers[index].innerHTML = button(key,label); });
    }
    const batchButton = $('rpaWorkspaceView').querySelector('[data-rpa-action="rooms-batch"]');
    if (batchButton) batchButton.textContent = '批量读取历史报表';
    const platformSelect = $('rpaWorkspaceView').querySelector('[data-room-platform]');
    if (platformSelect) platformSelect.value = roomPlatformFilter;
    for (const item of selected) if (!accountSummaries.has(`${item.id}:${start}:${end}`) && !summaryLoads.has(`${item.id}:${start}:${end}`)) loadAccountSummary(item.id);
    if (!workspace && !roomWorkspaceError) loadRoomWorkspace();
  }
  function roomTableRow(item, columns) {
    const duration = item.startedAt && item.endedAt ? `${Math.max(0,Math.round((Date.parse(item.endedAt)-Date.parse(item.startedAt))/60000))} 分钟` : '未采集';
    const statusText = item.historyReport ? '历史报表已读取' : item.latest ? `实时采样 ${date(item.latest.time)}` : '目录已保存';
    const spend = item.spendReconciliation;
    const spendCell = (side, reason) => side && side.roomId === item.id ?
      `<td>${esc(side.display)} ${esc(side.unit)}<small>${esc(date(side.time))}</small></td>` :
      `<td><span class="rpa-missing">未采集</span>${reason ? `<small>${esc(reason)}</small>` : ''}</td>`;
    const status = ({ '匹配':'匹配', '不匹配':'不匹配', '缺一边':'缺一边',
      '尚未采集':'尚未采集' })[spend?.status] || '尚未采集';
    return `<tr><td class="rpa-room-title-cell"><strong>${esc(item.title || `直播场次 ${item.id}`)}</strong><small>${roomState(item)} · ${esc(item.id)}</small></td><td>${esc(item.accountName)}</td><td>${esc(item.startedAt?date(item.startedAt):'未采集')}<small>${duration}</small></td>${columns.map(([key])=>`<td>${formatRoomMetric(item,key)}</td>`).join('')}${spendCell(spend?.compass,spend?.reasons?.compass)}${spendCell(spend?.qianchuan,spend?.reasons?.qianchuan)}<td>${esc(status)}${spend?.reason ? `<small>${esc(spend.reason)}</small>` : ''}</td><td>${esc(statusText)}</td><td><button type="button" class="btn small" data-room-detail="${esc(item.id)}" data-room-account="${esc(item.accountId)}">详情</button></td></tr>`;
  }

  function render() {
    ensureWorkspaceShell();
    if (state.accounts.length && !account()) selected = state.accounts[0].id;
    renderIdentity();
    if (!state.accounts.length && workspaceView !== 'settings') {
      $('rpaWorkspaceView').innerHTML = `<div class="panel rpa-empty"><div class="rpa-emblem"><svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true"><circle cx="17" cy="17" r="14" stroke="currentColor" stroke-width="1.5"/><path d="m22 11-3 8-8 4 3-9 8-3Z" stroke="currentColor" stroke-width="1.5"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg></div><h2>把直播经营数据接回操盘台</h2><p>连接你有权限查看的罗盘账号，即可在“我的直播号”和“我的直播间”中查看本机采集到的场次与数据。</p><button class="btn primary" data-rpa-action="connect">连接第一个罗盘账号</button><div class="rpa-steps"><span><b>1</b>打开罗盘</span><span><b>2</b>官网登录</span><span><b>3</b>同步数据</span></div></div>`;
      document.querySelectorAll('[data-rpa-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.rpaView === workspaceView)));
      return;
    }
    if (state.accounts.length) localStorage.setItem('rpaAccount', selected);
    renderWorkspaceView();
  }
  function renderIdentity() {
    const host = $('rpaIdentity');
    if (!host) return;
    if (!host.querySelector('[data-rpa-target-form]')) host.innerHTML = `<div class="rpa-identity-head"><strong>罗盘账号校正</strong><span data-rpa-identity-status role="status"></span></div><div class="rpa-identity-grid"><div><span>当前直播号</span><strong data-rpa-target-name></strong></div><div><span>当前千川户</span><strong data-rpa-qianchuan-name></strong></div><div><span>当前罗盘实际登录的达人</span><strong data-rpa-observed-name></strong></div></div><p data-rpa-identity-message></p><form data-rpa-target-form class="rpa-target-form"><label>指定当前直播号<input name="name" type="text" maxlength="80" autocomplete="off" required></label><button type="submit" class="btn small">保存直播号</button></form><div class="rpa-identity-actions"><button type="button" class="btn small" data-rpa-action="login">打开罗盘 / 登录</button><button type="button" class="btn small" data-rpa-action="verify">核验当前达人</button><button type="button" class="btn small" data-rpa-action="confirm-target" data-rpa-confirm-target hidden>将核验达人设为当前直播号</button></div>`;
    const a = account(), target = state.targetName || '';
    const recentlyVerified = !!a?.verifiedAt && Date.now() >= Date.parse(a.verifiedAt) && Date.now() - Date.parse(a.verifiedAt) <= 5 * 60 * 1000;
    const observed = recentlyVerified ? a.observedName || '' : '';
    const match = !!target && !!observed && target === observed;
    const mismatch = !!target && !!observed && !match;
    host.classList.toggle('mismatch', mismatch);
    host.querySelector('[data-rpa-target-name]').textContent = target || '尚未指定';
    host.querySelector('[data-rpa-qianchuan-name]').textContent = qianchuanAccount?.name || '尚未指定';
    host.querySelector('[data-rpa-observed-name]').textContent = observed || '尚未现场核验';
    host.querySelector('[data-rpa-identity-status]').textContent = match ? '身份一致' : mismatch ? '身份不一致，自动同步禁止' : '等待校正';
    const oldName = (a?.observedName || a?.name) && !observed ? `上次保存的达人名称是「${a.observedName || a.name}」，不能代替现场核验。` : '';
    host.querySelector('[data-rpa-identity-message]').textContent = mismatch ? `罗盘登录的是「${observed}」，但当前直播号是「${target}」。请在罗盘窗口切换达人后重新核验。` : match ? `已核验「${observed}」与当前直播号一致。${qianchuanAccount?.name ? `请确认千川户「${qianchuanAccount.name}」属于同一条线。` : '千川当前户尚未指定，请先核对。'}` : !target ? `请先指定当前直播号。${oldName}` : `请打开罗盘窗口并核验当前登录达人。${oldName}`;
    const field = host.querySelector('[data-rpa-target-form] input');
    if (document.activeElement !== field) field.value = target;
    host.querySelector('[data-rpa-confirm-target]').hidden = !observed || match;
    host.querySelector('[data-rpa-confirm-target]').disabled = !a || !a.verifiedAt || a.observedUidMatchesStored === false || Date.now() - Date.parse(a.verifiedAt) > 5 * 60 * 1000;
    host.querySelector('[data-rpa-action="verify"]').disabled = !a || actionBusy;
    host.querySelector('[data-rpa-action="login"]').disabled = !a || actionBusy;
  }
  function renderLegacy() {
    if (!state?.accounts.length) return;
    if (!account()) selected = state.accounts[0].id;
    const a = account();
    if (renderedAccount !== selected || !$('rpaAccountList')) {
      const bounds = state.historyBounds || { earliest: '', latest: '' };
      const startDate = a.history?.startDate || bounds.earliest, endDate = a.history?.endDate || bounds.latest;
      $('rpaLegacyHost').innerHTML = `<div class="rpa-layout"><aside class="panel"><div class="panel-head"><div class="panel-title">已连接账号</div><span class="panel-subtitle">本机保存</span></div><div id="rpaAccountList"></div></aside><div class="rpa-main"><section class="panel"><div class="rpa-toolbar"><button class="btn" data-rpa-action="login">打开罗盘 / 登录</button><button class="btn primary" data-rpa-action="sync" id="rpaSync">立即同步</button><button class="btn" data-rpa-action="monitor" id="rpaToggle">暂停同步</button><label for="rpaInterval">同步间隔</label><select id="rpaInterval" aria-label="同步间隔"><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option></select></div><div id="rpaAccountError"></div><div class="rpa-meta" id="rpaMeta"></div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">历史场次目录</div><div class="panel-subtitle">罗盘近 90 天 · 每次读取 10 场</div></div><button class="btn small" data-rpa-action="history" id="rpaHistory">导入历史场次</button></div><div class="panel-body"><div class="rpa-history-dates"><label for="rpaHistoryStart">开始日期<input id="rpaHistoryStart" type="date" min="${esc(bounds.earliest)}" max="${esc(bounds.latest)}" value="${esc(startDate)}"></label><label for="rpaHistoryEnd">结束日期<input id="rpaHistoryEnd" type="date" min="${esc(bounds.earliest)}" max="${esc(bounds.latest)}" value="${esc(endDate)}"></label></div><div class="rpa-note" id="rpaHistoryStatus"></div><p class="rpa-note">此处只导入场次目录。选择已结束场次后，可单独读取历史指标；历史报表写入飞书由下方独立开关控制。</p></div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">直播场次</div><div class="panel-subtitle">今日发现与本机历史记录</div></div><button class="btn small" data-rpa-action="export" id="rpaExport" disabled>导出本场数据</button></div><div class="panel-body"><label for="rpaRoom" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">选择直播场次</label><select id="rpaRoom" class="rpa-room-picker"></select><div class="review-link-page"><button class="btn small" id="rpaRoomsPrev" type="button">上一页</button><span class="rpa-note" id="rpaRoomsPage"></span><button class="btn small" id="rpaRoomsNext" type="button">下一页</button></div><div id="rpaDetail"></div></div></section><section class="panel"><div class="panel-head"><div class="panel-title">同步记录</div><div class="panel-subtitle">最近 30 条</div></div><div class="rpa-events" id="rpaEvents"></div></section></div></div>`;
      $('rpaHistoryStatus').closest('section').insertAdjacentHTML('afterend', `<section class="panel"><div class="panel-head"><div><div class="panel-title">历史报表批量回填</div><div class="panel-subtitle">已保存的结束场次</div></div><div class="rpa-batch-actions"><button class="btn small" id="rpaBatchStart" data-rpa-action="history-batch-start" type="button">开始回填</button><button class="btn small" id="rpaBatchPause" data-rpa-action="history-batch-pause" type="button" hidden>暂停</button></div></div><div class="panel-body"><div class="rpa-note" id="rpaBatchStatus"></div></div></section>`);
      $('rpaBatchStatus').closest('section').insertAdjacentHTML('afterend', '<section class="panel"><div class="panel-head"><div class="panel-title">历史经营汇总</div><div class="panel-subtitle">本机已保存报表</div></div><div class="panel-body" id="rpaHistorySummary">读取中…</div></section>');
      renderedAccount = selected; currentDetail = null;
      $('rpaInterval').addEventListener('change', () => act('settings', { interval: Number($('rpaInterval').value) }));
      $('rpaRoom').addEventListener('change', () => { room = $('rpaRoom').value; loadDetail(); });
      $('rpaRoomsPrev').addEventListener('click', () => { if (roomPage > 0) { roomPage--; loadRooms(); } });
      $('rpaRoomsNext').addEventListener('click', () => { if (roomList?.hasMore) { roomPage++; loadRooms(); } });
      $('rpaHistoryStart').addEventListener('change', () => { render(); loadSummary(); });
      $('rpaHistoryEnd').addEventListener('change', () => { render(); loadSummary(); });
    }
    $('rpaAccountList').innerHTML = state.accounts.map(item => `<button class="rpa-account ${item.id === selected ? 'selected' : ''}" data-rpa-account="${esc(item.id)}"><strong>${esc(item.name || item.label)}</strong>${chip(item)}<small>${item.observedName ? '已现场核验' : '等待现场核验'}<br>最近同步 ${date(item.lastSync)}</small></button>`).join('');
    const limitedUntil = retryAfter(a);
    const identityMatches = !!state.targetName && a.observedName === state.targetName && !!a.verifiedAt &&
      Date.now() >= Date.parse(a.verifiedAt) && Date.now() - Date.parse(a.verifiedAt) <= 5 * 60 * 1000;
    $('rpaSync').disabled = !identityMatches || a.busy || a.historyBusy || actionBusy || !!limitedUntil;
    $('rpaSync').textContent = a.busy ? '正在同步…' : '立即同步';
    $('rpaToggle').textContent = a.enabled ? '暂停同步' : '开启同步';
    $('rpaToggle').disabled = !a.enabled && !identityMatches || actionBusy;
    if (document.activeElement !== $('rpaInterval')) $('rpaInterval').value = String(a.interval);
    $('rpaAccountError').innerHTML = a.error ? `<div class="rpa-account-error">${esc(a.error)}</div>` : '';
    $('rpaMeta').innerHTML = `<span>最近检查 ${date(a.lastCheck)}</span><span>最近成功同步 ${date(a.lastSync)}</span><span>${a.enabled ? '自动同步已开启' : '自动同步已暂停'}</span>${limitedUntil ? `<span>请求受限，可重试时间 ${date(limitedUntil)}</span>` : ''}`;
    const history = a.history;
    const selectedStart = $('rpaHistoryStart').value, selectedEnd = $('rpaHistoryEnd').value;
    const rangeChanged = !history?.uid || history.uid !== a.uid ||
      history.startDate !== selectedStart || history.endDate !== selectedEnd;
    $('rpaHistoryStart').disabled = a.historyBusy || actionBusy;
    $('rpaHistoryEnd').disabled = a.historyBusy || actionBusy;
    $('rpaHistory').disabled = !a.uid || a.busy || a.historyBusy || actionBusy || !!limitedUntil ||
      !selectedStart || !selectedEnd || selectedStart > selectedEnd;
    $('rpaHistory').textContent = a.historyBusy ? '正在读取…' : rangeChanged || history?.complete ? '按日期重新读取' : history?.nextPage > 1 ? '读取下一页' : '导入所选日期';
    $('rpaHistoryStatus').textContent = selectedStart > selectedEnd ? '开始日期不能晚于结束日期。' : history ?
      `${history.startDate || '旧版范围'} 至 ${history.endDate || '旧版范围'}：已查看 ${history.scanned} 场，范围内新增 ${history.imported} 场${history.total == null ? '' : `，罗盘共 ${history.total} 场`}。${history.outsideRange ? `${history.outsideRange} 场在范围外；` : ''}${history.unknownDates ? `${history.unknownDates} 场日期无法判定；` : ''}${history.complete ? history.truncated ? '已达到 500 场上限，结果可能不完整。' : '目录读取完成。' : `下一页：${history.nextPage}。`}${history.error ? `最近错误：${history.error}` : ''}` : a.uid ? '尚未读取历史场次。' : '完成账号身份核验后可读取。';
    const batch = a.historyBatch;
    const batchRunning = batch?.status === 'running';
    const batchResume = batch?.uid === a.uid && batch.startDate === selectedStart &&
      batch.endDate === selectedEnd && ['paused', 'error', 'rate_limited'].includes(batch.status);
    $('rpaBatchStart').dataset.rpaAction = batchResume ? 'history-batch-resume' : 'history-batch-start';
    $('rpaBatchStart').textContent = batchResume ? '继续回填' : batchRunning ? '正在回填…' : '回填所选日期';
    $('rpaBatchStart').disabled = !a.uid || a.busy || a.historyBusy || actionBusy || !!limitedUntil ||
      !selectedStart || !selectedEnd || selectedStart > selectedEnd ||
      (batchResume && batch.retryAfter && Date.now() < Date.parse(batch.retryAfter));
    $('rpaBatchPause').hidden = !batchRunning;
    $('rpaBatchPause').disabled = actionBusy;
    $('rpaBatchStatus').textContent = batch ?
      `${batch.startDate} 至 ${batch.endDate}：已处理 ${batch.nextIndex}/${batch.roomIds.length} 场，成功 ${batch.succeeded} 场，部分 ${batch.partial} 场，失败 ${batch.failed} 场，跳过已有完整报表 ${batch.skippedExisting + batch.skippedOnResume} 场。${batch.status === 'running' ? '正在后台读取。' : batch.status === 'completed' ? '本轮完成。' : '已暂停。'}${batch.retryAfter ? `可重试时间：${date(batch.retryAfter)}。` : ''}${batch.error ? `原因：${batch.error}` : ''}` : '尚未开始批量回填。只读取已保存在本机且已结束的场次。';
    renderSummary();
    const visibleRooms = roomList?.account?.id === selected ? roomList.rooms : a.rooms.slice(0, 50);
    if (!visibleRooms.some(r => r.id === room)) room = visibleRooms[0]?.id || '';
    const options = visibleRooms.map(r => `<option value="${esc(r.id)}">${esc(r.title)} · ${roomState(r)} · ${esc(r.id)}</option>`).join('') || '<option value="">暂无场次</option>';
    if ($('rpaRoom').innerHTML !== options && document.activeElement !== $('rpaRoom')) $('rpaRoom').innerHTML = options;
    $('rpaRoom').value = room;
    $('rpaRoomsPrev').disabled = roomPage === 0;
    $('rpaRoomsNext').disabled = !roomList?.hasMore;
    $('rpaRoomsPage').textContent = roomList ? `第 ${roomPage + 1} 页 · 共 ${roomList.total} 场` : '最近场次';
    const events = state.events.filter(e => e.account === selected);
    $('rpaEvents').innerHTML = events.map(e => `<div class="rpa-event"><time>${date(e.time)}</time><span>${esc(e.message)}</span></div>`).join('') || '<div class="rpa-login-hint">完成连接后，同步结果会记录在这里。</div>';
    if (!room) {
      const title = a.uid ? '今日暂无可展示的直播场次' : '完成罗盘登录，即可开始采集';
      $('rpaDetail').innerHTML = `<div class="rpa-login-hint"><strong>${title}</strong>${a.uid ? '采集器会按设定间隔检查新场次。账号需要拥有对应直播数据的查看权限。' : '点击“打开罗盘 / 登录”，在弹出的浏览器窗口选择官网密码或扫码登录。登录成功后，本页面会自动更新。'}<br>采集期间请保留罗盘窗口；关闭窗口会暂停自动同步。</div>`;
      $('rpaExport').disabled = true;
    }
  }

  function renderSummary() {
    const host = $('rpaHistorySummary');
    if (!host) return;
    const start = $('rpaHistoryStart').value, end = $('rpaHistoryEnd').value;
    if (!start || !end || start > end) { host.textContent = '请选择有效日期范围。'; return; }
    const data = historySummary;
    if (!data || data.account.id !== selected || data.startDate !== start || data.endDate !== end) {
      host.textContent = '正在读取本机历史报表…'; return;
    }
    host.innerHTML = `<p class="rpa-note">${data.selectedRooms} 场已结束直播 · ${data.reportedRooms} 场有报表 · ${data.completeRooms} 场接口完整。人数为各场进入人数之和，不代表去重人数。</p><div class="table-wrap"><table><thead><tr><th>指标</th><th>合计</th><th>覆盖场次</th></tr></thead><tbody>${data.metrics.map(item => `<tr><td>${esc(item.label)}</td><td>${esc(item.display)}${item.display === '—' ? '' : ` ${esc(item.unit)}`}${item.complete ? '' : item.coveredRooms ? ' · 部分数据' : ' · 暂无数据'}</td><td>${item.coveredRooms}/${data.selectedRooms}${item.reusedRooms ? ` · ${item.reusedRooms} 场沿用旧结果` : ''}${item.overflow ? ' · 超出安全数值范围' : ''}</td></tr>`).join('')}</tbody></table></div><p class="rpa-note">仅汇总罗盘历史详情中已返回且原始单位一致的值；缺失不按零计算。该汇总不写入飞书。</p>`;
  }

  async function loadSummary() {
    if (!state || !account() || !$('rpaHistorySummary')) return;
    const start = $('rpaHistoryStart').value, end = $('rpaHistoryEnd').value;
    const key = `${selected}:${start}:${end}:${account().historyBatch?.nextIndex ?? 0}:${account().historyBatch?.status ?? ''}`;
    if (!start || !end || start > end || key === summaryKey) return;
    summaryKey = key;
    const version = ++summaryVersion;
    try {
      const data = await apiRequest(`/api/rpa/history-summary?account=${encodeURIComponent(selected)}&startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`);
      if (version === summaryVersion) { historySummary = data; renderSummary(); }
    } catch (error) {
      if (version === summaryVersion) { summaryKey = ''; $('rpaHistorySummary').textContent = error.message; }
    }
  }

  function chart(history, key) {
    const samples = history.map(row => ({ time: row.time, point: row.metrics.find(m => m.key === key) })).filter(row => Number.isFinite(row.point?.value));
    if (samples.length < 2) return '<div class="table-empty">积累两次有效采样后显示趋势。</div>';
    const units = new Set(samples.map(s => s.point.unit));
    if (units.size > 1) return '<div class="table-empty">返回单位发生变化，暂不合并绘制趋势。</div>';
    const width = 650, height = 180, left = 65, right = 18, top = 16, bottom = 30;
    const values = samples.map(s => s.point.value), low = Math.min(0, ...values), high = Math.max(1, ...values);
    const first = Date.parse(history[0].time), last = Date.parse(history.at(-1).time);
    const x = t => left + (Date.parse(t) - first) / Math.max(last - first, 1) * (width - left - right);
    const y = v => top + (high - v) / Math.max(high - low, 1) * (height - top - bottom);
    const segments = []; let segment = [];
    for (const row of history) {
      const m = row.metrics.find(m => m.key === key);
      if (Number.isFinite(m?.value)) segment.push(`${x(row.time).toFixed(1)},${y(m.value).toFixed(1)}`);
      else if (segment.length) { segments.push(segment); segment = []; }
    }
    if (segment.length) segments.push(segment);
    return `<svg class="rpa-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="所选指标最近 ${samples.length} 次有效采样趋势">${[low, (low+high)/2, high].map(v => `<line x1="${left}" y1="${y(v)}" x2="${width-right}" y2="${y(v)}" stroke="#e5eeea"/><text x="${left-9}" y="${y(v)+4}" text-anchor="end">${esc(Number(v.toFixed(2)).toLocaleString('zh-CN'))}</text>`).join('')}${segments.map(s => `<polyline points="${s.join(' ')}" fill="none" stroke="#147d70" stroke-width="2.5"/>`).join('')}${samples.map(s => `<circle cx="${x(s.time)}" cy="${y(s.point.value)}" r="2.5" fill="#147d70"><title>${esc(date(s.time))} · ${esc(s.point.display)}</title></circle>`).join('')}<text x="${left}" y="${height-5}">${esc(new Date(first).toLocaleTimeString('zh-CN',{hour12:false}))}</text><text x="${width-right}" y="${height-5}" text-anchor="end">${esc(new Date(last).toLocaleTimeString('zh-CN',{hour12:false}))}</text></svg>`;
  }

  function historyReportMarkup(data) {
    const report = data.historyReport;
    if (!report && data.room?.source !== 'compass_history' && data.room?.state !== 'ended') return '';
    const busy = account()?.historyBusy || actionBusy || !!retryAfter(account());
    const action = `<button class="btn small" data-rpa-action="history-report" type="button" ${busy ? 'disabled' : ''}>${report ? '重新读取报表' : '读取历史报表'}</button>`;
    if (!report) return `<div class="rpa-heading"><h2>历史报表</h2>${action}</div><p class="rpa-note">尚未读取这场直播的历史经营指标。飞书历史同步由下方独立开关控制。</p>`;
    const failures = Object.entries(report.endpoints || {}).filter(([, item]) => !item.ok);
    const reused = Object.entries(report.endpoints || {}).filter(([, item]) => item.reused);
    const metrics = Array.isArray(report.metrics) ? report.metrics : [];
    return `<div class="rpa-heading"><h2>历史报表</h2>${action}</div><p class="rpa-note">罗盘直播间详情 · 最近读取 ${date(report.retrievedAt)} · ${report.roomState === 'ended' ? '已结束场次' : '结束状态待确认'} · 飞书历史同步由下方独立开关控制</p>${reused.length ? `<p class="rpa-note">沿用上次成功结果：${reused.map(([name, item]) => esc(`${name}（${date(item.retrievedAt)}）`)).join('、')}</p>` : ''}${failures.length ? `<div class="rpa-error-box">部分接口未取得：${failures.map(([name, item]) => esc(`${name}：${item.error || '未知原因'}`)).join('；')}</div>` : ''}<div class="table-wrap"><table><thead><tr><th>分类</th><th>指标</th><th>数值</th><th>接口原值</th></tr></thead><tbody>${metrics.length ? metrics.map(item => `<tr><td>${esc(item.category)}</td><td>${esc(item.label)}</td><td>${esc(item.display)}${item.unit ? ` ${esc(item.unit)}` : ''}</td><td>${item.value == null ? '未返回' : esc(String(item.value))} ${esc(item.rawUnit || '')}</td></tr>`).join('') : '<tr><td colspan="4">当前接口未返回可展示的历史指标。</td></tr>'}</tbody></table></div>`;
  }

  function hourlyMarkup(rows = []) {
    const ordered = [...rows].sort((a,b) => b.hourStart.localeCompare(a.hourStart) ||
      b.sampledAt.localeCompare(a.sampledAt) || a.metricName.localeCompare(b.metricName));
    const compare = row => {
      if (row.grain === '独立对照' || !Number.isFinite(row.value)) return '独立来源，不作逐小时对账';
      const priorEnd = row.hourStart;
      const previous = ordered.filter(item => item.hourEnd === priorEnd && item.source === row.source &&
        item.metricKey === row.metricKey && item.grain === row.grain && item.streamState === row.streamState &&
        Number.isFinite(item.value)).sort((a,b) => b.sampledAt.localeCompare(a.sampledAt))[0];
      if (!previous) return '上一小时无同类读数';
      const kind = row.grain === '官方小时' ? '官方小时值变化' : '边界快照变化';
      if (row.grain === '官方小时') {
        const delta = row.value - previous.value;
        return `${kind}：${delta > 0 ? '+' : ''}${Number(delta.toFixed(2))} ${row.unit}`;
      }
      return `${kind}：${row.value > previous.value ? '高于' : row.value < previous.value ? '低于' : '等于'}上一小时边界读数`;
    };
    return `<div class="rpa-heading" style="margin-top:25px"><h2>小时明细</h2><button type="button" class="btn small" data-rpa-hourly-refresh title="读取当前千川户的官方分时报表">刷新千川分时</button></div><div class="table-wrap"><table><thead><tr><th>小时</th><th>指标</th><th>读数</th><th>上一小时</th><th>来源与状态</th></tr></thead><tbody>${ordered.length ? ordered.map(row => `<tr><td>${esc(row.hourStart)}<small>至 ${esc(row.hourEnd)}</small></td><td>${esc(row.metricName)}<small>${esc(row.grain)}</small></td><td>${row.status === '已读取' ? `${esc(row.display || String(row.value))} ${esc(row.unit)}` : esc(row.reason || row.status)}</td><td>${esc(compare(row))}</td><td>${esc(row.source)} · ${esc(row.streamState)}<small>${esc(row.statisticalWindow)}</small><small>读取 ${esc(date(row.sampledAt))} · ${esc(row.version)}</small></td></tr>`).join('') : '<tr><td colspan="5">尚无小时边界或官方分时报表记录。</td></tr>'}</tbody></table></div>`;
  }

  function renderDetail(data) {
    const latest = data.latest;
    const historical = historyReportMarkup(data);
    $('rpaExport').disabled = !latest && !data.historyReport;
    if (!latest) { $('rpaDetail').innerHTML = data.room?.source === 'compass_history'
      ? `${historical || '<div class="rpa-login-hint">历史场次目录已保存，经营指标尚未导入；目录记录不会写入飞书。</div>'}${hourlyMarkup(data.hourly)}`
      : `<div class="rpa-login-hint">已发现此场次，尚未保存实时指标。采集器每轮优先同步最多 3 个近期场次。</div>${historical}${hourlyMarkup(data.hourly)}`; return; }
    const errors = Object.entries(latest.endpoints).filter(([,v]) => !v.ok);
    const stale = Date.now() - Date.parse(latest.time) > Math.max(180, (account()?.interval || 60) * 3) * 1000;
    $('rpaDetail').innerHTML = `<div class="rpa-note" style="margin-bottom:14px">罗盘后台数据 · 采样时间 ${date(latest.time)}${stale ? ' · 当前为历史快照' : ''}</div>${errors.length ? `<div class="rpa-error-box">部分数据尚未取得：${errors.map(([k,v]) => esc(k + ' · ' + v.error)).join('；')}</div>` : ''}<div class="rpa-metrics">${latest.metrics.map(m => `<div class="rpa-metric"><span>${esc(m.label)}</span><strong>${esc(m.display)}</strong><small>${esc(m.unit || '')}</small></div>`).join('')}</div><div class="rpa-heading"><h2>本机采样趋势</h2><select class="filter" id="rpaMetric" aria-label="趋势指标">${latest.metrics.map(m => `<option value="${esc(m.key)}" ${m.key === metric ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div><div id="rpaChart">${chart(data.history, metric)}</div><p class="rpa-note">金额、时长和比例按接口原值展示，单位以返回值为准；缺失值显示“—”。趋势仅包含这台电脑保存的采样。</p><div class="rpa-heading" style="margin-top:25px"><h2>商品表现</h2><span class="panel-subtitle">${latest.products.length} 个商品</span></div><div class="table-wrap rpa-product-wrap"><table><thead><tr><th>商品</th><th>成交金额</th><th>成交订单</th><th>商品点击人数</th><th>库存</th></tr></thead><tbody>${latest.products.length ? latest.products.map(p => `<tr><td class="rpa-product-name">${esc(p.name)}<div class="account-id">${esc(p.id)}</div></td><td>${value(p.metrics.pay_amt)}</td><td>${value(p.metrics.pay_combo_cnt)}</td><td>${value(p.metrics.product_click_ucnt)}</td><td>${value(p.metrics.stock_cnt)}</td></tr>`).join('') : '<tr><td colspan="5"><div class="table-empty">本次采样没有可展示的商品数据。</div></td></tr>'}</tbody></table></div>${historical}`;
    $('rpaDetail').insertAdjacentHTML('beforeend', hourlyMarkup(data.hourly));
    $('rpaMetric').addEventListener('change', () => { metric = $('rpaMetric').value; $('rpaChart').innerHTML = chart(data.history, metric); });
  }
  async function loadDetail() {
    if (!room || !$('rpaDetail')) return;
    const version = ++detailVersion;
    try {
      const data = await apiRequest(`/api/rpa/session?account=${encodeURIComponent(selected)}&room=${encodeURIComponent(room)}`);
      if (version !== detailVersion) return;
      currentDetail = data;
      if (document.activeElement?.id !== 'rpaMetric') renderDetail(data);
    } catch (e) { if (version === detailVersion) $('rpaDetail').innerHTML = `<div class="rpa-error-box">${esc(e.message)}</div>`; }
  }
  async function loadRooms() {
    const id = selected, page = roomPage, version = ++roomListVersion;
    try {
      const data = await apiRequest(`/api/rpa/rooms?account=${encodeURIComponent(id)}&offset=${page * 50}&limit=50`);
      if (version !== roomListVersion || selected !== id || roomPage !== page) return;
      roomList = data;
      render();
      await loadDetail();
    } catch (error) { if (version === roomListVersion) status(error.message, true); }
  }
  function renderEgo(record, error = '') {
    const host = $('egoWorkspace');
    if (!host) return;
    const spendLabels = {pending_authorization:'等待授权', pending_verification:'待核验', verified:'已核验', unavailable:'暂不可读取'};
    const content = error ? `<p class="rpa-note" role="status">${esc(error)}</p>` : !record?.configured ? '<p class="rpa-note">尚未配置 Ego 后台接入。完成账号和数据权限核验后，这里会保存接入进度。</p>' : `
      <p class="rpa-note"><strong>核验账号：</strong>${esc(record.accountName)} · ${record.provider === 'qianchuan' ? '巨量千川' : '电商罗盘'}<br><strong>账号 ID：</strong>${esc(record.authorId)}<br><strong>最近核验：</strong>${esc(new Date(record.verifiedAt).toLocaleString('zh-CN', {hour12:false}))}</p>
      <p class="rpa-note"><strong>核验时正在直播：</strong>${Number.isInteger(record.liveRoomCount) ? `${record.liveRoomCount} 场` : '尚未核验'}<br><strong>历史观察：</strong>${esc(record.historySummary || '尚无历史观察记录')}<br><strong>消耗数据：</strong>${esc(spendLabels[record.spendStatus] || '待核验')}</p>
      <p class="rpa-note"><strong>下一步：</strong>${esc(record.nextStep || '等待后续数据核验')}</p>`;
    host.innerHTML = `<section class="panel" aria-labelledby="egoSetupTitle"><div class="panel-head"><div><div class="panel-title" id="egoSetupTitle">Ego 后台接入进度</div><div class="panel-subtitle">最近核验记录</div></div><span class="rpa-chip">${error ? '读取失败' : record?.configured ? '已保存核验记录' : '未配置'}</span></div><div class="panel-body">${content}<p class="rpa-note">这里记录上次核验结果；当前登录是否有效、直播状态和消耗权限需要重新核验。罗盘自动采集状态见上方账号面板。</p></div></section>`;
  }
  function refreshEgo() {
    if (egoLoading) return egoLoading;
    egoLoading = (async () => {
      try { renderEgo(await apiRequest('/api/rpa/ego/state')); }
      catch (error) { renderEgo(null, error.message); }
      finally { egoLoading = null; }
    })();
    return egoLoading;
  }
  function refresh() {
    refreshEgo();
    refreshQianchuanStatus();
    refreshQianchuanAccount();
    if (loading) return loading;
    loading = (async () => {
    try {
      state = await apiRequest('/api/rpa/state');
      if (workspaceView === 'rooms' && !roomAccountsInitialized) {
        roomAccounts = new Set(state.accounts.map(item=>item.id)); roomAccountsInitialized = true;
      }
      render();
      status(`本机采集服务已连接 · ${state.accounts.length} 个账号 · 历史采样最多保留 ${state.retentionDays} 天`);
      if (account()) { await loadRooms(); await loadSummary(); }
    } catch (e) { status(e.message, true); }
    finally { loading = null; }
    })();
    return loading;
  }
  function showQianchuanStatus(result) {
    qianchuanState = qianchuanLabels[result?.state] ? result.state : 'unknown';
    const label = qianchuanLabels[qianchuanState];
    const home = $('qianchuanHomeStatus');
    if (home) home.textContent = `千川登录：${label} · 同场消耗按采样结果对账`;
    const card = document.querySelector('.rpa-qianchuan-login .rpa-provider-state');
    if (card) { card.textContent = label; card.className = `rpa-provider-state ${qianchuanState === 'logged_in' ? 'ready' : 'pending'}`; }
  }
  function refreshQianchuanStatus() {
    if (qianchuanLoading) return qianchuanLoading;
    qianchuanLoading = (async () => {
      try { showQianchuanStatus(await apiRequest('/api/rpa/providers/qianchuan/status')); }
      catch { showQianchuanStatus({ state:'unknown' }); }
      finally { qianchuanLoading = null; }
    })();
    return qianchuanLoading;
  }
  function renderQianchuanAccount(card) {
    let form = card.querySelector('[data-qianchuan-account-form]');
    if (!form) {
      card.insertAdjacentHTML('beforeend', `<form class="rpa-qianchuan-account" data-qianchuan-account-form><div class="rpa-qianchuan-account-head"><strong>当前使用的户</strong><span data-qianchuan-account-summary>尚未指定</span></div><div class="rpa-qianchuan-account-fields"><label>户名称<input name="name" type="text" maxlength="80" autocomplete="off" placeholder="填写户名称"></label><label>户 ID<input name="accountId" type="text" inputmode="numeric" maxlength="64" autocomplete="off" placeholder="填写户 ID（可选）"></label></div><div class="rpa-qianchuan-account-actions"><button type="submit" class="btn small primary">保存当前户</button><button type="button" class="btn small" data-qianchuan-enter>进入当前户</button><button type="button" class="btn small" data-qianchuan-account-clear hidden>清除</button></div><div class="rpa-qianchuan-entry-feedback" data-qianchuan-entry-feedback role="status" aria-live="polite" hidden></div><small>户 ID 留空会保留已保存的 ID；同场消耗按采样结果对账。</small></form>`);
      form = card.querySelector('[data-qianchuan-account-form]');
      if (qianchuanAccount?.name) form.elements.name.value = qianchuanAccount.name;
    }
    const current = qianchuanAccount;
    form.querySelector('[data-qianchuan-account-summary]').textContent = current?.configured ?
      [current.name, current.maskedId && `ID ${current.maskedId}`].filter(Boolean).join(' · ') : '尚未指定';
    form.querySelector('[data-qianchuan-account-clear]').hidden = !current?.configured;
  }
  function refreshQianchuanAccount() {
    if (qianchuanAccountLoading || qianchuanAccount) return qianchuanAccountLoading;
    qianchuanAccountLoading = (async () => {
      try {
        qianchuanAccount = await apiRequest('/api/rpa/providers/qianchuan/account');
        const card = document.querySelector('.qianchuan-mark')?.closest('.rpa-provider-card');
        if (card) {
          const form = card.querySelector('[data-qianchuan-account-form]');
          if (form && document.activeElement !== form.elements.name && document.activeElement !== form.elements.accountId)
            form.elements.name.value = qianchuanAccount.name || '';
          renderQianchuanAccount(card);
        }
        if (state) renderIdentity();
      } catch (error) { status(error.message, true); }
      finally { qianchuanAccountLoading = null; }
    })();
    return qianchuanAccountLoading;
  }
  async function saveQianchuanAccount(form, clear = false) {
    const button = form.querySelector(clear ? '[data-qianchuan-account-clear]' : '[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const enterButton = form.querySelector('[data-qianchuan-enter]');
    enterButton.disabled = true;
    try {
      qianchuanAccount = await apiRequest('/api/rpa/providers/qianchuan/account', {
        method:'POST', body:JSON.stringify(clear ? {clear:true} : {
          name:form.elements.name.value, accountId:form.elements.accountId.value,
        }),
      });
      form.elements.name.value = qianchuanAccount.name || '';
      form.elements.accountId.value = '';
      renderQianchuanAccount(form.closest('.rpa-provider-card'));
      if (state) renderIdentity();
      const feedback = form.querySelector('[data-qianchuan-entry-feedback]');
      feedback.hidden = true;
      feedback.textContent = '';
      const message = clear ? '已清除当前户。' : '当前户已保存在本机；同场消耗按采样结果对账。';
      status(message); toast(message);
    } catch (error) { status(error.message, true); toast(error.message); }
    finally { button.disabled = false; enterButton.disabled = false; }
  }
  async function act(action, payload = {}) {
    if (actionBusy || !account()) return;
    actionBusy = true; const a = account();
    status(action === 'login' ? '正在打开独立的罗盘登录窗口…' : '正在提交操作…');
    try {
      if (action === 'monitor') payload = { enabled: !a.enabled };
      if (action === 'history') {
        const startDate = $('rpaHistoryStart').value, endDate = $('rpaHistoryEnd').value;
        payload = { startDate, endDate, reset: !a.history?.uid || a.history.uid !== a.uid ||
          a.history.startDate !== startDate || a.history.endDate !== endDate || a.history.complete };
      }
      if (action === 'history-batch-start') payload = {
        startDate: $('rpaHistoryStart').value, endDate: $('rpaHistoryEnd').value,
      };
      if (action === 'history-report') payload = { room };
      const endpoint = action === 'confirm-target' ? '/api/rpa/target' : `/api/rpa/accounts/${encodeURIComponent(a.id)}/${action}`;
      if (action === 'confirm-target') payload = { verifiedAccount:a.id };
      const result = await apiRequest(endpoint, {method:'POST', body:JSON.stringify(payload)});
      if (result?.cancelled) throw new Error('账号已暂停，本次历史读取已取消');
      toast(result?.warning || (action === 'login' ? '请在罗盘窗口切换或登录达人，随后点击“核验当前达人”' : action === 'verify' ? '已读取罗盘窗口当前达人，请核对与直播号是否一致' : action === 'confirm-target' ? '已将刚核验的达人设为当前直播号' : action === 'sync' ? '已开始同步，结果会自动显示' : action === 'history' ? '历史场次目录已更新' : action === 'history-report' ? '历史报表已保存到本机' : '设置已保存'));
      await refresh();
    } catch (e) { status(e.message, true); toast(e.message); }
    finally { actionBusy = false; if (state) render(); }
  }
  async function saveTarget(form) {
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await apiRequest('/api/rpa/target', {method:'POST', body:JSON.stringify({name:form.elements.name.value.trim()})});
      await refresh();
      toast('当前直播号已保存；请核验罗盘窗口里的达人。');
    } catch (error) { status(error.message, true); toast(error.message); }
    finally { button.disabled = false; }
  }
  async function openQianchuanLogin(button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '正在打开…';
    try {
      await apiRequest('/api/rpa/providers/qianchuan/login', { method:'POST', body:'{}' });
      if (qianchuanLoading) await qianchuanLoading;
      await refreshQianchuanStatus();
      toast(qianchuanState === 'logged_in' ? '千川已登录；同场消耗按采样结果对账。' : '千川窗口已打开。完成官网登录后，请检查登录状态。');
      status(qianchuanState === 'logged_in' ? '千川登录已确认；同场消耗按采样结果对账。' : '请在千川官网完成登录，再点“完成登录后检查”。');
    } catch (error) {
      status(error.message, true);
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }
  async function checkQianchuanLogin(button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '正在检查…';
    try {
      if (qianchuanLoading) await qianchuanLoading;
      showQianchuanStatus(await apiRequest('/api/rpa/providers/qianchuan/check', { method:'POST', body:'{}' }));
      const message = qianchuanState === 'logged_in' ? '千川登录已确认；同场消耗按采样结果对账。' :
        qianchuanState === 'needs_login' ? '千川尚未登录或会话已失效，请在官网完成登录。' : '暂无法确认千川登录状态，请检查官网页面。';
      status(message, qianchuanState !== 'logged_in'); toast(message);
    } catch (error) { status(error.message, true); toast(error.message); }
    finally { button.disabled = false; button.textContent = original; }
  }
  async function enterQianchuanAccount(button) {
    if (!button || button.disabled) return;
    const form = button.closest('form');
    const feedback = form.querySelector('[data-qianchuan-entry-feedback]');
    const show = (message, error = false) => {
      feedback.textContent = message;
      feedback.hidden = false;
      feedback.classList.toggle('error', error);
      status(message, error);
      toast(message);
    };
    button.disabled = true;
    const saveButton = form.querySelector('[type="submit"]');
    const clearButton = form.querySelector('[data-qianchuan-account-clear]');
    saveButton.disabled = true;
    clearButton.disabled = true;
    button.textContent = '正在进入…';
    try {
      if (form.elements.accountId.value.trim()) {
        show('请先保存填写的户 ID，再进入当前户。', true);
        return;
      }
      if (qianchuanAccountLoading) await qianchuanAccountLoading;
      if (!qianchuanAccount) await refreshQianchuanAccount();
      if (!qianchuanAccount?.maskedId) {
        show('请先在「当前使用的户」填写并保存户 ID。', true);
        return;
      }
      feedback.textContent = '正在官网查找并进入当前户…';
      feedback.hidden = false;
      feedback.classList.remove('error');
      const result = await apiRequest('/api/rpa/providers/qianchuan/enter', { method:'POST', body:'{}' });
      if (result?.entered !== true) throw new Error('未能确认已进入当前户，请检查千川窗口。');
      show('已进入当前户；同场消耗按采样结果对账。');
    } catch (error) { show(error.message || '进入当前户失败，请检查千川窗口。', true); }
    finally {
      button.disabled = false;
      saveButton.disabled = false;
      clearButton.disabled = false;
      button.textContent = '进入当前户';
    }
  }
  function connect() {
    openModal('连接罗盘账号', '<div class="field"><label for="rpaAccountName">账号备注</label><input id="rpaAccountName" maxlength="60" placeholder="例如：我的直播账号" autocomplete="off"><div class="field-help">随后会打开独立的浏览器窗口，请在罗盘官网选择密码或扫码登录。每个连接的登录状态保留在各自的本机会话中，直到官网会话失效。</div></div>', '<button class="btn" id="rpaCancel">取消</button><button class="btn primary" id="rpaCreate">打开罗盘并连接</button>');
    $('rpaCancel').onclick = closeModal;
    $('rpaCreate').onclick = async () => {
      const button = $('rpaCreate'); button.disabled = true; button.textContent = '正在连接…';
      try {
        const result = await apiRequest('/api/rpa/accounts', {method:'POST', body:JSON.stringify({ label:$('rpaAccountName').value || '我的罗盘账号' })});
        if (loading) await loading;
        selected = result.account.id; closeModal(); await refresh(); await act('login');
      } catch (e) { toast(e.message); button.disabled = false; button.textContent = '打开罗盘并连接'; }
    };
    $('rpaAccountName').focus();
  }
  async function exportData() {
    if (!room) return;
    try {
      const data = await apiRequest(`/api/rpa/session?account=${encodeURIComponent(selected)}&room=${encodeURIComponent(room)}&raw=1`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = `罗盘场次-${room}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast(e.message); }
  }
  async function refreshRoomDirectory() {
    roomWorkspaceData = null; roomWorkspaceKey = ''; roomWorkspaceError = '';
    await refresh();
    if (workspaceView === 'rooms') loadRoomWorkspace();
  }
  async function openRoomDetail(accountId, roomId) {
    await loadAllRoomsForAccount(accountId);
    selected = accountId; room = roomId;
    const known = allStoredRooms(accountId);
    const index = known.findIndex(item=>item.id===roomId);
    roomPage = index >= 0 ? Math.floor(index/50) : 0;
    workspaceView = 'settings'; localStorage.setItem('rpaWorkspaceView',workspaceView);
    renderIdentity(); renderWorkspaceView(); await loadRooms();
  }
  $('rpaConnect').onclick = connect;
  $('view-business').addEventListener('submit', event => {
    const targetForm = event.target.closest('[data-rpa-target-form]');
    if (targetForm) { event.preventDefault(); saveTarget(targetForm); return; }
    const form = event.target.closest('[data-qianchuan-account-form]');
    if (!form) return;
    event.preventDefault();
    saveQianchuanAccount(form);
  });
  $('view-business').addEventListener('click', event => {
    const hourlyRefresh = event.target.closest('[data-rpa-hourly-refresh]');
    if (hourlyRefresh && selected && room) {
      hourlyRefresh.disabled = true;
      apiRequest('/api/rpa/hourly/refresh', { method: 'POST', body: JSON.stringify({ account: selected, room }) })
        .then(() => loadDetail()).catch(error => toast(error.message))
        .finally(() => { hourlyRefresh.disabled = false; });
      return;
    }
    const qianchuanClear = event.target.closest('[data-qianchuan-account-clear]');
    if (qianchuanClear) { saveQianchuanAccount(qianchuanClear.closest('form'), true); return; }
    const qianchuanEnter = event.target.closest('[data-qianchuan-enter]');
    if (qianchuanEnter) { enterQianchuanAccount(qianchuanEnter); return; }
    const qianchuanLogin = event.target.closest('[data-qianchuan-login]');
    if (qianchuanLogin) { openQianchuanLogin(qianchuanLogin); return; }
    const qianchuanCheck = event.target.closest('[data-qianchuan-check]');
    if (qianchuanCheck) { checkQianchuanLogin(qianchuanCheck); return; }
    const tab = event.target.closest('[data-rpa-view]');
    if (tab) {
      workspaceView = tab.dataset.rpaView;
      localStorage.setItem('rpaWorkspaceView',workspaceView);
      if (workspaceView === 'rooms') {
        if (!roomAccountsInitialized) { roomAccounts = new Set(state.accounts.map(item=>item.id)); roomAccountsInitialized = true; }
        renderWorkspaceView();
        for (const item of selectedAccounts()) loadAccountSummary(item.id);
      } else renderWorkspaceView();
      return;
    }
    const item = event.target.closest('[data-rpa-account]');
    if (item) {
      selected = item.dataset.rpaAccount; room = ''; roomPage = 0; roomPageView = 0; roomList = null;
      detailVersion++; roomListVersion++; summaryVersion++; summaryKey = ''; render();
      if (workspaceView === 'settings') { loadRooms(); loadSummary(); }
      else loadAccountSummary(selected);
      return;
    }
    const roomDetail = event.target.closest('[data-room-detail]');
    if (roomDetail) { openRoomDetail(roomDetail.dataset.roomAccount, roomDetail.dataset.roomDetail); return; }
    const openAccount = event.target.closest('[data-open-account]');
    if (openAccount) { selected = openAccount.dataset.openAccount; workspaceView='settings'; localStorage.setItem('rpaWorkspaceView',workspaceView); renderIdentity(); renderWorkspaceView(); loadRooms(); return; }
    const page = event.target.closest('[data-room-page]');
    if (page) { roomPageView = Math.max(0,roomPageView+(page.dataset.roomPage==='next'?1:-1)); renderWorkspaceView(); return; }
    const sort = event.target.closest('[data-room-sort]');
    if (sort) {
      const key = sort.dataset.roomSort;
      roomSortDirection = roomSort === key && roomSortDirection === 'asc' ? 'desc' : 'asc';
      roomSort = key; roomPageView = 0; roomWorkspaceData = null; roomWorkspaceKey = '';
      renderWorkspaceView(); return;
    }
    const preset = event.target.closest('[data-range-preset]');
    if (preset) { setRangePreset(preset.dataset.rangePreset); roomPageView=0; renderWorkspaceView(); for (const item of selectedAccounts()) loadAccountSummary(item.id); return; }
    const chartButton = event.target.closest('[data-chart-mode]');
    if (chartButton) { chartMode=chartButton.dataset.chartMode; renderWorkspaceView(); return; }
    const action = event.target.closest('[data-rpa-action]')?.dataset.rpaAction;
    if (action === 'connect') connect();
    else if (action === 'export') exportData();
    else if (action === 'rooms-export') exportRoomRows();
    else if (action === 'rooms-refresh') refreshRoomDirectory();
    else if (action === 'rooms-import') importRoomDirectories();
    else if (action === 'rooms-batch') batchSyncRooms();
    else if (action === 'custom-metrics') chooseCustomMetrics();
    else if (action) act(action);
  });
  $('view-business').addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-range-start], [data-range-end]')) {
      const start = $('rpaWorkspaceView').querySelector('[data-range-start]')?.value || rangeStart;
      const end = $('rpaWorkspaceView').querySelector('[data-range-end]')?.value || rangeEnd;
      if (changeRange(start,end)) {
        accountSummaries.clear(); summaryVersion++; summaryKey=''; roomPageView=0; renderWorkspaceView();
        for (const item of selectedAccounts()) loadAccountSummary(item.id);
        if (workspaceView==='settings') { if ($('rpaHistoryStart')) $('rpaHistoryStart').value=start; if ($('rpaHistoryEnd')) $('rpaHistoryEnd').value=end; loadSummary(); }
      } else renderWorkspaceView();
      return;
    }
    if (target.matches('[data-platform]')) { platformFilter=target.dataset.platform; renderWorkspaceView(); return; }
    if (target.matches('[data-room-platform]')) { roomPlatformFilter=target.value; roomPageView=0; renderWorkspaceView(); return; }
    if (target.matches('[data-omit-live]')) { omitLiveRooms=target.checked; roomPageView=0; renderWorkspaceView(); return; }
    if (target.matches('[data-select-all-accounts]')) {
      roomAccounts = target.checked ? new Set(state.accounts.map(item=>item.id)) : new Set();
      roomAccountsInitialized = true;
      roomPageView=0; renderWorkspaceView();
      for (const item of selectedAccounts()) loadAccountSummary(item.id);
      return;
    }
    if (target.matches('[data-room-account-check]')) {
      if (target.checked) roomAccounts.add(target.dataset.roomAccountCheck); else roomAccounts.delete(target.dataset.roomAccountCheck);
      roomAccountsInitialized = true;
      roomPageView=0; renderWorkspaceView();
      const item=state.accounts.find(account=>account.id===target.dataset.roomAccountCheck);
      if (target.checked && item) loadAccountSummary(item.id);
      return;
    }
    if (target.matches('[data-exact-values]')) { exactValues=target.checked; renderWorkspaceView(); return; }
    if (target.matches('[data-aggregation]')) { aggregationMode=target.value; roomPageView=0; renderWorkspaceView(); }
  });
  window.LiveRpa = { refresh };
  if (!['accounts','rooms','settings'].includes(workspaceView)) workspaceView = 'accounts';
  setRangePreset('30');
  setInterval(() => { if (currentView === 'business' && !document.hidden) refresh(); }, 5000);
  if (location.hash === '#business') switchView('business');
})();
