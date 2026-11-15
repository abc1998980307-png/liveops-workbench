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
  const businessLinks = new Map();
  let businessAccounts = [];
  let businessAccountId = '';
  let businessRoomId = '';
  let businessRooms = [];
  let businessPage = {offset:0, total:0, hasMore:false};
  let businessDetail = null;
  let businessIndexFetchedAt = 0;
  let businessIndexLoading = null;
  let businessRoomsVersion = 0;
  let businessDetailVersion = 0;
  let businessBusy = false;
  let businessRoomsLoading = false;
  let businessError = '';
  let businessRoomError = '';
  let businessActionMessage = '';
  const duration = value => {
    if (!Number.isFinite(value)) return '等待进度';
    const seconds = Math.floor(value / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  const reasons = {normal:'正常结束（录制器报告）', user_stop:'用户停止（录制器报告）'};
  function businessTime(value) {
    if (value === null || value === undefined || value === '') return '时间未保存';
    const raw = String(value);
    if (/^\d{10}$/.test(raw)) return formatTime(Number(raw) * 1000);
    if (/^\d{13}$/.test(raw)) return formatTime(Number(raw));
    return Number.isNaN(Date.parse(raw)) ? raw : formatTime(raw);
  }
  function reviewFields() {
    return {summary: $('sessionReviewSummary').value.trim(), issues: $('sessionReviewIssues').value.trim(),
      evidenceAt: $('sessionReviewEvidenceAt').value, owner: $('sessionReviewOwner').value.trim(),
      actions: $('sessionReviewActions').value.trim(), dueDate: $('sessionReviewDueDate').value};
  }
  function updateReviewControls() {
    const saved = reviews.get(selectedReviewId);
    const fields = reviewFields();
    const changed = !saved || Object.entries(fields).some(([key, value]) => value !== (saved[key] || ''));
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
    const linked = businessLinks.has(selectedReviewId);
    $('sessionReviewSource').textContent = session
      ? `${session.account || '未命名直播间'} · ${formatTime(session.startedAt)} 开始 · ${session.endedAt ? '录制已结束' : '录制未确认结束'} · ${archive?.status === 'completed' ? '已有归档' : '归档未完成'}。${linked ? '已关联罗盘经营场次，指标状态见下方。' : '经营指标尚未关联。'}`
      : selectedReviewId ? '该场次不在最近的录制列表中，已保存内容仍可编辑。' : '选择场次后查看录制与归档状态。';
  }
  function currentBusinessLink() { return businessLinks.get(selectedReviewId); }
  function setSelectOptions(select, options, value) {
    const markup = options.map(option => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');
    if (select.innerHTML !== markup) select.innerHTML = markup;
    select.value = value;
  }
  function renderBusinessLink() {
    const linked = currentBusinessLink();
    const accountOptions = [{value:'', label:'选择经营账号'}, ...businessAccounts.map(account => ({
      value:account.id, label:`${account.name || account.label || '未命名账号'} · UID ${account.uid || '未核验'}${account.enabled ? '' : ' · 采集已暂停'}`
    }))];
    if (linked && !businessAccounts.some(account => account.id === linked.accountId)) {
      accountOptions.push({value:linked.accountId, label:`${linked.accountLabel || '原经营账号'} · 当前不可用`});
    }
    setSelectOptions($('sessionLinkAccount'), accountOptions, businessAccountId);
    $('sessionLinkAccount').disabled = !selectedReviewId || businessBusy || !businessAccounts.length;
    const roomOptions = [{value:'', label:businessRoomsLoading ? '正在读取经营场次' : '选择经营场次'},
      ...businessRooms.map(room => ({value:String(room.id), label:`${room.title || '未命名场次'} · ${businessTime(room.startedAt)} 开始 · ID ${room.id}`}))];
    if (linked && businessAccountId === linked.accountId && !businessRooms.some(room => String(room.id) === linked.roomId)) {
      roomOptions.push({value:linked.roomId, label:`当前关联 · ${linked.roomTitle || linked.roomId} · ID ${linked.roomId}`});
    }
    setSelectOptions($('sessionLinkRoom'), roomOptions, businessRoomId);
    $('sessionLinkRoom').disabled = !selectedReviewId || !businessAccountId || businessBusy || businessRoomsLoading || roomOptions.length === 1;
    const pageStart = businessPage.total ? businessPage.offset + 1 : 0;
    const pageEnd = Math.min(businessPage.offset + businessRooms.length, businessPage.total);
    $('sessionLinkPage').textContent = businessRoomError || (businessRoomsLoading ? '正在读取本机经营场次…' : businessAccountId ? businessPage.total ? `${pageStart}–${pageEnd} / ${businessPage.total} 场` : '该账号本机暂无已保存场次' : '选择罗盘账号查看本机已保存场次');
    $('sessionLinkPrevious').disabled = businessBusy || businessRoomsLoading || businessPage.offset === 0;
    $('sessionLinkNext').disabled = businessBusy || businessRoomsLoading || !businessPage.hasMore;
    const account = businessAccounts.find(item => item.id === businessAccountId);
    const same = linked && linked.accountId === businessAccountId && linked.roomId === businessRoomId;
    $('sessionLinkConfirmed').disabled = !selectedReviewId || !businessAccountId || !businessRoomId || businessBusy || !account?.uid || !!same;
    $('saveSessionLink').disabled = $('sessionLinkConfirmed').disabled || !$('sessionLinkConfirmed').checked;
    $('saveSessionLink').textContent = businessBusy ? '正在保存…' : linked ? same ? '已关联' : '确认改绑' : '确认关联';
    $('removeSessionLink').disabled = !selectedReviewId || !linked || businessBusy;
    $('sessionLinkStatus').textContent = businessActionMessage || businessError || (selectedReviewId && !businessAccounts.length ? '尚无可选罗盘账号；请先在经营与复盘 → 经营数据中添加账号并保存场次。' : selectedReviewId && businessAccountId && !account?.uid ? '该经营账号尚未核验 UID，暂不能关联。' : '关联只读取本机记录，不会启动已暂停的罗盘采集。');
    if (!selectedReviewId) {
      $('sessionLinkCurrent').textContent = '选择录制场次后查看经营数据关联。';
    } else if (!linked) {
      $('sessionLinkCurrent').textContent = '尚未关联经营场次。请核对两侧账号和开播时间后手动确认。';
    } else {
      const heading = `已关联：${linked.accountLabel || '罗盘账号'} · ${linked.roomTitle || '未命名场次'} · ID ${linked.roomId} · 罗盘开始 ${businessTime(linked.roomStartedAt)} · 关联于 ${formatTime(linked.linkedAt)}。`;
      const detail = businessDetail;
      const state = detail?.status;
      const reused = Object.entries(detail?.endpoints || {}).filter(([, item]) => item?.reused)
        .map(([name, item]) => `${name} ${formatTime(item.retrievedAt)}`);
      const note = !detail ? '正在检查本机经营指标。' : state === 'ready'
        ? `${detail.source === 'history_report' ? '罗盘历史报表最近读取于' : '本机实时快照采样于'} ${formatTime(detail.sampledAt)}，以下是原值与单位。${reused.length ? `沿用先前接口结果：${reused.join('、')}。` : ''}`
        : detail.note || ({unavailable:'本机经营数据暂不可读取。', identity_changed:'经营账号身份已变化，指标已隐藏。', room_missing:'原经营场次不在本机记录中。', no_snapshot:'该场次暂无本机指标快照。'}[state] || '经营数据状态待确认。');
      const history = detail?.source !== 'history_report' ? detail?.historyReport : null;
      const historyReused = Object.entries(history?.endpoints || {}).filter(([, item]) => item?.reused)
        .map(([name, item]) => `${name} ${formatTime(item.retrievedAt)}`);
      const historyMarkup = state === 'ready' && history ? `<details><summary>历史报表 · ${esc(formatTime(history.retrievedAt))} · ${history.metrics?.length || 0} 项指标</summary>${historyReused.length ? `<p>沿用先前接口结果：${esc(historyReused.join('、'))}</p>` : ''}<div class="review-link-metrics">${(history.metrics || []).map(metric => `<div>${esc(metric.label || metric.key || '指标')}<strong>${esc(metric.display ?? '—')}${metric.unit ? ' ' + esc(metric.unit) : ''}</strong></div>`).join('')}</div></details>` : '';
      $('sessionLinkCurrent').innerHTML = `${esc(heading)}<br>${esc(note)}${state === 'ready' ? `<div class="review-link-metrics">${(detail.metrics || []).map(metric => `<div>${esc(metric.label || metric.key || '指标')}<strong>${esc(metric.display ?? '—')}${metric.unit ? ' ' + esc(metric.unit) : ''}</strong></div>`).join('')}</div>${historyMarkup}` : ''}`;
    }
  }
  async function loadBusinessRooms(offset = 0) {
    const accountId = businessAccountId;
    const version = ++businessRoomsVersion;
    businessRooms = [];
    businessPage = {offset, total:0, hasMore:false};
    businessRoomError = '';
    if (!accountId) { businessRoomsLoading = false; renderBusinessLink(); return; }
    businessRoomsLoading = true;
    renderBusinessLink();
    try {
      const page = await apiRequest(`/api/rpa/rooms?account=${encodeURIComponent(accountId)}&offset=${offset}&limit=50`);
      if (version !== businessRoomsVersion || accountId !== businessAccountId) return;
      businessRooms = page.rooms || [];
      businessPage = {offset:page.offset || 0, total:page.total || 0, hasMore:!!page.hasMore};
      if (businessRoomId && !businessRooms.some(room => String(room.id) === businessRoomId) && !(currentBusinessLink()?.accountId === accountId && currentBusinessLink()?.roomId === businessRoomId)) {
        businessRoomId = '';
        $('sessionLinkConfirmed').checked = false;
      }
    } catch (error) {
      if (version !== businessRoomsVersion) return;
      businessRoomError = '经营场次读取失败：' + error.message;
    } finally {
      if (version === businessRoomsVersion) { businessRoomsLoading = false; renderBusinessLink(); }
    }
  }
  async function loadBusinessDetail() {
    const id = selectedReviewId;
    const version = ++businessDetailVersion;
    businessDetail = null;
    renderBusinessLink();
    if (!id) return;
    try {
      const detail = await apiRequest(`/api/session-links/detail?recordingSessionId=${encodeURIComponent(id)}`);
      if (version !== businessDetailVersion || id !== selectedReviewId) return;
      businessDetail = detail;
      if (detail.linked && detail.link) businessLinks.set(id, detail.link);
      else businessLinks.delete(id);
      if (detail.linked && !businessAccountId) {
        businessAccountId = detail.link.accountId;
        businessRoomId = detail.link.roomId;
        loadBusinessRooms();
      }
      renderReviewSource();
    } catch (error) {
      if (version !== businessDetailVersion) return;
      businessDetail = {status:'unavailable', note:'关联状态读取失败：' + error.message};
    } finally { if (version === businessDetailVersion) renderBusinessLink(); }
  }
  async function refreshBusinessIndex(force = false) {
    if (!selectedReviewId || businessBusy) return;
    if (businessIndexLoading) return businessIndexLoading.then(() => {
      if (!selectedReviewId) return;
      const link = currentBusinessLink();
      if (!businessAccountId && link) {
        businessAccountId = link.accountId;
        businessRoomId = link.roomId;
      }
      return Promise.all([loadBusinessRooms(businessPage.offset), loadBusinessDetail()]);
    });
    if (!force && Date.now() - businessIndexFetchedAt < 60000) {
      if (!businessAccountId && currentBusinessLink()) {
        businessAccountId = currentBusinessLink().accountId;
        businessRoomId = currentBusinessLink().roomId;
      }
      renderBusinessLink();
      await Promise.all([loadBusinessRooms(businessPage.offset), loadBusinessDetail()]);
      return;
    }
    businessIndexLoading = (async () => {
      const [accountsResult, linksResult] = await Promise.allSettled([
        apiRequest('/api/rpa/state'), apiRequest('/api/session-links')
      ]);
      businessError = '';
      if (accountsResult.status === 'fulfilled') businessAccounts = accountsResult.value.accounts || [];
      else { businessAccounts = []; businessError = '经营账号读取失败：' + accountsResult.reason.message; }
      if (linksResult.status === 'fulfilled') {
        businessLinks.clear();
        for (const link of linksResult.value.links || []) businessLinks.set(link.recordingSessionId, link);
      } else businessError += (businessError ? ' ' : '') + '关联记录读取失败：' + linksResult.reason.message;
      businessIndexFetchedAt = Date.now();
      if (!selectedReviewId) return;
      if (!businessAccountId && currentBusinessLink()) {
        businessAccountId = currentBusinessLink().accountId;
        businessRoomId = currentBusinessLink().roomId;
      }
      renderReviewSource();
      renderBusinessLink();
      await Promise.all([loadBusinessRooms(businessPage.offset), loadBusinessDetail()]);
    })().finally(() => { businessIndexLoading = null; });
    return businessIndexLoading;
  }
  function selectReview(id) {
    selectedReviewId = id;
    currentReviewCursor = '';
    ++businessRoomsVersion;
    ++businessDetailVersion;
    const link = businessLinks.get(id);
    businessAccountId = link?.accountId || '';
    businessRoomId = link?.roomId || '';
    businessRooms = [];
    businessPage = {offset:0, total:0, hasMore:false};
    businessRoomsLoading = false;
    businessDetail = null;
    businessRoomError = '';
    businessActionMessage = '';
    $('sessionLinkConfirmed').checked = false;
    $('sessionReviewSelect').value = id;
    const source = reviewDrafts.get(id) || reviews.get(id) || {};
    for (const [key, field] of Object.entries({summary:'sessionReviewSummary', issues:'sessionReviewIssues',
      evidenceAt:'sessionReviewEvidenceAt', owner:'sessionReviewOwner', actions:'sessionReviewActions', dueDate:'sessionReviewDueDate'})) {
      $(field).value = source[key] || '';
    }
    $('sessionReviewUseCursor').disabled = true;
    $('sessionReviewStatus').textContent = id ? '正在读取复盘记录。' : '尚未选择场次。';
    renderReviewSource();
    renderBusinessLink();
    if (id) refreshBusinessIndex();
    updateReviewControls();
    document.dispatchEvent(new CustomEvent('liveops:review-session', {detail:{sessionId:id}}));
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
      document.dispatchEvent(new CustomEvent('liveops:recording-sessions-refreshed', {detail:{sessionId:selectedReviewId}}));
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
      if (selectedReviewId && Date.now() - businessIndexFetchedAt >= 60000) refreshBusinessIndex();
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
  $('sessionLinkAccount').addEventListener('change', event => {
    businessAccountId = event.target.value;
    businessRoomId = '';
    businessActionMessage = '';
    $('sessionLinkConfirmed').checked = false;
    loadBusinessRooms();
  });
  $('sessionLinkRoom').addEventListener('change', event => {
    businessRoomId = event.target.value;
    businessActionMessage = '';
    $('sessionLinkConfirmed').checked = false;
    renderBusinessLink();
  });
  $('sessionLinkConfirmed').addEventListener('change', renderBusinessLink);
  $('sessionLinkPrevious').addEventListener('click', () => {
    businessRoomId = '';
    $('sessionLinkConfirmed').checked = false;
    loadBusinessRooms(Math.max(0, businessPage.offset - 50));
  });
  $('sessionLinkNext').addEventListener('click', () => {
    businessRoomId = '';
    $('sessionLinkConfirmed').checked = false;
    loadBusinessRooms(businessPage.offset + 50);
  });
  $('saveSessionLink').addEventListener('click', async () => {
    const recordingSessionId = selectedReviewId;
    const accountId = businessAccountId;
    const roomId = businessRoomId;
    const existing = currentBusinessLink();
    if (businessBusy || !recordingSessionId || !accountId || !roomId || !$('sessionLinkConfirmed').checked) return;
    if (existing && !window.confirm(`将录制场次从“${existing.roomTitle || existing.roomId}”改绑到所选罗盘场次？`)) return;
    businessBusy = true;
    businessActionMessage = '正在保存经营场次关联…';
    renderBusinessLink();
    try {
      const result = await apiRequest('/api/session-links', {method:'POST', body:JSON.stringify({recordingSessionId, accountId, roomId, confirmed:true, replace:!!existing})});
      businessLinks.set(recordingSessionId, result.link);
      const message = existing ? '已改绑经营场次。' : '已关联经营场次。';
      if (recordingSessionId === selectedReviewId) {
        businessActionMessage = message;
        $('sessionLinkConfirmed').checked = false;
        businessDetail = null;
        renderReviewSource();
        await loadBusinessDetail();
        document.dispatchEvent(new CustomEvent('liveops:review-session', {detail:{sessionId:recordingSessionId}}));
      }
      toast(message);
    } catch (error) {
      if (recordingSessionId === selectedReviewId) businessActionMessage = '关联失败：' + error.message;
    } finally { businessBusy = false; renderBusinessLink(); }
  });
  $('removeSessionLink').addEventListener('click', async () => {
    const recordingSessionId = selectedReviewId;
    const existing = currentBusinessLink();
    if (businessBusy || !recordingSessionId || !existing || !window.confirm(`解除“${existing.roomTitle || existing.roomId}”与此录制场次的关联？`)) return;
    businessBusy = true;
    businessActionMessage = '正在解除经营场次关联…';
    renderBusinessLink();
    try {
      await apiRequest('/api/session-links/unlink', {method:'POST', body:JSON.stringify({recordingSessionId, confirmed:true})});
      businessLinks.delete(recordingSessionId);
      if (recordingSessionId === selectedReviewId) {
        businessDetail = {linked:false, status:'unlinked'};
        businessRoomId = '';
        $('sessionLinkConfirmed').checked = false;
        businessActionMessage = '已解除经营场次关联。';
        renderReviewSource();
        document.dispatchEvent(new CustomEvent('liveops:review-session', {detail:{sessionId:recordingSessionId}}));
      }
      toast('已解除经营场次关联。');
    } catch (error) {
      if (recordingSessionId === selectedReviewId) businessActionMessage = '解除失败：' + error.message;
    } finally { businessBusy = false; renderBusinessLink(); }
  });
  for (const field of [$('sessionReviewSummary'), $('sessionReviewIssues'), $('sessionReviewOwner'), $('sessionReviewActions'), $('sessionReviewDueDate')]) {
    field.addEventListener('input', () => {
      if (selectedReviewId) reviewDrafts.set(selectedReviewId, reviewFields());
      updateReviewControls();
    });
  }
  let currentReviewCursor = '';
  document.addEventListener('liveops:review-cursor', event => {
    currentReviewCursor = event.detail.at || '';
    $('sessionReviewUseCursor').disabled = !selectedReviewId || !currentReviewCursor;
  });
  $('sessionReviewUseCursor').addEventListener('click', () => {
    if (!selectedReviewId || !currentReviewCursor) return;
    $('sessionReviewEvidenceAt').value = currentReviewCursor;
    reviewDrafts.set(selectedReviewId, reviewFields());
    updateReviewControls();
  });
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
