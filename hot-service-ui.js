(() => {
  const $ = id => document.getElementById(id);
  let reading = false, acting = false, actionError = '', state = null, installation = null;
  function render() {
    if (!state || !installation) return;
    $('dailyhotSettingsBadge').textContent = installation.busy ? '安装中' : state.connected ? '服务已启动' : state.installed ? '未启动' : '待安装';
    $('hotServiceMessage').textContent = actionError || installation.error || state.error || state.message;
    $('hotServiceDataStatus').textContent = !state.connected ? '启动服务后可读取公开热点榜。' : state.dataReady === true ? '最近榜单读取成功' + (state.updatedAt ? ' · 数据时间 ' + formatTime(state.updatedAt) : '') : state.dataReady === false ? '最近读取失败：' + (state.dataError || '上游暂不可用') : '尚未读取榜单；服务启动不代表上游数据可用。';
    $('dailyhotSettingsStatus').textContent = state.pendingRestart === true ? '设置已保存，点击“重启并应用”生效。' : state.pendingRestart === false ? '已保存设置与运行配置一致；修改后需先保存再重启。' : state.connected ? '已有服务的运行配置无法核对；请使用原启动工具应用设置。' : '修改后先保存设置，下次启动时生效。';
    $('dailyhotSettingsStatus').className = 'settings-status' + (state.pendingRestart ? ' pending' : '');
    const logs = [state.log, installation.log].filter(Boolean).join('\n\n');
    $('hotServiceLogWrap').hidden = !logs;
    $('hotServiceLog').textContent = logs;
    for (const button of document.querySelectorAll('[data-hot-action]')) {
      const action = button.dataset.hotAction;
      button.disabled = acting || (action === 'install' && (installation.busy || !installation.canInstall))
        || (action === 'start' && (!state.canStart || !state.installed || !state.nodeReady || installation.busy))
        || (action === 'read' && !state.connected)
        || (action === 'stop' && !state.canStop) || (action === 'restart' && !state.canRestart);
    }
  }
  async function refresh() {
    if (reading) return;
    reading = true;
    try {
      [state, installation] = await Promise.all([apiRequest('/api/hotwords/state'), apiRequest('/api/dependencies/state')]);
      serviceState.dailyhot = {...serviceState.dailyhot, ...state};
      applyServiceStatuses();
      render();
    } catch (error) { $('hotServiceMessage').textContent = error.message; }
    finally { reading = false; }
  }
  async function act(action) {
    if (acting) return;
    acting = true;
    actionError = '';
    render();
    try {
      if (action === 'read') {
        const result = await apiRequest('/api/hotwords?limit=50');
        keywordResults = result.data || [];
        hotUpdateTime = result.updateTime || null;
        hotLoaded = true;
        renderKeywords();
        toast('热点榜已读取');
      } else if (action !== 'check') {
        await apiRequest('/api/hotwords/' + action, {method:'POST', body:'{}'});
        toast({install:'已开始安装热点组件',start:'热点服务已启动',stop:'热点服务已停止',restart:'热点服务已重启'}[action]);
      }
    } catch (error) { actionError = error.message; toast(error.message); }
    finally { acting = false; await refresh(); render(); }
  }
  document.querySelectorAll('[data-hot-action]').forEach(button => button.addEventListener('click', () => act(button.dataset.hotAction)));
  window.addEventListener('liveops-hot-settings', refresh);
  setInterval(() => { if (['settings','sources'].includes(currentView) && !document.hidden) refresh(); }, 5000);
  refresh();
})();
