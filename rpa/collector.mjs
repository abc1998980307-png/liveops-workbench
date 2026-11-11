import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { BrowserEngine } from './engine.mjs';
import { roomList, historyBounds, historyWindow, historyRange, historyStartDate, historyRoomPage, validateHistoryEndpoint, normalizeHistoryReport, normalizeSnapshot, CollectError } from './model.mjs';
import { FeishuSync } from './feishu.mjs';

const HISTORY_SUMMARY_FIELDS = [
  { key: 't7payin8d_predstl_ord_amt', label: '结算有效成交金额', source: 'historyTrade', rawUnit: 'price', unit: '元' },
  { key: 't7payin8d_predstl_ord_cnt', label: '结算有效成交订单量', source: 'historyTrade', rawUnit: 'number', unit: '单' },
  { key: 'watch_ucnt', label: '进入直播间人数（按场相加）', source: 'historyCore', rawUnit: 'number', unit: '人次' },
];

export function acquireCollectorGuard(root) {
  const guard = new DatabaseSync(path.join(root, 'collector-instance.sqlite'));
  try {
    guard.exec('BEGIN EXCLUSIVE');
    return guard;
  } catch (error) {
    guard.close();
    throw new Error('同一数据目录已有罗盘采集器运行，请使用现有工作台', { cause: error });
  }
}

