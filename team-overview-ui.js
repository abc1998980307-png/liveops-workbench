(() => {
  const $ = id => document.getElementById(id);
  let overview = null, loading = null, group = 'accounts', saving = false;
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
      return `<tr><td><strong>${escape(item.name)}</strong></td><td class="number">${Number(item.sessions || 0)}</td><td class="number">${metric(item.watch, ' 人次')}${coverage(item.watch, item.sessions)}</td><td class="number">${metric(item.sales, ' 元')}${coverage(item.sales, item.sessions)}</td><td class="number">${item.refundCount?.value == null ? '未采集' : metric(item.refundCount, ' 笔')}${coverage(item.refundCount, item.sessions)}</td><td class="number">${item.refundAmount?.value == null ? '未采集' : metric(item.refundAmount, ' 元')}${coverage(item.refundAmount, item.sessions)}</td><td class="number">${metric(item.spend, ' 元')}${coverage(item.spend, item.sessions)}</td><td>${matched}<small class="insights-muted">双方同场采样</small></td></tr>`;
    }).join('') : '<tr><td colspan="8"><div class="table-empty">当前维度没有对应的本机场次</div></td></tr>';
    const todos = overview.todos || [];
    $('opsTodoRows').innerHTML = todos.length ? todos.map(item => `<article class="ops-record"><div><strong>${escape(item.memberName)}</strong><small>${escape(item.actions)}</small><small>${item.dueDate ? `截止 ${escape(item.dueDate)}` : '未设截止日期'}</small></div></article>`).join('')
      : '<div class="ops-empty">暂无已分配给团队成员的复盘行动</div>';
    const confirmations = overview.sourceConfirmations || [];
    const active = new Map(confirmations.filter(item => !item.revokedAt).map(item => [item.sourceRef, item]));
    const mappings = (overview.mappings || []).filter(item => item.active);
    const candidates = overview.sourceCandidates || [];
    $('opsSourceRows').innerHTML = candidates.length ? candidates.map(item => {
      const current = active.get(item.sourceRef);
      const options = mappings.filter(mapping => mapping.sourceAlias.toLocaleLowerCase() === item.sourceAlias.toLocaleLowerCase());
      return `<article class="ops-record"><div><strong>${escape(item.sourceAlias)} · 来源 ${escape(item.sourceRef.slice(0, 8))}</strong><small>${Number(item.sessions) || 0} 场${item.sampleTitle ? ` · 最近场次 ${escape(item.sampleTitle)}` : ''}</small></div><div class="ops-record-actions">${current ? `<span class="ops-state">已确认</span><button class="btn small" type="button" data-source-revoke="${escape(current.id)}" ${saving ? 'disabled' : ''}>撤销</button>` : `<select data-source-mapping="${escape(item.sourceRef)}" aria-label="选择 ${escape(item.sourceAlias)} 的直播号">${options.map(mapping => `<option value="${escape(mapping.id)}">${escape(mapping.name)}</option>`).join('')}</select><button class="btn small" type="button" data-source-confirm="${escape(item.sourceRef)}" data-source-alias="${escape(item.sourceAlias)}" ${!options.length || saving ? 'disabled' : ''}>确认</button>`}</div></article>`;
    }).join('') : '<div class="ops-empty">当前没有需要确认的重名来源</div>';
    $('opsSourceAudit').innerHTML = confirmations.length ? [...confirmations].reverse().map(item => {
      const mapping = (overview.mappings || []).find(entry => entry.id === item.mappingId);
      return `<article class="ops-record"><div><strong>${escape(item.sourceAlias)} · ${escape(mapping?.name || '直播号已移除')}</strong><small>${escape(item.confirmedBy)} 于 ${escape(item.confirmedAt)} 确认 · 来源 ${escape((item.sourceRef || '').slice(0, 8))}</small>${item.revokedAt ? `<small>${escape(item.revokedBy)} 于 ${escape(item.revokedAt)} 撤销</small>` : ''}</div><span class="ops-state">${item.revokedAt ? '已撤销' : '有效'}</span></article>`;
    }).join('') : '<div class="ops-empty">暂无归属确认记录</div>';
  }

  async function sourceAction(path, payload) {
    if (saving) return;
    const actor = $('opsSourceActor').value.trim();
    if (!actor) { $('opsSourceStatus').textContent = '请先填写确认人'; return; }
    saving = true;
    $('opsSourceStatus').textContent = '正在保存本机归属记录';
    try {
      await apiRequest(path, {method:'POST', body:JSON.stringify({...payload, actor})});
      await refresh();
      $('opsSourceStatus').textContent = '已保存本机归属记录';
      render();
    } catch (error) { $('opsSourceStatus').textContent = `保存失败：${error.message}`; }
    finally { saving = false; render(); }
  }
  $('opsSourceRows').addEventListener('click', event => {
    const confirm = event.target.closest('[data-source-confirm]');
    const revoke = event.target.closest('[data-source-revoke]');
    if (confirm) {
      const mappingId = document.querySelector(`[data-source-mapping="${confirm.dataset.sourceConfirm}"]`)?.value;
      if (mappingId) sourceAction('/api/team-overview/confirm', {sourceRef:confirm.dataset.sourceConfirm,
        sourceAlias:confirm.dataset.sourceAlias, mappingId});
    } else if (revoke) sourceAction('/api/team-overview/revoke', {confirmationId:revoke.dataset.sourceRevoke});
  });

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
