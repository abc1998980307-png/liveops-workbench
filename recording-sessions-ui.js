(() => {
  const $ = id => document.getElementById(id);
  let loading = false;
  const submitting = new Set();
  let recordingSessions = [];
  let recordingArchives = [];
  let selectedReviewId = '';
  let reviewSaving = false;
  let reviewSaveVersion = 0;
  let reviewsFetchedAt = 0;
  const reviews = new Map();
  const reviewDrafts = new Map();
  const duration = value => {
    if (!Number.isFinite(value)) return '等待进度';
    const seconds = Math.floor(value / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  const reasons = {normal:'正常结束（录制器报告）', user_stop:'用户停止（录制器报告）'};
  function reviewFields() {
    return {summary: $('sessionReviewSummary').value.trim(), actions: $('sessionReviewActions').value.trim()};
  }
  function updateReviewControls() {
    const saved = reviews.get(selectedReviewId);
    const fields = reviewFields();
    const changed = !saved || fields.summary !== saved.summary || fields.actions !== saved.actions;
    $('saveSessionReview').disabled = reviewSaving || !selectedReviewId || !fields.summary || !changed;
    $('exportSessionReview').disabled = reviewSaving || !saved || changed;
    if (selectedReviewId && !reviewSaving) {
      $('sessionReviewStatus').textContent = changed && (fields.summary || fields.actions)
        ? '有未保存的修改。' : saved ? `已保存 · ${formatTime(saved.updatedAt)}` : '这场录制尚无复盘记录。';
    }
  }
  function renderReviewSource() {
    const session = recordingSessions.find(item => item.id === selectedReviewId);
    const archive = recordingArchives.find(item => item.sessionId === selectedReviewId);
    $('sessionReviewSource').textContent = session
      ? `${session.account || '未命名直播间'} · ${formatTime(session.startedAt)} 开始 · ${session.endedAt ? '录制已结束' : '录制未确认结束'} · ${archive?.status === 'completed' ? '已有归档' : '归档未完成'}。经营指标尚未关联，此处仅保存录制场次复盘。`
      : selectedReviewId ? '该场次不在最近的录制列表中，已保存内容仍可编辑。' : '选择场次后查看录制与归档状态。';
  }
  function selectReview(id) {
    selectedReviewId = id;
    $('sessionReviewSelect').value = id;
    const source = reviewDrafts.get(id) || reviews.get(id) || {summary:'', actions:''};
    $('sessionReviewSummary').value = source.summary;
    $('sessionReviewActions').value = source.actions;
    $('sessionReviewStatus').textContent = id ? '正在读取复盘记录。' : '尚未选择场次。';
    renderReviewSource();
    updateReviewControls();
  }
  function renderReviewOptions() {
    const options = [{value:'', label:'选择录制场次'}, ...recordingSessions.map(session => ({value:session.id, label:`${session.account || '未命名直播间'} · ${formatTime(session.startedAt)}`}))];
    for (const review of reviews.values()) {
      if (!recordingSessions.some(session => session.id === review.sessionId)) {
        options.push({value:review.sessionId, label:`历史复盘 · ${formatTime(review.updatedAt)}`});
      }
    }
    if (selectedReviewId && !options.some(option => option.value === selectedReviewId)) {
      options.push({value:selectedReviewId, label:'正在编辑的历史场次'});
    }
    const select = $('sessionReviewSelect');
    if (select.options.length !== options.length || options.some((option, index) => select.options[index]?.value !== option.value || select.options[index]?.text !== option.label)) {
      select.innerHTML = options.map(option => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');
    }
    select.value = selectedReviewId;
    renderReviewSource();
    updateReviewControls();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const data = await apiRequest('/api/recording-sessions');
      recordingSessions = data.sessions || [];
      recordingArchives = data.archives || [];
      renderReviewOptions();
      if (!reviewsFetchedAt || Date.now() - reviewsFetchedAt >= 60000) {
        try {
          const saveVersion = reviewSaveVersion;
          const saved = await apiRequest('/api/session-reviews');
          if (saveVersion === reviewSaveVersion) {
            reviews.clear();
            for (const review of saved.reviews || []) reviews.set(review.sessionId, review);
            reviewsFetchedAt = Date.now();
            renderReviewOptions();
          }
        } catch (error) {
          $('sessionReviewStatus').textContent = '复盘记录读取失败：' + error.message;
        }
      }
      $('recordingSessionStatus').textContent = `${data.error ? data.error + '。' : ''}${data.note || ''}${data.truncated ? ' 仅显示最近 50 场。' : ''}${data.checkedAt ? ' 最近检查 ' + formatTime(data.checkedAt) : ''}`;
      const archives = data.archives || [];
      $('recordingSessionRows').innerHTML = data.sessions.length ? data.sessions.map(session => {
        const states = {recording:'录制中', ended:'已结束', waiting:'等待续录 / 结束确认', unknown:'状态待确认'};
        const segments = session.segments || [];
        const current = segments.at(-1);
        const switches = (session.events || []).filter(e => e.type === 'file_changed').length;
        const gaps = (session.events || []).filter(e => e.type === 'observation_gap').length;
        const archive = archives.find(item => item.sessionId === session.id);
        const busy = submitting.has(session.id) || ['queued', 'processing'].includes(archive?.status);
        const archiveButton = session.endedAt && segments.length && (!archive || archive.status !== 'completed') ? `<button class="btn small" type="button" data-archive-session="${esc(session.id)}" ${busy ? 'disabled' : ''}>${busy ? esc(archive?.stage || '提交归档中…') : archive?.canRetry ? '重试长录制归档' : '生成长录制归档'}</button>` : '';
        const reviewButton = `<button class="btn small" type="button" data-review-session="${esc(session.id)}">${reviews.has(session.id) ? '查看复盘' : '写复盘'}</button>`;
        const archiveInfo = archive ? `<div class="session-note">${archive.status === 'completed' ? `已生成归档${archive.unknownGaps ? '，仍有无法确认的间断' : ''}。${archive.merge?.mode === 'single_segment' ? '单片段使用现有压缩视频，不另存一份。' : ''}` : ['queued', 'processing'].includes(archive.status) ? esc(archive.stage || '归档处理中') + '；可以离开本页，任务继续在后台运行。' : '归档失败，可查看原因后重试。'}${archive.missingArtifacts?.length ? ` 缺少：${esc(archive.missingArtifacts.join('、'))}。` : ''}${archive.error ? `<details><summary>查看归档失败原因</summary><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(archive.error)}</p></details>` : ''}${archive.videoPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.videoPath)}">打开归档视频位置</button>` : ''}${archive.transcriptPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.transcriptPath)}">打开归档文本位置</button>` : ''}${archive.subtitlesPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.subtitlesPath)}">打开归档字幕位置</button>` : ''}${archive.manifestPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.manifestPath)}">打开归档清单位置</button>` : ''}</div>` : '';
        return `<article class="session-hit"><div><div class="session-hit-title">${esc(session.account || '未命名直播间')} · ${esc(states[session.state] || '状态待确认')}</div><div class="session-hit-file">开始 ${esc(formatTime(session.startedAt))}${session.endedAt ? ' · 结束 ' + esc(formatTime(session.endedAt)) : ''}</div><p class="session-hit-text">${current ? `最近片段 ${duration(current.mediaDurationMs)} · ${formatBytes(current.bytes)}` : '尚未观察到片段文件'} · 已观察 ${segments.length} 个片段 · ${switches} 次文件切换</p><div class="session-note">${session.endedAt ? esc(reasons[session.endReason] || '结束原因：' + (session.endReason || '未知')) + '。' : ''}历史片段可能缺失；文件切换的原因和准确缺口待确认。${gaps ? ` 有 ${gaps} 次观察中断。` : ''}</div><div class="button-row">${archiveButton}${reviewButton}</div>${archiveInfo}${segments.length ? `<details><summary>查看片段与观察记录</summary>${segments.map(s => `<div class="session-hit-file">${esc(s.path)} · ${duration(s.mediaDurationMs)}${s.closedObservedAt ? ' · 观察结束' : ''}${s.recordingPath ? ` <button class="table-action" type="button" data-recording-path="${esc(s.recordingPath)}">打开文件位置</button>` : ' · 文件已移走或目录已更改'}</div>`).join('')}${(session.events || []).map(e => `<div class="session-hit-file">${esc(formatTime(e.from))} → ${esc(formatTime(e.to))}：${esc(e.note)}</div>`).join('')}</details>` : ''}</div><span class="tag">本机录制场次</span></article>`;
      }).join('') : '<p class="session-note">尚未取得录制场次记录。正在录制时会自动记录；未启动录制器不会自动启动录制。</p>';
      document.querySelectorAll('[data-archive-session]').forEach(button => button.addEventListener('click', async () => {
        const id = button.dataset.archiveSession;
        if (submitting.has(id)) return;
        submitting.add(id);
        button.disabled = true;
        button.textContent = '提交归档中…';
        try {
          const result = await apiRequest('/api/recording-sessions/archive', {method: 'POST', body: JSON.stringify({sessionId: id})});
          toast(result.status === 'completed' ? '归档已完成' : '已加入归档队列，可离开本页');
        } catch (error) {
          toast('归档提交未确认：' + error.message + '；请查看任务状态');
        } finally {
          submitting.delete(id);
          await refresh();
        }
      }));
      document.querySelectorAll('[data-review-session]').forEach(button => button.addEventListener('click', () => {
        selectReview(button.dataset.reviewSession);
        $('sessionReviewPanel').scrollIntoView({behavior:'smooth', block:'start'});
        $('sessionReviewSummary').focus();
      }));
    } catch (error) {
      $('recordingSessionStatus').textContent = '场次读取失败：' + error.message;
    } finally { loading = false; }
  }
  $('sessionReviewSelect').addEventListener('change', event => selectReview(event.target.value));
  for (const field of [$('sessionReviewSummary'), $('sessionReviewActions')]) {
    field.addEventListener('input', () => {
      if (selectedReviewId) reviewDrafts.set(selectedReviewId, reviewFields());
      updateReviewControls();
    });
  }
  $('sessionReviewForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedReviewId || reviewSaving) return;
    const fields = reviewFields();
    if (!fields.summary) return;
    reviewSaving = true;
    updateReviewControls();
    $('sessionReviewStatus').textContent = '正在保存复盘…';
    let saveError = null;
    try {
      const {review} = await apiRequest('/api/session-reviews', {method:'POST', body:JSON.stringify({sessionId:selectedReviewId, ...fields})});
      reviews.set(review.sessionId, review);
      reviewSaveVersion += 1;
      reviewDrafts.delete(review.sessionId);
      toast('复盘已保存');
    } catch (error) {
      saveError = error.message;
      toast('复盘保存失败');
    } finally {
      reviewSaving = false;
      updateReviewControls();
      if (saveError) $('sessionReviewStatus').textContent = '保存失败：' + saveError;
    }
  });
  $('exportSessionReview').addEventListener('click', async () => {
    if (!selectedReviewId || $('exportSessionReview').disabled) return;
    const button = $('exportSessionReview');
    button.disabled = true;
    try {
      const response = await fetch(`/api/session-reviews/export?sessionId=${encodeURIComponent(selectedReviewId)}`);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `本机服务返回 ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `场次复盘-${selectedReviewId}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('复盘已导出');
    } catch (error) {
      toast('导出失败：' + error.message);
    } finally { updateReviewControls(); }
  });
  $('refreshRecordingSessions').addEventListener('click', refresh);
  setInterval(() => { if (currentView === 'sessions' && !document.hidden) refresh(); }, 5000);
  refresh();
})();
