(() => {
  const $ = id => document.getElementById(id);
  let loading = false, acting = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const state = await apiRequest('/api/dependencies/state');
      const found = state.items.filter(item => item.found).length;
      $('dependencyBadge').textContent = state.busy ? '正在安装' : `${found} / ${state.items.length} 已找到`;
      $('dependencyItems').innerHTML = state.items.map(item => `<span class="tag ${item.found ? 'ready' : ''}">${esc(item.name)} · ${item.found ? '已找到' : '待安装'}</span>`).join('');
      $('installDependencies').disabled = state.busy || acting || !state.canInstall;
      $('installDependencies').textContent = state.busy ? '安装中…' : '安装缺少的组件';
      $('dependencyMessage').textContent = state.error || (state.busy ? '下载和编译会持续几分钟，可以切换页面。' : state.completed ? '安装检查已完成。可启动录制器，并在经营数据中登录账号。' : !state.canInstall ? '此安装器目前仅支持 macOS Apple Silicon。' : '状态表示本机已找到文件，实际录制与登录连接仍需分别检查。');
      if (!state.chromeFound) $('dependencyMessage').textContent += ' 罗盘采集还需要安装 Google Chrome。';
      $('dependencyLogWrap').hidden = !state.log;
      $('dependencyLog').textContent = state.log || '';
    } catch (error) {
      $('dependencyBadge').textContent = '检查失败';
      $('dependencyMessage').textContent = error.message;
    } finally { loading = false; }
  }
  $('installDependencies').addEventListener('click', async () => {
    if (acting) return;
    acting = true;
    $('installDependencies').disabled = true;
    try {
      await apiRequest('/api/dependencies/install', {method:'POST', body:'{}'});
      toast('已开始检查并安装本机组件');
    } catch (error) { $('dependencyMessage').textContent = error.message; toast(error.message); }
    finally { acting = false; await refresh(); }
  });
  $('checkDependencies').addEventListener('click', refresh);
  setInterval(() => { if (currentView === 'settings' && !document.hidden) refresh(); }, 3000);
  refresh();
})();
