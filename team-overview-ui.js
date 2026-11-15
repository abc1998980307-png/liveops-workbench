(() => {
  const $ = id => document.getElementById(id);
  let overview = null, loading = null, group = 'accounts';
  const escape = value => esc(String(value ?? ''));
  const metric = (item, unit) => item?.value == null ? '—' : `${Number(item.value).toLocaleString('zh-CN', {maximumFractionDigits:2})}${unit}`;
  const coverage = (item, total) => item?.coveredRooms == null ? '' : `<small class="insights-muted">${Number(item.coveredRooms)} / ${Number(total)} 场有值</small>`;

  function render() {
    if (!overview) return;
    if (!$('opsOverviewStart').value && overview.startDate) $('opsOverviewStart').value = overview.startDate;
    if (!$('opsOverviewEnd').value && overview.endDate) $('opsOverviewEnd').value = overview.endDate;
    const total = overview.totalSessions;
    $('opsOverviewStatus').textContent = overview.available === false
      ? '经营场次暂不可读取；本机对应关系与复盘待办仍可查看'
      : `已读取 ${overview.loadedSessions ?? 0} / ${total ?? 0} 场 · 未匹配对应关系 ${overview.unmappedSessions ?? 0} 场${overview.ambiguousSessions ? `（其中同名来源 ${overview.ambiguousSessions} 场）` : ''}${overview.truncated ? ' · 范围超过读取上限，汇总不完整' : ''}`;
    const groups = overview.groups?.[group] || [];
    $('opsOverviewRows').innerHTML = groups.length ? groups.map(item => {
      const recon = item.reconciliation || {};
      const matched = recon.compared ? `${Number(recon.matched)} / ${Number(recon.compared)}（${Math.round(Number(recon.rate || 0) * 100)}%）` : '—';
      return `<tr><td><strong>${escape(item.name)}</strong></td><td class="number">${Number(item.sessions || 0)}</td><td class="number">${metric(item.watch, ' 人次')}${coverage(item.watch, item.sessions)}</td><td class="number">${metric(item.sales, ' 元')}${coverage(item.sales, item.sessions)}</td><td class="number">${metric(item.spend, ' 元')}${coverage(item.spend, item.sessions)}</td><td>${matched}<small class="insights-muted">双方同场采样</small></td></tr>`;
    }).join('') : '<tr><td colspan="6"><div class="table-empty">当前维度没有对应的本机场次</div></td></tr>';
    const todos = overview.todos || [];
    $('opsTodoRows').innerHTML = todos.length ? todos.map(item => `<article class="ops-record"><div><strong>${escape(item.memberName)}</strong><small>${escape(item.actions)}</small><small>${item.dueDate ? `截止 ${escape(item.dueDate)}` : '未设截止日期'}</small></div></article>`).join('')
      : '<div class="ops-empty">暂无已分配给团队成员的复盘行动</div>';
  }

  async function refresh() {
    if (loading) return loading;
    const params = new URLSearchParams();
    if ($('opsOverviewStart').value) params.set('startDate', $('opsOverviewStart').value);
    if ($('opsOverviewEnd').value) params.set('endDate', $('opsOverviewEnd').value);
    const url = '/api/team-overview' + (params.size ? '?' + params : '');
    $('opsOverviewStatus').textContent = '正在读取本机经营数据';
    loading = apiRequest(url).then(result => { overview = result; render(); })
      .catch(error => { $('opsOverviewStatus').textContent = `读取失败：${error.message}`; })
      .finally(() => { loading = null; });
    return loading;
  }
  $('opsOverviewRefresh').addEventListener('click', refresh);
  for (const id of ['opsOverviewStart', 'opsOverviewEnd']) $(id).addEventListener('change', refresh);
  document.querySelectorAll('[data-overview-group]').forEach(button => button.addEventListener('click', () => {
    group = button.dataset.overviewGroup;
    document.querySelectorAll('[data-overview-group]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
    render();
  }));
  window.LiveTeamOverview = {refresh};
  if (location.hash === '#operations') refresh();
})();
