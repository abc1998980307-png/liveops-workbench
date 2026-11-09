(() => {
  const $ = id => document.getElementById(id);
  let loading = false;
  const duration = value => {
    if (!Number.isFinite(value)) return '等待进度';
    const seconds = Math.floor(value / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  const reasons = {normal:'正常结束（录制器报告）', user_stop:'用户停止（录制器报告）'};
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const data = await apiRequest('/api/recording-sessions');
      $('recordingSessionStatus').textContent = `${data.error ? data.error + '。' : ''}${data.note || ''}${data.truncated ? ' 仅显示最近 50 场。' : ''}${data.checkedAt ? ' 最近检查 ' + formatTime(data.checkedAt) : ''}`;
      const archives = data.archives || [];
      $('recordingSessionRows').innerHTML = data.sessions.length ? data.sessions.map(session => {
        const states = {recording:'录制中', ended:'已结束', waiting:'等待续录 / 结束确认', unknown:'状态待确认'};
        const segments = session.segments || [];
        const current = segments.at(-1);
        const switches = (session.events || []).filter(e => e.type === 'file_changed').length;
        const gaps = (session.events || []).filter(e => e.type === 'observation_gap').length;
        const archive = archives.find(item => item.sessionId === session.id);
        const archiveButton = session.endedAt && segments.length && (!archive || archive.status !== 'completed') ? `<button class="btn small" type="button" data-archive-session="${esc(session.id)}">${archive?.status === 'processing' ? '重试长录制归档' : '生成长录制归档'}</button>` : '';
        const archiveInfo = archive ? `<div class="session-note">${archive.status === 'completed' ? `已生成归档${archive.unknownGaps ? '，仍有无法确认的间断' : ''}。` : '上次归档没有完成，可重试。'}${archive.videoPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.videoPath)}">打开合并视频位置</button>` : ''}${archive.transcriptPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.transcriptPath)}">打开合并文本位置</button>` : ''}${archive.subtitlesPath ? ` <button class="table-action" type="button" data-recording-path="${esc(archive.subtitlesPath)}">打开合并字幕位置</button>` : ''}</div>` : '';
        return `<article class="session-hit"><div><div class="session-hit-title">${esc(session.account || '未命名直播间')} · ${esc(states[session.state] || '状态待确认')}</div><div class="session-hit-file">开始 ${esc(formatTime(session.startedAt))}${session.endedAt ? ' · 结束 ' + esc(formatTime(session.endedAt)) : ''}</div><p class="session-hit-text">${current ? `最近片段 ${duration(current.mediaDurationMs)} · ${formatBytes(current.bytes)}` : '尚未观察到片段文件'} · 已观察 ${segments.length} 个片段 · ${switches} 次文件切换</p><div class="session-note">${session.endedAt ? esc(reasons[session.endReason] || '结束原因：' + (session.endReason || '未知')) + '。' : ''}历史片段可能缺失；文件切换的原因和准确缺口待确认。${gaps ? ` 有 ${gaps} 次观察中断。` : ''}</div><div class="button-row">${archiveButton}</div>${archiveInfo}${segments.length ? `<details><summary>查看片段与观察记录</summary>${segments.map(s => `<div class="session-hit-file">${esc(s.path)} · ${duration(s.mediaDurationMs)}${s.closedObservedAt ? ' · 观察结束' : ''}${s.recordingPath ? ` <button class="table-action" type="button" data-recording-path="${esc(s.recordingPath)}">打开文件位置</button>` : ' · 文件已移走或目录已更改'}</div>`).join('')}${(session.events || []).map(e => `<div class="session-hit-file">${esc(formatTime(e.from))} → ${esc(formatTime(e.to))}：${esc(e.note)}</div>`).join('')}</details>` : ''}</div><span class="tag">本机录制场次</span></article>`;
      }).join('') : '<p class="session-note">尚未取得录制场次记录。正在录制时会自动记录；未启动录制器不会自动启动录制。</p>';
      document.querySelectorAll('[data-archive-session]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = '归档处理中…';
        try {
          await apiRequest('/api/recording-sessions/archive', {method: 'POST', body: JSON.stringify({sessionId: button.dataset.archiveSession})});
          await refresh();
        } catch (error) {
          button.disabled = false;
          button.textContent = '生成长录制归档';
          $('recordingSessionStatus').textContent = '归档失败：' + error.message;
        }
      }));
    } catch (error) {
      $('recordingSessionStatus').textContent = '场次读取失败：' + error.message;
    } finally { loading = false; }
  }
  $('refreshRecordingSessions').addEventListener('click', refresh);
  setInterval(() => { if (currentView === 'sessions' && !document.hidden) refresh(); }, 5000);
  refresh();
})();
