(() => {
  const $ = id => document.getElementById(id);
  let state = null, loading = null, busy = false, actionError = '', syncState = null, syncError = '';
  const shownTime = value => value ? formatTime(value) : '—';
  const hotValue = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
  const escape = value => esc(String(value ?? ''));

  function trendMarkup(points) {
    const recent = (points || []).slice(-12);
    if (!recent.length) return '<span class="insights-muted">尚无采样</span>';
    const max = Math.max(1, ...recent.map(point => Number(point.hot) || 0));
    return `<div class="insights-trend" aria-label="最近 ${recent.length} 次榜单采样">${recent.map(point => {
      const value = point.hot == null ? null : Number(point.hot);
      const height = value == null ? 2 : Math.max(4, Math.round(value / max * 30));
      return `<span class="${value == null ? 'missing' : ''}" style="height:${height}px" title="${escape(shownTime(point.sampledAt))}：${escape(value == null ? '未上榜' : hotValue(value))}"></span>`;
    }).join('')}</div>`;
  }

  function render() {
    if (!state) return;
    const terms = state.terms || [];
    $('hotInsightsCount').textContent = `${terms.length} 个监控词`;
    $('hotInsightsExport').disabled = !terms.length || busy;
    $('hotInsightsRefresh').disabled = busy;
    $('hotWatchForm').querySelector('button[type="submit"]').disabled = busy;
    $('hotInsightsStatus').textContent = actionError || (state.latest
      ? `${state.sampleCount || 0} 次采样 · 最近观察 ${shownTime(state.latest.sampledAt)}${state.stale ? ' · 采样已过期' : ''} · 首次观察为本机记录时间`
      : '尚无公开榜单采样');
    const auto = state.autoRefresh || {};
    if (document.activeElement !== $('hotAutoInterval')) $('hotAutoInterval').value = auto.intervalMinutes || 60;
    $('hotAutoEnabled').checked = auto.enabled === true;
    $('hotAutoPaused').checked = auto.paused === true;
    $('hotAutoStatus').textContent = auto.lastError ? `刷新失败：${auto.lastError}`
      : auto.enabled ? (auto.paused ? '已暂停' : `下次刷新 ${shownTime(auto.nextDueAt)}`) : '未启用';
    $('hotAutoForm').querySelector('button[type="submit"]').disabled = busy;
    $('hotWatchRows').innerHTML = terms.length ? terms.map(item => `<tr><td><strong>${escape(item.term)}</strong></td><td class="number">${hotValue(item.currentHot)}${item.currentRank == null ? '' : `<small class="insights-muted">第 ${Number(item.currentRank)} 位</small>`}</td><td>${trendMarkup(item.trend)}</td><td>${escape(shownTime(item.firstSeenAt))}</td><td>${escape(shownTime(item.lastSeenAt))}</td><td><button class="table-action" type="button" data-hot-unwatch="${escape(item.term)}" aria-label="移除 ${escape(item.term)}">移除</button></td></tr>`).join('')
      : '<tr><td colspan="6"><div class="table-empty">尚未添加监控词</div></td></tr>';
    const sessions = state.sessions || [];
    $('hotSessionRows').innerHTML = sessions.length ? sessions.map(session => `<article class="ops-record"><div><strong>${escape(session.title || '未命名场次')}</strong><small>${escape(shownTime(session.startedAt))} · ${(session.matches || []).map(match => `${escape(match.term)}（${[...(match.matchedIn || []).map(place => place === 'title' ? '标题' : '复盘'), ...(match.hotDuringSession?.length ? ['直播时段热点'] : [])].join('、')}）`).join(' · ')}</small>${(session.matches || []).filter(match => match.hotDuringSession?.length).map(match => `<details class="insights-session-samples"><summary>${escape(match.term)} · ${match.hotDuringSession.length} 条时段采样</summary>${match.hotDuringSession.map(hit => `<div>${escape(hit.title)} · 热度 ${hotValue(hit.hot)} · ${escape(shownTime(hit.sampledAt))}</div>`).join('')}</details>`).join('')}</div></article>`).join('')
      : '<div class="ops-empty">当前监控词与已保存场次没有匹配记录</div>';
  }

  async function refresh() {
    if (loading) return loading;
    loading = apiRequest('/api/hot-insights').then(result => { state = result; render(); })
      .catch(error => { $('hotInsightsStatus').textContent = `读取失败：${error.message}`; })
      .finally(() => { loading = null; });
    return loading;
  }
  async function refreshSync() {
    try {
      syncState = await apiRequest('/api/hot-insights/sync');
      $('hotSyncEnabled').checked = syncState.enabled;
      $('hotSyncStatus').textContent = syncError || (syncState.enabled
        ? `待投递 ${syncState.pending} · 重试 ${syncState.retry} · 已同步 ${syncState.synced}`
        : (syncState.configured ? '已关闭' : '未配置'));
      $('hotSyncRetry').disabled = !syncState.enabled || !syncState.retry;
    } catch (error) {
      $('hotSyncStatus').textContent = `状态读取失败：${error.message}`;
    }
  }
  async function act(path, payload) {
    if (busy) return;
    actionError = '';
    busy = true; render();
    $('hotInsightsStatus').textContent = path.endsWith('/refresh') ? '正在读取公开榜单' : '正在保存本机监控词';
    try {
      await apiRequest(path, {method:'POST', body:JSON.stringify(payload)});
      await refresh();
      if (path.endsWith('/refresh')) await refreshSync();
      return true;
    } catch (error) { actionError = error.message; toast(error.message); return false; }
    finally { busy = false; render(); }
  }
  $('hotWatchForm').addEventListener('submit', event => {
    event.preventDefault();
    const term = $('hotWatchTerm').value.trim();
    if (!term) return;
    act('/api/hot-insights/watch', {term}).then(saved => { if (saved) $('hotWatchTerm').value = ''; });
  });
  $('hotInsightsRefresh').addEventListener('click', () => act('/api/hot-insights/refresh', {}));
  $('hotAutoForm').addEventListener('submit', event => {
    event.preventDefault();
    act('/api/hot-insights/auto-refresh', {enabled:$('hotAutoEnabled').checked,
      paused:$('hotAutoPaused').checked, intervalMinutes:Number($('hotAutoInterval').value)});
  });
  $('hotSyncForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    syncError = '';
    $('hotSyncStatus').textContent = '正在保存';
    try {
      await apiRequest('/api/hot-insights/sync/config', {method:'POST', body:JSON.stringify({
        enabled:$('hotSyncEnabled').checked, appId:$('hotSyncAppId').value.trim(),
        appSecret:$('hotSyncSecret').value, tableUrl:$('hotSyncTable').value.trim()})});
      $('hotSyncAppId').value = '';
      $('hotSyncSecret').value = '';
      $('hotSyncTable').value = '';
      await refreshSync();
    } catch (error) { syncError = error.message; $('hotSyncStatus').textContent = error.message; toast(error.message); }
    finally { busy = false; render(); }
  });
  $('hotSyncRetry').addEventListener('click', async () => {
    try {
      await apiRequest('/api/hot-insights/sync/retry', {method:'POST', body:'{}'});
      syncError = '';
      await refreshSync();
    } catch (error) { syncError = error.message; $('hotSyncStatus').textContent = error.message; toast(error.message); }
  });
  $('hotWatchRows').addEventListener('click', event => {
    const button = event.target.closest('[data-hot-unwatch]');
    if (button) act('/api/hot-insights/unwatch', {term:button.dataset.hotUnwatch});
  });
  $('hotInsightsExport').addEventListener('click', () => {
    if (!state?.terms?.length) return;
    const rows = [['记录类型','监控词','热度','榜单排名','观察时间','首次观察','最近观察','场次标题','匹配位置']];
    for (const item of state.terms) {
      for (const point of item.trend?.length ? item.trend : [{hot:null,rank:null,sampledAt:null}]) {
        rows.push(['榜单采样',item.term,point.hot,point.rank,point.sampledAt,item.firstSeenAt,item.lastSeenAt,'','']);
      }
    }
    for (const session of state.sessions || []) for (const match of session.matches || []) {
      rows.push(['场次关联',match.term,'','',session.startedAt,'','',session.title,
        [...(match.matchedIn || []), ...(match.hotDuringSession?.length ? ['hotDuringSession'] : [])].join(' / ')]);
    }
    downloadCsv('热词监控与场次.csv', rows);
  });
  window.LiveHotInsights = {refresh: async () => { await refresh(); await refreshSync(); }};
  if (location.hash === '#keywords') window.LiveHotInsights.refresh();
})();
