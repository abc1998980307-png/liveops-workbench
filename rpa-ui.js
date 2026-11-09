(() => {
  let state = null, selected = localStorage.getItem('rpaAccount') || '', room = '', metric = 'online_user_cnt';
  let loading = null, detailVersion = 0, currentDetail = null, actionBusy = false, renderedAccount = '';
  let egoLoading = null;
  const $ = id => document.getElementById(id);
  const labels = { ready:'同步正常', needs_login:'等待登录', paused:'已暂停', partial:'部分数据失败', error:'同步失败', rate_limited:'等待重试', account_changed:'账号已切换' };
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '尚未同步';
  const chip = account => `<span class="rpa-chip ${esc(account.state)}">${esc(account.busy ? '正在同步…' : labels[account.state] || '等待同步')}</span>`;
  const value = item => item ? `${esc(item.display)}${item.unit ? ' ' + esc(item.unit) : ''}` : '—';
  const account = () => state?.accounts.find(a => a.id === selected);
  const roomState = r => r.state === 'live' ? '直播中' : r.state === 'ended' ? '已结束' : '状态待确认';
  function status(message, error = false) { $('rpaStatus').textContent = message; $('rpaStatus').classList.toggle('error', error); }

  function empty() {
    $('rpaWorkspace').innerHTML = `<div class="panel rpa-empty"><div class="rpa-emblem"><svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true"><circle cx="17" cy="17" r="14" stroke="currentColor" stroke-width="1.5"/><path d="m22 11-3 8-8 4 3-9 8-3Z" stroke="currentColor" stroke-width="1.5"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg></div><h2>把直播经营数据接回操盘台</h2><p>在独立的罗盘窗口完成一次登录，即可自动检测今日直播场次，查看在线人数、支付数据和商品表现。数据与登录会话保存在这台电脑。</p><button class="btn primary" data-rpa-action="connect">连接第一个罗盘账号</button><div class="rpa-steps"><span><b>1</b>打开罗盘</span><span><b>2</b>扫码登录</span><span><b>3</b>自动同步</span></div></div>`;
    renderedAccount = '';
  }
  function render() {
    if (!state.accounts.length) { empty(); return; }
    if (!account()) selected = state.accounts[0].id;
    localStorage.setItem('rpaAccount', selected);
    const a = account();
    if (renderedAccount !== selected || !$('rpaAccountList')) {
      $('rpaWorkspace').innerHTML = `<div class="rpa-layout"><aside class="panel"><div class="panel-head"><div class="panel-title">已连接账号</div><span class="panel-subtitle">本机保存</span></div><div id="rpaAccountList"></div></aside><div class="rpa-main"><section class="panel"><div class="rpa-toolbar"><button class="btn" data-rpa-action="login">打开罗盘 / 登录</button><button class="btn primary" data-rpa-action="sync" id="rpaSync">立即同步</button><button class="btn" data-rpa-action="monitor" id="rpaToggle">暂停同步</button><label for="rpaInterval">同步间隔</label><select id="rpaInterval" aria-label="同步间隔"><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option></select></div><div id="rpaAccountError"></div><div class="rpa-meta" id="rpaMeta"></div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">直播场次</div><div class="panel-subtitle">今日发现与本机历史记录</div></div><button class="btn small" data-rpa-action="export" id="rpaExport" disabled>导出本场数据</button></div><div class="panel-body"><label for="rpaRoom" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">选择直播场次</label><select id="rpaRoom" class="rpa-room-picker"></select><div id="rpaDetail"></div></div></section><section class="panel"><div class="panel-head"><div class="panel-title">同步记录</div><div class="panel-subtitle">最近 30 条</div></div><div class="rpa-events" id="rpaEvents"></div></section></div></div>`;
      renderedAccount = selected; room = ''; currentDetail = null;
      $('rpaInterval').addEventListener('change', () => act('settings', { interval: Number($('rpaInterval').value) }));
      $('rpaRoom').addEventListener('change', () => { room = $('rpaRoom').value; loadDetail(); });
    }
    $('rpaAccountList').innerHTML = state.accounts.map(item => `<button class="rpa-account ${item.id === selected ? 'selected' : ''}" data-rpa-account="${esc(item.id)}"><strong>${esc(item.name || item.label)}</strong>${chip(item)}<small>${item.uid ? '账号 ' + esc(item.uid) : '尚未识别账号'}<br>最近同步 ${date(item.lastSync)}</small></button>`).join('');
    $('rpaSync').disabled = a.busy || actionBusy;
    $('rpaSync').textContent = a.busy ? '正在同步…' : '立即同步';
    $('rpaToggle').textContent = a.enabled ? '暂停同步' : '开启同步';
    if (document.activeElement !== $('rpaInterval')) $('rpaInterval').value = String(a.interval);
    $('rpaAccountError').innerHTML = a.error ? `<div class="rpa-account-error">${esc(a.error)}</div>` : '';
    $('rpaMeta').innerHTML = `<span>最近检查 ${date(a.lastCheck)}</span><span>最近成功同步 ${date(a.lastSync)}</span><span>${a.enabled ? '自动同步已开启' : '自动同步已暂停'}</span>`;
    if (!a.rooms.some(r => r.id === room)) room = a.rooms[0]?.id || '';
    const options = a.rooms.map(r => `<option value="${esc(r.id)}">${esc(r.title)} · ${roomState(r)} · ${esc(r.id)}</option>`).join('') || '<option value="">暂无场次</option>';
    if ($('rpaRoom').innerHTML !== options && document.activeElement !== $('rpaRoom')) $('rpaRoom').innerHTML = options;
    $('rpaRoom').value = room;
    const events = state.events.filter(e => e.account === selected);
    $('rpaEvents').innerHTML = events.map(e => `<div class="rpa-event"><time>${date(e.time)}</time><span>${esc(e.message)}</span></div>`).join('') || '<div class="rpa-login-hint">完成连接后，同步结果会记录在这里。</div>';
    if (!room) {
      const title = a.uid ? '今日暂无可展示的直播场次' : '完成罗盘登录，即可开始采集';
      $('rpaDetail').innerHTML = `<div class="rpa-login-hint"><strong>${title}</strong>${a.uid ? '采集器会按设定间隔检查新场次。账号需要拥有对应直播数据的查看权限。' : '点击“打开罗盘 / 登录”，在弹出的 Chrome 窗口扫码或登录。登录成功后，本页面会自动更新。'}<br>采集期间请保留罗盘窗口；关闭窗口会暂停自动同步。</div>`;
      $('rpaExport').disabled = true;
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

  function renderDetail(data) {
    const latest = data.latest;
    $('rpaExport').disabled = !latest;
    if (!latest) { $('rpaDetail').innerHTML = '<div class="rpa-login-hint">已发现此场次，尚未保存指标。采集器每轮优先同步最多 3 个近期场次。</div>'; return; }
    const errors = Object.entries(latest.endpoints).filter(([,v]) => !v.ok);
    const stale = Date.now() - Date.parse(latest.time) > Math.max(180, (account()?.interval || 60) * 3) * 1000;
    $('rpaDetail').innerHTML = `<div class="rpa-note" style="margin-bottom:14px">罗盘后台数据 · 采样时间 ${date(latest.time)}${stale ? ' · 当前为历史快照' : ''}</div>${errors.length ? `<div class="rpa-error-box">部分数据尚未取得：${errors.map(([k,v]) => esc(k + ' · ' + v.error)).join('；')}</div>` : ''}<div class="rpa-metrics">${latest.metrics.map(m => `<div class="rpa-metric"><span>${esc(m.label)}</span><strong>${esc(m.display)}</strong><small>${esc(m.unit || '')}</small></div>`).join('')}</div><div class="rpa-heading"><h2>本机采样趋势</h2><select class="filter" id="rpaMetric" aria-label="趋势指标">${latest.metrics.map(m => `<option value="${esc(m.key)}" ${m.key === metric ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div><div id="rpaChart">${chart(data.history, metric)}</div><p class="rpa-note">金额、时长和比例按接口原值展示，单位以返回值为准；缺失值显示“—”。趋势仅包含这台电脑保存的采样。</p><div class="rpa-heading" style="margin-top:25px"><h2>商品表现</h2><span class="panel-subtitle">${latest.products.length} 个商品</span></div><div class="table-wrap rpa-product-wrap"><table><thead><tr><th>商品</th><th>成交金额</th><th>成交订单</th><th>商品点击人数</th><th>库存</th></tr></thead><tbody>${latest.products.length ? latest.products.map(p => `<tr><td class="rpa-product-name">${esc(p.name)}<div class="account-id">${esc(p.id)}</div></td><td>${value(p.metrics.pay_amt)}</td><td>${value(p.metrics.pay_combo_cnt)}</td><td>${value(p.metrics.product_click_ucnt)}</td><td>${value(p.metrics.stock_cnt)}</td></tr>`).join('') : '<tr><td colspan="5"><div class="table-empty">本次采样没有可展示的商品数据。</div></td></tr>'}</tbody></table></div>`;
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
    if (loading) return loading;
    loading = (async () => {
    try {
      state = await apiRequest('/api/rpa/state'); render();
      status(`本机采集服务已连接 · ${state.accounts.length} 个账号 · 历史采样最多保留 ${state.retentionDays} 天`);
      await loadDetail();
    } catch (e) { status(e.message, true); }
    finally { loading = null; }
    })();
    return loading;
  }
  async function act(action, payload = {}) {
    if (actionBusy || !account()) return;
    actionBusy = true; const a = account();
    status(action === 'login' ? '正在打开独立的罗盘登录窗口…' : '正在提交操作…');
    try {
      if (action === 'monitor') payload = { enabled: !a.enabled };
      await apiRequest(`/api/rpa/accounts/${encodeURIComponent(a.id)}/${action}`, {method:'POST', body:JSON.stringify(payload)});
      toast(action === 'login' ? '请在弹出的罗盘窗口完成登录' : action === 'sync' ? '已开始同步，结果会自动显示' : '设置已保存');
      await refresh();
    } catch (e) { status(e.message, true); toast(e.message); }
    finally { actionBusy = false; if (state) render(); }
  }
  function connect() {
    openModal('连接罗盘账号', '<div class="field"><label for="rpaAccountName">账号备注</label><input id="rpaAccountName" maxlength="60" placeholder="例如：我的直播账号" autocomplete="off"><div class="field-help">随后会打开独立的 Chrome 窗口，请在罗盘完成扫码登录。每个连接使用独立的登录会话。</div></div>', '<button class="btn" id="rpaCancel">取消</button><button class="btn primary" id="rpaCreate">打开罗盘并连接</button>');
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
  $('rpaConnect').onclick = connect;
  $('view-business').addEventListener('click', event => {
    const item = event.target.closest('[data-rpa-account]');
    if (item) { selected = item.dataset.rpaAccount; room = ''; detailVersion++; render(); loadDetail(); return; }
    const action = event.target.closest('[data-rpa-action]')?.dataset.rpaAction;
    if (action === 'connect') connect(); else if (action === 'export') exportData(); else if (action) act(action);
  });
  window.LiveRpa = { refresh };
  setInterval(() => { if (currentView === 'business' && !document.hidden) refresh(); }, 5000);
  if (location.hash === '#business') switchView('business');
})();
