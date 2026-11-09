(() => {
  const host = document.getElementById('keywordWorkspace');
  let state = null, loading = null, filter = '', acting = false;
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '尚未分析';
  const rows = () => (state?.result?.keywords || []).filter(row => row.term.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  function render() {
    if (!state) return;
    const result = state.result;
    const pending = state.busy || acting;
    const labels = {running:'处理中', completed:'完成', failed:'失败，可重试', interrupted:'已中断，可重试'};
    host.innerHTML = `<div class="panel-head"><div><div class="panel-title">本机转写语料关键词</div><div class="panel-subtitle">中文分词与 KeyBERT 语义分析 · 文本留在本机</div></div><span class="tag">${esc(pending ? '处理中' : state.installed ? 'KeyBERT 已安装' : '待安装')}</span></div><div class="panel-body">
      <p class="boundary-copy">${state.installed ? '从本机 TXT / SRT 提取词语，并附原话与字幕时间。同份录屏的 TXT 和 SRT 只计一次。' : '安装独立的关键词组件与约 480 MB 多语言模型后，可以离线分析本机转写。首次安装需要联网下载。'}</p>
      <div class="keyword-toolbar"><button class="btn" data-keyword-action="install" ${pending || !state.canInstall ? 'disabled' : ''}>${state.installed ? '检查安装' : '安装 KeyBERT 与中文模型'}</button><button class="btn primary" data-keyword-action="analyze" ${pending || !state.installed ? 'disabled' : ''}>${state.busy && state.job.action === 'analyze' ? '分析中…' : '分析语料'}</button><button class="btn" data-keyword-action="refresh">刷新状态</button>${state.busy ? '<button class="btn" data-keyword-action="cancel">停止当前任务</button>' : ''}<button class="btn" data-keyword-action="export" ${!rows().length ? 'disabled' : ''}>导出当前结果</button></div>
      <div role="status" class="session-search-meta">${esc(state.job.error || (state.job.status ? `${labels[state.job.status] || state.job.status} · ${state.job.action === 'install' ? '组件安装' : '语料分析'}` : '点击分析语料开始'))}${result ? ` · 上次结果 ${esc(date(result.generatedAt))}` : ''}</div>
      ${state.log ? `<details ${state.busy || state.job.error ? 'open' : ''}><summary>任务日志</summary><pre class="keyword-log">${esc(state.log)}</pre></details>` : ''}
      ${result ? `<p class="boundary-copy">已分析 ${Number(result.filesScanned)} 份语料、${Number(result.characters || 0).toLocaleString('zh-CN')} 字，跳过 ${Number(result.duplicatesSkipped || 0)} 份重复副本。${result.truncated ? `部分语料未分析：${esc((result.warnings || []).join('；'))}` : '已完成所选语料范围。'}${result.candidateLimitReached ? '候选词超过 3,000 个，按出现频率保留前 3,000 个参与语义排序。' : ''}<br>${esc(result.note || '')} 原始转写可能有错字或重复识别，请结合字幕核对。</p><div class="keyword-toolbar"><input type="search" id="keywordLocalFilter" maxlength="100" aria-label="筛选本机关键词" placeholder="筛选已分析关键词" value="${esc(filter)}"><span id="keywordLocalCount"></span></div><div class="keyword-results" id="keywordLocalRows"></div>` : '<div class="table-empty">尚无分析结果。录屏完成并生成文本、字幕后再分析。</div>'}</div>`;
    renderRows();
    const input = document.getElementById('keywordLocalFilter');
    if (input) input.addEventListener('input', () => {filter = input.value; renderRows();});
  }
  function renderRows() {
    const target = document.getElementById('keywordLocalRows');
    if (!target) return;
    document.getElementById('keywordLocalCount').textContent = `${rows().length} 个关键词`;
    host.querySelector('[data-keyword-action="export"]').disabled = !rows().length;
    target.innerHTML = rows().map(row => `<article class="keyword-result"><strong>${esc(row.term)}</strong><p class="boundary-copy">语义分数 ${Number(row.score).toFixed(3)} · 出现 ${Number(row.count)} 次 · ${Number(row.documents)} 份文件</p><details><summary>查看原话与出处</summary>${(row.references || []).map(ref => `<blockquote>${esc(ref.text)}</blockquote><small>${esc(ref.account)} · ${esc(ref.timestamp || 'TXT 无时间码')}<br>${esc(ref.file.split('/').at(-1))}</small><br>${ref.sourceUrl?.startsWith('/transcripts/') ? `<a class="source-link" href="${esc(ref.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开${ref.timestamp ? '字幕' : '文本'}原文 ↗</a>` : ''}`).join('')}</details></article>`).join('') || '<div class="table-empty">没有匹配结果。</div>';
  }
  function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try { state = await apiRequest('/api/transcript-keywords'); render(); }
      catch(error) { host.innerHTML = `<div class="panel-body" role="status">${esc(error.message)} <button class="btn" data-keyword-action="refresh">重试连接</button></div>`; }
      finally { loading = null; }
    })();
    return loading;
  }
  host.addEventListener('click', async event => {
    const action = event.target.closest('[data-keyword-action]')?.dataset.keywordAction;
    if (!action) return;
    if (action === 'refresh') return refresh();
    if (action === 'export') {
      const records = rows().flatMap(row => (row.references || []).map(ref => [row.term,row.score,row.count,row.documents,ref.file,ref.timestamp,ref.text,state.result.generatedAt]));
      downloadCsv('本机转写关键词.csv', [['关键词','语义分数','出现次数','文件数','出处','字幕时间','原话','分析时间'],...records]);
      return;
    }
    if (acting || (state?.busy && action !== 'cancel')) return;
    acting = true; render();
    try { state = await apiRequest(`/api/transcript-keywords/${action}`, {method:'POST', body:'{}'}); }
    catch(error) { toast(error.message); }
    finally { acting = false; render(); }
  });
  window.LiveKeywords = {refresh};
  setInterval(() => { if (currentView === 'keywords' && state?.busy && !document.hidden) refresh(); }, 2500);
  if (location.hash === '#keywords') refresh();
})();