export class Collector {
  constructor(store, engine) {
    this.store = store; this.engine = engine; this.busy = new Map(); this.historyBusy = new Map(); this.next = new Map(); this.generation = new Map(); this.stopping = false;
    this.historyRequestSpacingMs = 800;
    this.feishu = new FeishuSync(store);
  }
  state() {
    return { ready: true, accounts: this.store.accounts().map(a => ({ ...a, busy: this.busy.has(a.id), historyBusy: this.historyBusy.has(a.id), history: this.store.historyProgress(a.id), historyBatch: this.store.historyBatch(a.id), nextSync: a.enabled ? new Date(this.next.get(a.id) || Date.now()).toISOString() : null, rooms: this.store.rooms(a.id) })), events: this.store.events(), retentionDays: 30, historyBounds: historyBounds() };
  }
  pause(id, message = '已暂停自动同步') {
    const a = this.store.account(id);
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    this.store.save({ ...a, enabled: false, state: 'paused', error: null });
    const batch = this.store.historyBatch(id);
    if (batch?.status === 'running') this.store.saveHistoryBatch(id, { ...batch, status: 'paused', updatedAt: new Date().toISOString() });
    this.store.event(id, message);
  }
  rateLimitUntil(id) {
    const account = this.store.account(id);
    const batch = this.store.historyBatch(id);
    const deadlines = [account.retryAfter, batch?.status === 'rate_limited' ? batch.retryAfter : null]
      .filter(value => value && Date.parse(value) > Date.now());
    return deadlines.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  }
  recordRateLimit(id, error) {
    const account = this.store.account(id);
    const retryAfter = error.retryAfter || new Date(Date.now() + 300000).toISOString();
    error.retryAfter = retryAfter;
    const until = Date.parse(account.retryAfter) > Date.parse(retryAfter) ? account.retryAfter : retryAfter;
    this.store.save({ ...account, state: 'rate_limited', retryAfter: until,
      error: String(error.message || '罗盘请求受限').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250),
      lastCheck: new Date().toISOString() });
    this.next.set(id, Date.parse(until));
    return until;
  }
  assertHistoryRequestAllowed(id) {
    const retryAfter = this.rateLimitUntil(id);
    if (retryAfter) throw new CollectError(`罗盘请求受限，请在 ${retryAfter} 后重试。`, 'rate_limited');
  }
  async login(id) {
    const a = this.store.account(id);
    await this.engine.open(id, true);
    this.store.save({ ...a, enabled: true, state: a.uid ? 'ready' : 'needs_login', error: null });
    this.next.set(id, 0);
    this.store.event(id, '已打开罗盘窗口，完成登录后将自动同步');
    return this.start(id);
  }
  start(id) {
    this.store.account(id);
    if (this.stopping) throw new Error('采集器正在停止');
    const retryAfter = this.rateLimitUntil(id);
    if (retryAfter) return { ok: true, queued: false, retryAfter, warning: '罗盘请求受限，等待限流结束后再同步' };
    if (this.busy.has(id) || this.historyBusy.has(id)) return { ok: true, queued: false, busy: true };
    const promise = this.sync(id).finally(() => this.busy.delete(id));
    this.busy.set(id, promise);
    return { ok: true, queued: true };
  }
  async sync(id) {
    const version = this.generation.get(id) || 0;
    const current = () => !this.stopping && version === (this.generation.get(id) || 0);
    let a = this.store.account(id);
    const checkedAt = new Date().toISOString();
    try {
      const identity = await this.engine.request(id, 'identity');
      const uid = identity?.data?.author_id;
      if (!uid) throw new CollectError('请在罗盘窗口登录拥有直播数据权限的达人账号。', 'needs_login');
      if (typeof uid === 'number' && !Number.isSafeInteger(uid)) throw new CollectError('账号标识精度无法确认，已停止本轮同步。');
      if (a.uid && a.uid !== String(uid)) throw new CollectError('当前浏览器登录了另一个账号。请切回原账号，或在网站新增连接。', 'account_changed');
      if (!current()) return;
      let name = a.name;
      if (!name) {
        try { const info = await this.engine.request(id, 'account'); name = info?.data?.account_name || null; } catch { /* Identity is authoritative; a display name is optional. */ }
      }
      const today = await this.engine.request(id, 'rooms');
      const rooms = roomList(today);
      if (!current()) return;
      a = { ...this.store.account(id), uid: String(uid), name, lastCheck: checkedAt };
      this.store.save(a);
      const todayIds = new Set(rooms.map(r => r.id));
      for (const old of this.store.rooms(id)) if (!todayIds.has(old.id) && old.today !== false) this.store.saveRoom(id, { ...old, today: false, state: old.state === 'live' ? 'unknown' : old.state });
      for (const room of rooms) this.store.saveRoom(id, { ...room, today: true });
      // Poll active rooms first; a bounded number of recent/unknown rooms covers delayed status fields.
      const selected = [...rooms].sort((x, y) => Number(y.state === 'live') - Number(x.state === 'live')).slice(0, 3);
      let failed = 0, successes = 0; const errors = [];
      for (const room of selected) {
        const results = {};
        for (const task of ['base', 'core', 'products']) {
          if (!current()) return;
          try { results[task] = { ok: true, body: await this.engine.request(id, task, room.id) }; successes++; }
          catch (error) {
            if (['needs_login', 'rate_limited'].includes(error.kind)) throw error;
            failed++; results[task] = { ok: false, error: String(error.message).slice(0, 200) }; errors.push(`${task}：${results[task].error}`);
          }
        }
        if (!current()) return;
        const normalized = normalizeSnapshot(results);
        this.store.snapshot(id, room.id, normalized, results);
        this.store.saveRoom(id, { ...room, today: true, state: normalized.state === 'unknown' ? room.state : normalized.state, lastSample: new Date().toISOString() });
      }
      if (!current()) return;
      const state = failed ? (successes ? 'partial' : 'error') : 'ready';
      this.store.save({ ...this.store.account(id), state, retryAfter: null,
        error: errors.slice(0, 3).join('；') || null, lastSync: failed && !successes ? a.lastSync : new Date().toISOString(), lastCheck: checkedAt });
      this.store.event(id, rooms.length ? `检测到 ${rooms.length} 个今日场次，采集 ${selected.length} 场${failed ? `，${failed} 项接口失败` : '，数据已保存'}` : '账号在线，今日暂无直播场次');
      this.next.set(id, Date.now() + this.store.account(id).interval * 1000);
    } catch (error) {
      if (!current()) return;
      const state = error.kind || 'error';
      const message = String(error.message || '采集失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250);
      if (state === 'rate_limited') this.recordRateLimit(id, error);
      else this.store.save({ ...this.store.account(id), state, error: message, lastCheck: checkedAt });
      this.store.event(id, message);
      if (state !== 'rate_limited') this.next.set(id, Date.now() + (state === 'needs_login' ? 30 : 60) * 1000);
    }
  }
  async verifyHistoryIdentity(id, uid) {
    const identity = await this.engine.request(id, 'identity');
    const currentUid = identity?.data?.author_id;
    if (typeof currentUid === 'number' && !Number.isSafeInteger(currentUid)) throw new CollectError('账号标识精度无法确认，已停止历史读取。');
    if (!currentUid) throw new CollectError('罗盘登录已失效，请重新登录。', 'needs_login');
    if (String(currentUid) !== uid || this.store.account(id).uid !== uid)
      throw new CollectError('罗盘账号身份已变化，已停止历史读取。', 'account_changed');
  }
  async historyPage(id, reset = false, startDate = null, endDate = null) {
    const account = this.store.account(id);
    if (this.stopping || this.busy.has(id) || this.historyBusy.has(id)) throw new Error('该账号正在执行其他读取任务');
    if (!account.uid) throw new Error('请先完成罗盘账号身份核验');
    this.assertHistoryRequestAllowed(id);
    const previous = this.store.historyProgress(id);
    const bounds = historyBounds();
    const selection = historyRange(startDate ?? previous?.startDate ?? bounds.earliest,
      endDate ?? previous?.endDate ?? bounds.latest);
    if (previous && !reset && (previous.uid !== account.uid ||
        previous.startDate !== selection.startDate || previous.endDate !== selection.endDate ||
        previous.beginDate !== historyWindow().beginDate))
      throw new Error('历史读取范围、账号或 90 天窗口已变化，请重新读取所选日期');
    if (previous?.complete && !reset) return previous;
    const progress = reset || !previous ? {
      ...selection, uid: account.uid, nextPage: 1, total: null, scanned: 0, imported: 0,
      unknownDates: 0, outsideRange: 0,
      complete: false, truncated: false, error: null, startedAt: new Date().toISOString(),
    } : previous;
    this.store.saveHistoryProgress(id, { ...progress, error: null });
    const version = this.generation.get(id) || 0;
    const current = () => !this.stopping && version === (this.generation.get(id) || 0);
    const task = (async () => {
      try {
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return this.store.historyProgress(id);
        const body = await this.engine.request(id, 'history', {
          pageNo: progress.nextPage, beginDate: progress.beginDate,
          beginDateFormat: progress.beginDateFormat,
        });
        const page = historyRoomPage(body, progress.nextPage);
        if (!current()) return this.store.historyProgress(id);
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return this.store.historyProgress(id);
        let imported = 0, unknownDates = 0, outsideRange = 0;
        for (const room of page.rooms) {
          const date = historyStartDate(room.startedAt);
          if (!date) { unknownDates++; continue; }
          if (date < progress.startDate || date > progress.endDate) { outsideRange++; continue; }
          const old = this.store.room(id, room.id);
          if (!old) { this.store.saveRoom(id, room); imported++; }
          else if (old.source === 'compass_history') this.store.saveRoom(id, { ...old, ...room });
        }
        const complete = page.pageNo * page.pageSize >= page.total || page.pageNo >= 50;
        const result = this.store.saveHistoryProgress(id, {
          ...progress, nextPage: page.pageNo + 1, total: page.total,
          scanned: progress.scanned + page.rooms.length, imported: progress.imported + imported,
          unknownDates: (progress.unknownDates || 0) + unknownDates,
          outsideRange: (progress.outsideRange || 0) + outsideRange,
          complete, truncated: page.pageNo >= 50 && page.pageNo * page.pageSize < page.total,
          error: null, lastReadAt: new Date().toISOString(),
        });
        this.store.event(id, `历史场次第 ${page.pageNo} 页已读取：${page.rooms.length} 场，范围内新增 ${imported} 场${unknownDates ? `，${unknownDates} 场日期无法判定` : ''}；未采集指标或写入飞书`);
        return result;
      } catch (error) {
        if (!current()) return this.store.historyProgress(id);
        if (error.kind === 'rate_limited') this.recordRateLimit(id, error);
        const message = String(error.message || '历史场次读取失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250);
        this.store.saveHistoryProgress(id, { ...progress, error: message, lastReadAt: new Date().toISOString() });
        this.store.event(id, message);
        throw error;
      }
    })();
    this.historyBusy.set(id, task);
    try { return await task; } finally { this.historyBusy.delete(id); }
  }
  async historyReport(id, roomId, batchVersion = null) {
    const account = this.store.account(id);
    if (this.stopping || this.busy.has(id) || (batchVersion === null && this.historyBusy.has(id))) throw new Error('该账号正在执行其他读取任务');
    if (!account.uid) throw new Error('请先完成罗盘账号身份核验');
    this.assertHistoryRequestAllowed(id);
    if (!/^\d{1,30}$/.test(roomId)) throw new Error('历史场次 ID 无效');
    const room = this.store.room(id, roomId);
    if (!room) throw new Error('请先将历史场次目录导入本机');
    if (room.state === 'live') throw new Error('直播中的场次请使用实时采集');
    const version = batchVersion ?? (this.generation.get(id) || 0);
    const current = () => !this.stopping && version === (this.generation.get(id) || 0);
    const task = (async () => {
      try {
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return { cancelled: true };
        const names = ['historyBasic', 'historyCore', 'historyTrade'];
        const read = async name => {
          try { return { ok: true, body: validateHistoryEndpoint(name, await this.engine.request(id, name, roomId)), retrievedAt: new Date().toISOString() }; }
          catch (error) {
            if (['needs_login', 'rate_limited', 'account_changed'].includes(error.kind)) throw error;
            return { ok: false, error: String(error.message || '读取失败').slice(0, 200), retrievedAt: new Date().toISOString() };
          }
        };
        const values = [];
        if (batchVersion === null) values.push(...await Promise.all(names.map(read)));
        else for (const name of names) {
          if (!current()) return { cancelled: true };
          values.push(await read(name));
          if (name !== names.at(-1) && this.historyRequestSpacingMs)
            await new Promise(resolve => setTimeout(resolve, this.historyRequestSpacingMs));
        }
        if (!current()) return { cancelled: true };
        const results = Object.fromEntries(names.map((name, index) => [name, values[index]]));
        if (!values.some(value => value.ok)) throw new CollectError('三个历史详情接口均未成功，原报表未覆盖。');
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return { cancelled: true };
        const previous = this.store.historyReport(id, roomId, true);
        const merged = { ...results };
        let unreadablePrevious = false;
        for (const name of names) {
          if (results[name].ok || !previous?.raw?.[name]?.ok) continue;
          try {
            validateHistoryEndpoint(name, previous.raw[name].body);
            merged[name] = { ...previous.raw[name], retrievedAt: previous.endpoints?.[name]?.retrievedAt || previous.retrievedAt, reused: true };
          } catch { unreadablePrevious = true; }
        }
        if (unreadablePrevious) return { report: (({ raw, ...report }) => report)(previous),
          warning: '旧报表接口原文不可读，已保留原报表，未覆盖已保存指标' };
        if (JSON.stringify(merged).length > 2 * 1024 * 1024) throw new CollectError('历史详情超过本机保存上限，原报表未覆盖。');
        const report = normalizeHistoryReport(merged, roomId);
        this.store.saveHistoryReport(id, roomId, report, merged);
        const reused = names.filter(name => merged[name].reused);
        this.store.event(id, `历史场次 ${roomId} 报表已读取：${report.metrics.length} 项指标${reused.length ? `，${reused.length} 项接口沿用上次结果` : values.some(value => !value.ok) ? '，部分接口失败' : ''}；飞书历史同步由独立开关控制`);
        return { report, ...(reused.length ? { warning: '部分接口失败，已沿用上次成功结果' } : {}) };
      } catch (error) {
        if (!current()) return { cancelled: true };
        if (error.kind === 'rate_limited') this.recordRateLimit(id, error);
        this.store.event(id, String(error.message || '历史报表读取失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250));
        throw error;
      }
    })();
    if (batchVersion !== null) return task;
    this.historyBusy.set(id, task);
    try { return await task; } finally { this.historyBusy.delete(id); }
  }
  startHistoryBatch(id, startDate, endDate, resume = false) {
    const account = this.store.account(id);
    if (this.stopping || this.busy.has(id) || this.historyBusy.has(id)) throw new Error('该账号正在执行其他读取任务');
    if (!account.uid) throw new Error('请先完成罗盘账号身份核验');
    this.assertHistoryRequestAllowed(id);
    let progress;
    if (resume) {
      progress = this.store.historyBatch(id);
      if (!progress || !['paused', 'error', 'rate_limited'].includes(progress.status)) throw new Error('没有可继续的历史回填任务');
      if (progress.uid !== account.uid) throw new Error('账号身份已变化，不能继续旧回填任务');
      if (progress.retryAfter && Date.now() < Date.parse(progress.retryAfter)) throw new Error('罗盘请求受限，请等待提示时间后重试');
    } else {
      const selection = historyRange(startDate, endDate);
      const candidates = this.store.allRooms(id).filter(room => {
        if (room.state !== 'ended') return false;
        const date = historyStartDate(room.startedAt);
        return date && date >= selection.startDate && date <= selection.endDate;
      });
      if (candidates.length > 500) throw new Error('所选日期内已有超过 500 场，请缩小范围');
      const pending = candidates.filter(room => !this.reportComplete(id, room.id));
      progress = { uid: account.uid, startDate, endDate, roomIds: pending.map(room => room.id),
        selected: candidates.length, skippedExisting: candidates.length - pending.length,
        nextIndex: 0, succeeded: 0, partial: 0, failed: 0, consecutiveFailures: 0, skippedOnResume: 0,
        failures: [], status: pending.length ? 'running' : 'completed', error: null, retryAfter: null,
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    if (!resume && !progress.roomIds.length) {
      this.store.saveHistoryBatch(id, progress);
      return { batch: progress };
    }
    progress = this.store.saveHistoryBatch(id, { ...progress, status: 'running', error: null,
      retryAfter: null, updatedAt: new Date().toISOString() });
    const version = this.generation.get(id) || 0;
    const task = this.runHistoryBatch(id, version);
    const tracked = task.catch(error => {
      const message = String(error.message || '历史回填任务失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 200);
      try {
        const saved = this.store.historyBatch(id);
        if (saved?.status === 'running') this.store.saveHistoryBatch(id, { ...saved, status: 'error', error: message, updatedAt: new Date().toISOString() });
      } catch { /* A storage failure must not start another read or erase the saved cursor. */ }
      console.error(`历史回填暂停：${message}`);
    }).finally(() => { if (this.historyBusy.get(id) === tracked) this.historyBusy.delete(id); });
    this.historyBusy.set(id, tracked);
    return { batch: progress };
  }
  reportComplete(id, roomId) {
    const report = this.store.historyReport(id, roomId);
    return !!report && ['historyBasic', 'historyCore', 'historyTrade'].every(name => report.endpoints?.[name]?.ok);
  }
  historySummary(id, startDate, endDate) {
    const account = this.store.account(id);
    historyRange(startDate, endDate);
    const rooms = this.store.allRooms(id).filter(room => room.state === 'ended' &&
      historyStartDate(room.startedAt) >= startDate && historyStartDate(room.startedAt) <= endDate);
    const totals = HISTORY_SUMMARY_FIELDS.map(field => ({ ...field, rawTotal: 0, coveredRooms: 0, reusedRooms: 0, overflow: false }));
    let reportedRooms = 0, completeRooms = 0;
    for (const room of rooms) {
      const report = this.store.historyReport(id, room.id);
      if (!report) continue;
      reportedRooms++;
      if (['historyBasic', 'historyCore', 'historyTrade'].every(name => report.endpoints?.[name]?.ok)) completeRooms++;
      for (const total of totals) {
        const endpoint = report.endpoints?.[total.source];
        const metric = report.metrics?.find(item => item.key === total.key && item.source === total.source);
        if (!endpoint?.ok || metric?.rawUnit !== total.rawUnit || !Number.isSafeInteger(metric.value)) continue;
        const next = total.rawTotal + metric.value;
        if (!Number.isSafeInteger(next)) { total.overflow = true; continue; }
        total.rawTotal = next;
        total.coveredRooms++;
        if (endpoint.reused) total.reusedRooms++;
      }
    }
    return { account: { id, uid: account.uid, label: account.name || account.label }, startDate, endDate,
      selectedRooms: rooms.length, reportedRooms, completeRooms,
      metrics: totals.map(({ rawTotal, overflow, ...total }) => ({ ...total,
        display: overflow || !total.coveredRooms ? '—' : total.rawUnit === 'price' ?
          (rawTotal / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) :
          rawTotal.toLocaleString('zh-CN'),
        complete: !overflow && total.coveredRooms === rooms.length && rooms.length > 0,
        overflow,
      })) };
  }
  pauseHistoryBatch(id) {
    this.store.account(id);
    const progress = this.store.historyBatch(id);
    if (!progress || progress.status !== 'running') return { batch: progress };
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    return { batch: this.store.saveHistoryBatch(id, { ...progress, status: 'paused', updatedAt: new Date().toISOString() }) };
  }
  async runHistoryBatch(id, version) {
    const current = () => !this.stopping && version === (this.generation.get(id) || 0);
    while (current()) {
      let progress = this.store.historyBatch(id);
      if (progress?.status !== 'running') return;
      if (progress.nextIndex >= progress.roomIds.length) {
        this.store.saveHistoryBatch(id, { ...progress, status: 'completed', updatedAt: new Date().toISOString() });
        this.store.event(id, `历史报表批量回填结束：成功 ${progress.succeeded} 场，部分 ${progress.partial} 场，失败 ${progress.failed} 场；飞书历史同步由独立开关控制`);
        return;
      }
      const roomId = progress.roomIds[progress.nextIndex];
      try {
        if (this.store.account(id).uid !== progress.uid) throw new CollectError('账号身份已变化，已停止历史回填。', 'account_changed');
        if (this.reportComplete(id, roomId)) {
          this.store.saveHistoryBatch(id, { ...progress, nextIndex: progress.nextIndex + 1,
            skippedOnResume: progress.skippedOnResume + 1, updatedAt: new Date().toISOString() });
          continue;
        }
        const result = await this.historyReport(id, roomId, version);
        if (!current() || result.cancelled) return;
        progress = this.store.historyBatch(id);
        if (progress.status !== 'running') return;
        const partial = !this.reportComplete(id, roomId);
        this.store.saveHistoryBatch(id, { ...progress, nextIndex: progress.nextIndex + 1,
          [partial ? 'partial' : 'succeeded']: progress[partial ? 'partial' : 'succeeded'] + 1,
          consecutiveFailures: 0,
          updatedAt: new Date().toISOString() });
      } catch (error) {
        if (!current()) return;
        progress = this.store.historyBatch(id);
        const message = String(error.message || '读取失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 200);
        if (['needs_login', 'rate_limited', 'account_changed'].includes(error.kind)) {
          const limited = error.kind === 'rate_limited';
          const retryAfter = limited ? this.recordRateLimit(id, error) : null;
          this.store.saveHistoryBatch(id, { ...progress, status: limited ? 'rate_limited' : 'error',
            error: message, retryAfter,
            updatedAt: new Date().toISOString() });
          this.store.event(id, message);
          return;
        }
        if (!(error instanceof CollectError)) {
          this.store.saveHistoryBatch(id, { ...progress, status: 'error', error: message, updatedAt: new Date().toISOString() });
          return;
        }
        this.store.saveHistoryBatch(id, { ...progress, nextIndex: progress.nextIndex + 1,
          failed: progress.failed + 1, consecutiveFailures: (progress.consecutiveFailures || 0) + 1,
          failures: [...progress.failures, { roomId, message }].slice(-100), updatedAt: new Date().toISOString() });
        if ((progress.consecutiveFailures || 0) >= 2) {
          const latest = this.store.historyBatch(id);
          this.store.saveHistoryBatch(id, { ...latest, status: 'error', error: '连续三场读取失败，请检查罗盘状态后继续', updatedAt: new Date().toISOString() });
          return;
        }
      }
      if (current() && this.historyRequestSpacingMs)
        await new Promise(resolve => setTimeout(resolve, this.historyRequestSpacingMs));
    }
  }
  tick() {
    if (this.stopping) return;
    this.feishu.tick();
    for (const a of this.store.accounts()) {
      if (a.retryAfter && Date.now() >= Date.parse(a.retryAfter)) {
        this.store.save({ ...a, retryAfter: null,
          ...(a.state === 'rate_limited' && !a.enabled ? { state: 'paused', error: null } : {}) });
      }
      if (this.rateLimitUntil(a.id)) continue;
      if (a.enabled && !this.busy.has(a.id) && !this.historyBusy.has(a.id) && Date.now() >= (this.next.get(a.id) || 0)) this.start(a.id);
    }
  }
  async command(method, args = {}) {
    switch (method) {
      case 'feishu.state': return this.feishu.state();
      case 'feishu.config': return this.feishu.configure(args);
      case 'feishu.destination': return this.feishu.saveDestination(args);
      case 'feishu.test': return this.feishu.test();
      case 'feishu.sync': return this.feishu.sync();
      case 'feishu.monitor': return this.feishu.monitor(args.enabled);
      case 'feishu.history.monitor': return this.feishu.historyMonitor(args.enabled);
      case 'state': return this.state();
      case 'rooms.list': {
        const account = this.store.account(String(args.account || ''));
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 50);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('场次分页参数无效');
        return { account: { id: account.id, uid: account.uid, label: account.name || account.label, state: account.state, enabled: account.enabled },
                 ...this.store.roomsPage(account.id, offset, limit) };
      }
      case 'history.page': return this.historyPage(String(args.id || ''), args.reset === true,
        args.startDate ?? null, args.endDate ?? null);
      case 'history.report': return this.historyReport(String(args.id || ''), String(args.room || ''));
      case 'history.summary': return this.historySummary(String(args.account || ''), args.startDate, args.endDate);
      case 'history.batch.start': return this.startHistoryBatch(String(args.id || ''), args.startDate, args.endDate);
      case 'history.batch.resume': return this.startHistoryBatch(String(args.id || ''), null, null, true);
      case 'history.batch.pause': return this.pauseHistoryBatch(String(args.id || ''));
      case 'room.review': {
        const account = this.store.account(String(args.account || ''));
        const roomId = String(args.room || '');
        if (!/^\d{1,30}$/.test(roomId)) throw new Error('经营场次 ID 无效');
        const detail = this.store.detail(account.id, roomId);
        return { account: { id: account.id, uid: account.uid, label: account.name || account.label, state: account.state, enabled: account.enabled },
                 room: detail.room, latest: detail.latest, historyReport: detail.historyReport };
      }
      case 'create': return { account: this.store.create(String(args.label || '')) };
      case 'login': return this.login(String(args.id));
      case 'sync': return this.start(String(args.id));
      case 'monitor': {
        const id = String(args.id); const a = this.store.account(id);
        if (typeof args.enabled !== 'boolean') throw new Error('同步开关必须为布尔值');
        if (args.enabled) { this.store.save({ ...a, enabled: true }); this.next.set(id, 0); return this.start(id); }
        this.pause(id);
        return { ok: true };
      }
      case 'settings': {
        const a = this.store.account(String(args.id)); const interval = Number(args.interval);
        if (!Number.isInteger(interval) || interval < 30 || interval > 600) throw new Error('同步间隔需为 30–600 秒');
        this.store.save({ ...a, interval }); this.next.set(a.id, Date.now() + interval * 1000); return { ok: true };
      }
      case 'profile.lookup': return this.engine.lookupProfile(String(args.secUserId || ''));
      case 'detail': return this.store.detail(String(args.account), String(args.room), args.raw === true);
      default: throw new Error('不支持的操作');
    }
  }
  async close() {
    this.stopping = true;
    await this.feishu.close();
    await this.engine.close();
    await Promise.allSettled([...this.busy.values()]);
    await Promise.allSettled([...this.historyBusy.values()]);
    this.store.close();
  }
}

async function main() {
  const root = process.env.LIVEOPS_RPA_DATA || path.join(os.homedir(), 'Library/Application Support/LiveOps/rpa');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const guard = acquireCollectorGuard(root);
  let collector;
  const store = new Store(root);
  store.recoverHistoryBatches();
  const engine = new BrowserEngine(root, id => { if (collector) collector.pause(id, '罗盘窗口已关闭，自动同步已暂停'); });
  collector = new Collector(store, engine);
  const timer = setInterval(() => collector.tick(), 5000);
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on('line', async line => {
    let request;
    try {
      request = JSON.parse(line);
      const result = await collector.command(request.method, request.args);
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request?.id, error: String(error.message || '操作失败').slice(0, 300) }) + '\n');
    }
  });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; clearInterval(timer); try { await collector.close(); } finally { guard.close(); process.exit(0); } };
  reader.on('close', close); process.on('SIGTERM', close); process.on('SIGINT', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exit(1); });
