(() => {
  const $ = id => document.getElementById(id);
  let state = null, loading = null, actionBusy = false, localError = '';
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}) : '尚无记录';
  const count = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '0';
  const fieldName = field => typeof field === 'string' ? field : field?.name || '';
  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn')) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function render() {
    const host = $('feishuWorkspace');
    if (!state) {
      host.innerHTML = `<section class="panel feishu-panel"><div class="panel-head"><div class="panel-title">飞书多维表格</div><button class="btn small" data-feishu-action="refresh">重试连接</button></div><div class="panel-body"><p class="feishu-error" role="status">${esc(localError || '正在读取表格同步配置…')}</p></div></section>`;
      return;
    }
    const configured = state.configured, busy = state.busy || actionBusy;
    const error = localError || state.error;
    const status = busy ? '正在处理…' : error ? '需要处理' : !configured ? (state.url ? '表格已绑定 · 待授权' : '待配置') : state.enabled ? '自动同步已开启' : '自动同步已暂停';
    const selected = (state.accounts || []).filter(a => (state.accountIds || []).includes(a.id));
    const link = safeLink(state.url);
    const fields = state.fields || [];
    const missing = state.missingFields || [];
    host.innerHTML = `<section class="panel feishu-panel" aria-labelledby="feishuTitle"><div class="panel-head"><div><div class="panel-title" id="feishuTitle">飞书多维表格</div><div class="panel-subtitle">采集后自动更新 · 每个账号、每场直播一条记录</div></div><span class="feishu-badge ${error ? 'error' : state.enabled ? 'active' : ''}" role="status" aria-live="polite">${esc(status)}</span></div><div class="panel-body">
      ${configured ? `<div class="feishu-destination"><div><span class="feishu-label">同步目的地</span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="feishu-target">打开飞书多维表格 ↗</a>` : '<strong>已保存表格配置</strong>'}<span class="feishu-note">同步账号：${esc(selected.map(a => a.name || a.label).join('、') || '尚未选择')}</span></div><button class="btn small" data-feishu-action="configure" ${busy ? 'disabled' : ''}>修改配置</button></div><div class="feishu-stats"><div><span>待同步场次</span><strong>${count(state.pending)}</strong></div><div><span>已同步场次</span><strong>${count(state.synced)}</strong></div><div><span>最近写入成功</span><strong class="feishu-time">${esc(date(state.lastSuccess))}</strong></div></div>` : `<div class="feishu-intro"><div class="feishu-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M3 9h18M9 9v11M15 9v11M3 14h18" stroke="currentColor" stroke-width="1.5"/></svg></div><div><h2>直播数据，自动填进你的飞书表格</h2><p>连接多维表格并选择账号后，工作台会把每场直播的最新经营指标写入表格，后续采集持续更新同一条记录。</p></div><button class="btn primary" data-feishu-action="configure">连接多维表格</button></div>`}
      ${!configured && link ? `<div class="feishu-destination"><div><span class="feishu-label">已绑定的多维表格</span><a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="feishu-target">打开直播经营数据表 ↗</a><span class="feishu-note">表格链接已保存，完成应用授权后即可开启自动同步。</span></div></div>` : ''}
      ${error ? `<div class="feishu-error" role="status">${esc(error)}${state.nextRetry ? `<span>下次重试：${esc(date(state.nextRetry))}</span>` : ''}</div>` : ''}
      ${configured && state.lastTest ? `<p class="feishu-note">最近读取检查 ${esc(date(state.lastTest))}（写入权限以实际同步结果为准）${missing.length ? ` · 首次同步将补充 ${missing.length} 个字段` : ''}</p>` : ''}
      <div class="feishu-actions">${configured ? `<button class="btn primary" data-feishu-action="monitor" ${actionBusy || (busy && !state.enabled) ? 'disabled' : ''}>${state.enabled ? '暂停自动同步' : '开启自动同步'}</button><button class="btn" data-feishu-action="sync" ${busy ? 'disabled' : ''}>立即同步到飞书</button><button class="btn" data-feishu-action="check" ${busy ? 'disabled' : ''}>检查连接</button>` : ''}<span class="feishu-note">${configured ? '工作台服务运行时自动同步；暂无直播数据时等待采集。' : '使用飞书官方接口，需配置自建应用和表格编辑权限。'}</span></div>
      <details class="feishu-fields"><summary>查看同步内容与写入规则</summary><p>包含账号、直播场次、直播状态、采样时间，以及在线人数、支付人数、成交金额、成交订单、千次观看成交额、观看支付转化、平均观看时长和新增关注。同时写入商品数量与商品明细 JSON，便于后续分析。</p><p>首次同步会在目标数据表新增缺少的标准字段。同一账号、同一场直播更新同一条记录；其他列不受影响。标准字段均为文本列：金额、比例保留展示值与单位，数字原值另存 JSON，缺失数据不填成 0。</p>${fields.length ? `<div class="feishu-field-list">${fields.map(field => `<span>${esc(fieldName(field))}</span>`).join('')}</div>` : ''}${missing.length ? `<p>待补充字段：${esc(missing.map(fieldName).join('、'))}</p>` : ''}</details>
    </div></section>`;
  }
  function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try { state = await apiRequest('/api/rpa/feishu/state'); localError = ''; render(); }
      catch (error) { localError = error.message; render(); }
      finally { loading = null; }
    })();
    return loading;
  }
  async function action(name) {
    if (actionBusy || (state?.busy && !(name === 'monitor' && state.enabled))) return;
    if (name === 'refresh') { localError = ''; return refresh(); }
    if (name === 'configure') return configure();
    actionBusy = true; localError = ''; render();
    try {
      await apiRequest(`/api/rpa/feishu/${name}`, {method:'POST', body:JSON.stringify(name === 'monitor' ? {enabled:!state.enabled} : {})});
      toast(name === 'check' ? '正在检查授权与字段，结果将自动显示' : name === 'sync' ? '已开始同步，结果将自动显示' : '自动同步设置已更新');
      if (loading) await loading;
      await refresh();
    } catch (error) { localError = error.message; toast(error.message); }
    finally { actionBusy = false; render(); }
  }
  function configure() {
    if (!state) return;
    const existing = state;
    openModal('连接飞书多维表格', `<form id="feishuForm" class="feishu-form" autocomplete="off"><ol class="feishu-setup"><li>在 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开放平台 ↗</a> 创建企业自建应用，开通多维表格读写权限（bitable:app），并发布版本。</li><li>在目标多维表格右上角“…”中的“添加文档应用”添加该应用，授予可编辑权限；开启高级权限时需授予可管理权限。</li><li>打开要填入的数据表，复制带有 <code>table=tbl…</code> 的链接，并填写应用凭证（知识库 /wiki/ 链接请先打开原多维表格）。</li></ol><div class="field"><label for="feishuUrl">多维表格链接</label><input id="feishuUrl" type="url" required maxlength="2048" placeholder="https://你的企业.feishu.cn/base/…?table=tbl…" value="${esc(existing.url || '')}"></div><div class="field"><label for="feishuAppId">App ID</label><input id="feishuAppId" required maxlength="200" placeholder="cli_…" value="${esc(existing.appId || '')}" spellcheck="false"></div><div class="field"><label for="feishuSecret">App Secret ${existing.hasSecret ? '（已保存，留空保留）' : ''}</label><input id="feishuSecret" type="password" ${existing.hasSecret ? '' : 'required'} maxlength="500" autocomplete="new-password" placeholder="${existing.hasSecret ? '仅更换密钥时填写' : '在开放平台的「凭证与基础信息」复制'}"><div class="field-help">密钥仅保存在这台电脑，不会写入多维表格。</div></div><fieldset class="feishu-accounts"><legend>需要同步的罗盘账号</legend>${(existing.accounts || []).length ? existing.accounts.map(a => `<label><input type="checkbox" name="feishuAccounts" value="${esc(a.id)}" ${(existing.accountIds || []).includes(a.id) ? 'checked' : ''}><span>${esc(a.name || a.label)}</span></label>`).join('') : '<p>请先在经营数据页面连接一个罗盘账号。</p>'}<p>仅同步勾选的账号。之后新连接的账号不会自动加入。</p></fieldset><p class="feishu-note">保存后先检查连接。保存配置会暂停自动同步，检查通过后可在卡片上开启。首次写入会补充缺少的标准字段，每场直播更新一条记录。</p><p id="feishuFormError" class="feishu-form-error" role="alert"></p></form>`, '<button class="btn" id="feishuCancel">取消</button><button class="btn primary" id="feishuSave" type="submit" form="feishuForm">保存并检查连接</button>');
    $('feishuCancel').onclick = closeModal;
    const form = $('feishuForm');
    $('feishuAppId').addEventListener('input', () => {
      $('feishuSecret').required = !existing.hasSecret || $('feishuAppId').value.trim() !== (existing.appId || '');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (actionBusy) return;
      const ids = [...form.querySelectorAll('input[name="feishuAccounts"]:checked')].map(input => input.value);
      if (!ids.length) { $('feishuFormError').textContent = '请至少选择一个需要同步的罗盘账号。'; return; }
      const payload = {url:$('feishuUrl').value.trim(), appId:$('feishuAppId').value.trim(), appSecret:$('feishuSecret').value, accountIds:ids, enabled:existing.enabled === true};
      actionBusy = true; $('feishuSave').disabled = true; $('feishuSave').textContent = '正在保存…'; $('feishuFormError').textContent = '';
      try {
        await apiRequest('/api/rpa/feishu/settings', {method:'POST', body:JSON.stringify(payload)});
        payload.appSecret = ''; if ($('feishuSecret')) $('feishuSecret').value = '';
        localError = '';
        if ($('feishuForm') === form) closeModal();
        await apiRequest('/api/rpa/feishu/check', {method:'POST', body:'{}'});
        toast('配置已保存，正在检查飞书连接');
        if (loading) await loading;
        await refresh();
      } catch (error) {
        payload.appSecret = '';
        localError = error.message;
        if ($('feishuForm') === form && $('modalBackdrop').classList.contains('open')) $('feishuFormError').textContent = error.message;
        else toast(error.message);
      } finally {
        actionBusy = false;
        if ($('feishuForm') === form) { $('feishuSave').disabled = false; $('feishuSave').textContent = '保存并检查连接'; }
        render();
      }
    });
    $('feishuUrl').focus();
  }
  // The shared modal hides rather than destroys its content; clear password inputs on close.
  new MutationObserver(() => {
    if (!$('modalBackdrop').classList.contains('open') && $('feishuSecret')) $('feishuSecret').value = '';
  }).observe($('modalBackdrop'), {attributes:true, attributeFilter:['class']});
  $('feishuWorkspace').addEventListener('click', event => {
    const name = event.target.closest('[data-feishu-action]')?.dataset.feishuAction;
    if (name) action(name);
  });
  window.LiveFeishu = {refresh};
  setInterval(() => { if (currentView === 'business' && !document.hidden) refresh(); }, 5000);
  if (currentView === 'business' || location.hash === '#business') refresh();
})();
