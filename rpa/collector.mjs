import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { BrowserEngine } from './engine.mjs';
import { roomList, historyBounds, historyWindow, historyRange, historyStartDate, historyRoomPage, validateHistoryEndpoint, normalizeHistoryReport, normalizeSnapshot, CollectError } from './model.mjs';
import { FeishuSync } from './feishu.mjs';
import { compassSpendSample } from './spend-source.mjs';
import { reconcileSpend } from './spend-reconciliation.mjs';
import { boundaryWindow, compassHourlyRows, qianchuanHourlyFailure, qianchuanHourlyRows } from './hourly.mjs';
import { rpaDataRoot } from './platform.mjs';

function savedQianchuanAccountId(root) {
  const file = path.join(path.dirname(root), 'qianchuan-current-account.json');
  let saved;
  try {
    if (fs.statSync(file).size > 4096) throw new Error('当前户配置无效');
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw new Error('千川当前户未指定或配置无法读取'); }
  if (typeof saved?.accountId !== 'string' || !/^\d{1,64}$/.test(saved.accountId))
    throw new Error('千川当前户 ID 未指定');
  return saved.accountId;
}

const HISTORY_SUMMARY_FIELDS = [
  { key: 't7payin8d_predstl_ord_amt', label: '结算有效成交金额', source: 'historyTrade', rawUnit: 'price', unit: '元' },
  { key: 't7payin8d_predstl_ord_cnt', label: '结算有效成交订单量', source: 'historyTrade', rawUnit: 'number', unit: '单' },
  { key: 'watch_ucnt', label: '进入直播间人数（按场相加）', source: 'historyCore', rawUnit: 'number', unit: '人次' },
  { key: 'refund_cnt', label: '历史售后退款笔数', source: 'historyCore', rawUnit: 'number', unit: '笔' },
  { key: 'real_refund_amt', label: '历史售后实际退款金额', source: 'historyCore', rawUnit: 'price', unit: '元' },
];

function compassFailureReason(error) {
  const reasons = {
    needs_login: '罗盘会话已失效，请在窗口登录后核验',
    scan: '罗盘窗口等待登录或扫码，请完成后核验',
    loading: '罗盘页面仍在加载，稍后重试',
    network: '网络暂时不可用，稍后重试',
    non_json: '罗盘接口暂未返回有效数据，稍后重试',
    forbidden: '当前账号无权查看罗盘数据',
    rate_limited: '罗盘请求受限，稍后重试',
    identity_unknown: '暂无法确认罗盘达人身份，稍后重试',
  };
  return reasons[error.kind] || '罗盘身份暂时无法核验，稍后重试';
}

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
    this.store = store; this.engine = engine; this.busy = new Map(); this.historyBusy = new Map(); this.next = new Map(); this.nextHourly = new Map(); this.generation = new Map(); this.stopping = false;
    this.historyRequestSpacingMs = 800;
    this.feishu = new FeishuSync(store);
    this.backfillHourlySnapshots();
  }
  backfillHourlySnapshots() {
    const target = this.store.targetName();
    for (const account of this.store.accounts().filter(item => item.enabled && item.uid && item.name === target)) {
      const rows = this.store.db.prepare(`SELECT s.room,s.time,s.json FROM snapshots s
        WHERE s.account=? ORDER BY s.id`).all(account.id);
      const rooms = new Map(this.store.rooms(account.id).map(room => [room.id, room]));
      for (const row of rows) {
        if (!boundaryWindow(row.time)) continue;
        const room = rooms.get(row.room);
        if (room) this.store.saveHourly(compassHourlyRows(account, room, JSON.parse(row.json), row.time));
      }
    }
  }
  async refreshHourly(id, roomId) {
    const account = this.store.account(id);
    if (!account.enabled || account.name !== this.store.targetName() || !account.uid)
      throw new Error('仅可读取已启用且身份一致的目标罗盘连接');
    const room = this.store.room(id, roomId);
    if (!room) throw new Error('目标场次不在已保存的罗盘目录');
    const accountId = savedQianchuanAccountId(this.engine.root);
    const body = await this.engine.qianchuanHourly(accountId, room);
    const rows = qianchuanHourlyRows(body, account, room, new Date().toISOString());
    this.store.saveHourly(rows);
    this.feishu.tick();
    return { saved: rows.length, room: roomId, sampledAt: new Date().toISOString() };
  }
  state() {
    return { ready: true, targetName: this.store.targetName(), accounts: this.store.accounts().map(a => ({ ...a, busy: this.busy.has(a.id), historyBusy: this.historyBusy.has(a.id), history: this.store.historyProgress(a.id), historyBatch: this.store.historyBatch(a.id), nextSync: a.enabled ? new Date(this.next.get(a.id) || Date.now()).toISOString() : null, rooms: this.store.rooms(a.id) })), events: this.store.events(), retentionDays: 30, historyBounds: historyBounds() };
  }
  pause(id, message = '已暂停自动同步') {
    const a = this.store.accounts().find(account => account.id === id);
    if (!a) return;
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    this.store.save({ ...a, enabled: false, state: 'paused', error: null });
    const batch = this.store.historyBatch(id);
    if (batch?.status === 'running') this.store.saveHistoryBatch(id, { ...batch, status: 'paused', updatedAt: new Date().toISOString() });
    this.store.event(id, message);
  }
  remove(id) {
    this.store.account(id);
    if (this.feishu.busy) throw new Error('飞书同步正在进行，请完成后重试移除');
    const previousConfig = this.feishu.config;
    this.store.db.exec('BEGIN');
    try {
      const batch = this.store.historyBatch(id);
      if (batch?.status === 'running') this.store.saveHistoryBatch(id, {
        ...batch, status: 'paused', updatedAt: new Date().toISOString(),
      });
      this.store.archive(id);
      if (previousConfig.accountIds?.includes(id)) {
        const accountIds = previousConfig.accountIds.filter(accountId => accountId !== id);
        this.feishu.config = {
          ...previousConfig, accountIds,
          enabled: accountIds.length > 0 && previousConfig.enabled === true,
          historyEnabled: accountIds.length > 0 && previousConfig.historyEnabled === true,
        };
        this.feishu.persist();
      }
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      this.feishu.config = previousConfig;
      throw error;
    }
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    this.next.delete(id);
    for (const key of this.nextHourly.keys()) if (key.startsWith(`${id}:`)) this.nextHourly.delete(key);
    if (previousConfig !== this.feishu.config) this.feishu.pauseVersion++;
    return { removed: true };
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
  async open(id) {
    this.store.account(id);
    await this.engine.open(id, true);
    this.store.event(id, '已打开罗盘窗口');
    return { ok: true };
  }
  async login(id) {
    const a = this.store.account(id);
    if (a.enabled) this.pause(id, '切换或重新登录账号，自动同步已暂停');
    this.store.save({ ...this.store.account(id), observedName: null, verifiedAt: null, observedUidMatchesStored: false,
      enabled: false, state: 'needs_login', error: null });
    await this.engine.open(id, true);
    this.store.event(id, '已打开罗盘窗口，等待重新核验');
    return { ok: true };
  }
  identityFailure(id, error, checkedAt) {
    const confirmed = ['needs_login', 'scan'].includes(error.kind);
    if (confirmed && this.store.account(id).enabled) this.pause(id,
      error.kind === 'scan' ? '罗盘窗口等待登录或扫码，自动同步已暂停' : '罗盘会话已失效，自动同步已暂停');
    this.store.save({ ...this.store.account(id),
      ...(confirmed ? { observedName: null, verifiedAt: null, observedUidMatchesStored: false } : {}),
      lastCheck: checkedAt, state: confirmed ? 'needs_login' : error.kind || 'error',
      error: compassFailureReason(error) });
  }
  setTarget(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name))
      throw new Error('请输入有效的当前直播号名称');
    const targetName = name.trim();
    if (targetName !== this.store.targetName()) {
      for (const account of this.store.accounts()) if (account.enabled) this.pause(account.id, '当前直播号已变更，自动同步已暂停');
      this.store.setTargetName(targetName);
    }
    return { targetName };
  }
  confirmTarget(id) {
    const account = this.store.account(id);
    const verifiedAt = Date.parse(account.verifiedAt || '');
    if (!account.observedName || !account.observedUidMatchesStored ||
        !Number.isFinite(verifiedAt) || verifiedAt > Date.now() || Date.now() - verifiedAt > 300000)
      throw new Error('请先重新核验当前罗盘窗口的达人身份');
    return this.setTarget(account.observedName);
  }
  async verifyIdentity(id) {
    const account = this.store.account(id);
    const checkedAt = new Date().toISOString();
    let uid, name;
    try {
      const identity = await this.engine.request(id, 'identity');
      uid = identity?.data?.author_id;
      if (!uid) throw new CollectError('暂无法确认罗盘达人身份。', 'identity_unknown');
      if (typeof uid === 'number' && !Number.isSafeInteger(uid)) throw new CollectError('账号标识精度无法确认。', 'identity_unknown');
      const info = await this.engine.request(id, 'account');
      name = info?.data?.account_name;
      if (typeof name !== 'string' || !name.trim()) throw new CollectError('暂无法确认罗盘达人名称。', 'identity_unknown');
      name = name.trim();
    } catch (error) {
      this.identityFailure(id, error, checkedAt);
      error.identityFailure = true;
      throw error;
    }
    const compatible = !account.uid || account.uid === String(uid);
    const targetName = this.store.targetName();
    const matchesTarget = name === targetName && !!targetName;
    const latest = this.store.account(id);
    this.store.save({ ...this.store.account(id), uid: compatible ? String(uid) : account.uid,
      name: compatible ? name : account.name, observedName: name, verifiedAt: checkedAt,
      observedUidMatchesStored: compatible, lastCheck: checkedAt,
      ...(compatible && matchesTarget ? { state: latest.enabled ? 'ready' : 'paused', error: null } : {}) });
    if (!compatible || !matchesTarget) {
      if (latest.enabled) this.pause(id, '罗盘达人与当前直播号不一致，自动同步已暂停');
      this.store.save({ ...this.store.account(id), state: 'account_changed',
        error: !compatible ? '当前罗盘窗口已切换达人，请新建连接以免混入原连接的历史数据' :
          targetName ? '当前罗盘达人与直播号不一致，请先校正' : '请先指定当前直播号' });
    }
    return { observedName: name, verifiedAt: checkedAt, targetName, matchesTarget, compatible };
  }
  async enable(id) {
    const verified = await this.verifyIdentity(id);
    if (!verified.compatible) throw new Error('当前罗盘窗口已切换达人，请新建连接以免混入原连接的历史数据');
    if (!verified.targetName) throw new Error('请先指定当前直播号');
    if (!verified.matchesTarget) throw new Error(`罗盘登录的是「${verified.observedName}」，当前直播号是「${verified.targetName}」，请先校正`);
    const account = this.store.account(id);
    this.store.save({ ...account, enabled: true, state: 'ready', error: null });
    this.next.set(id, 0);
    return this.start(id);
  }
  start(id) {
    this.store.account(id);
    if (this.stopping) throw new Error('采集器正在停止');
    if (!this.store.targetName()) throw new Error('请先指定当前直播号并核验罗盘达人');
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
      if (!this.store.targetName()) throw new CollectError('请先指定当前直播号并核验罗盘达人。', 'account_changed');
      const verified = await this.verifyIdentity(id);
      if (!verified.compatible) throw new CollectError('当前浏览器登录了另一个达人，请新建连接。', 'account_changed');
      if (!verified.matchesTarget) throw new CollectError('当前罗盘达人与直播号不一致，自动同步已暂停。', 'account_changed');
      if (!current()) return;
      a = this.store.account(id);
      const today = await this.engine.request(id, 'rooms');
      const rooms = roomList(today);
      if (!current()) return;
      const todayIds = new Set(rooms.map(r => r.id));
      for (const old of this.store.rooms(id)) if (!todayIds.has(old.id) && old.today !== false) this.store.saveRoom(id, { ...old, today: false, state: old.state === 'live' ? 'unknown' : old.state });
      for (const room of rooms) this.store.saveRoom(id, { ...room, today: true });
      // Poll active rooms first; a bounded number of recent/unknown rooms covers delayed status fields.
      const selected = [...rooms].sort((x, y) => Number(y.state === 'live') - Number(x.state === 'live')).slice(0, 3);
      let failed = 0, successes = 0; const errors = [];
      let qianchuanAccountId = null, qianchuanAccountError = null;
      try { qianchuanAccountId = savedQianchuanAccountId(this.engine.root); }
      catch (error) { qianchuanAccountError = error.message; }
      for (const room of selected) {
        const results = {};
        for (const task of ['base', 'core', 'products']) {
          if (!current()) return;
          try { results[task] = { ok: true, body: await this.engine.request(id, task, room.id) }; successes++; }
          catch (error) {
            if (['needs_login', 'scan', 'rate_limited'].includes(error.kind)) throw error;
            failed++; results[task] = { ok: false, error: String(error.message).slice(0, 200) }; errors.push(`${task}：${results[task].error}`);
          }
        }
        if (!current()) return;
        const normalized = normalizeSnapshot(results);
        let compassSample, qianchuanSample;
        try {
          if (!results.core?.ok) throw new Error(results.core?.error || '罗盘 core_data 未返回');
          compassSample = compassSpendSample(results.core.body, room.id, new Date().toISOString());
        } catch (error) { compassSample = { ok: false, reason: String(error.message).slice(0, 120) }; }
        try {
          if (qianchuanAccountError) throw new Error(qianchuanAccountError);
          qianchuanSample = await this.engine.qianchuanSpend(qianchuanAccountId, room);
        } catch (error) { qianchuanSample = { ok: false, reason: String(error.message).slice(0, 120) }; }
        if (!current()) return;
        normalized.spendReconciliation = reconcileSpend(room.id, compassSample, qianchuanSample,
          { now: Date.now() });
        this.store.snapshot(id, room.id, normalized, results);
        this.store.saveRoom(id, { ...room, today: true, state: normalized.state === 'unknown' ? room.state : normalized.state, lastSample: new Date().toISOString() });
        const sampledAt = new Date().toISOString();
        this.store.saveHourly(compassHourlyRows(a, room, normalized, sampledAt));
        const hourlyKey = `${id}:${room.id}`;
        const prior = this.store.latestHourlyRead(id, room.id, '巨量千川');
        const wait = room.state === 'ended' ? 6 * 3600000 : 50 * 60000;
        if (Date.now() >= (this.nextHourly.get(hourlyKey) || 0) &&
            (!prior || Date.now() - Date.parse(prior) >= wait)) {
          this.nextHourly.set(hourlyKey, Date.now() + wait);
          try {
            if (qianchuanAccountError) throw new Error(qianchuanAccountError);
            const body = await this.engine.qianchuanHourly(qianchuanAccountId, room);
            if (!current()) return;
            const readAt = new Date().toISOString();
            const rows = qianchuanHourlyRows(body, a, room, readAt);
            this.store.saveHourly(rows.length ? rows : [qianchuanHourlyFailure(a, room, readAt, '官方报表未返回当前场次小时桶')]);
          } catch (error) {
            const reason = String(error.message).slice(0, 120);
            this.store.saveHourly([qianchuanHourlyFailure(a, room, new Date().toISOString(), reason)]);
            this.store.event(id, `千川分时：${reason}`);
          }
        }
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
      const transient = ['loading', 'network', 'non_json', 'identity_unknown', 'forbidden'].includes(state);
      const confirmed = ['needs_login', 'scan'].includes(state);
      const message = transient || confirmed ? compassFailureReason(error) : error.identityFailure ? this.store.account(id).error :
        String(error.message || '采集失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250);
      if (state === 'account_changed') this.pause(id, message);
      if (confirmed) this.identityFailure(id, error, checkedAt);
      if (state === 'rate_limited') this.recordRateLimit(id, error);
      else if (!confirmed) this.store.save({ ...this.store.account(id), state, error: message, lastCheck: checkedAt });
      this.store.event(id, message);
      if (Array.isArray(error.shape)) for (const line of error.shape) this.store.event(id, `今日场次形态：${line}`);
      if (state !== 'rate_limited') this.next.set(id, Date.now() + (confirmed ? 30 : 60) * 1000);
    }
  }
  async verifyHistoryIdentity(id, uid) {
    const identity = await this.engine.request(id, 'identity');
    const currentUid = identity?.data?.author_id;
    if (typeof currentUid === 'number' && !Number.isSafeInteger(currentUid)) throw new CollectError('账号标识精度无法确认，已停止历史读取。');
    if (!currentUid) throw new CollectError('暂无法确认罗盘达人身份。', 'identity_unknown');
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
            if (['needs_login', 'scan', 'rate_limited', 'account_changed'].includes(error.kind)) throw error;
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
        if (!endpoint?.ok || metric?.rawUnit !== total.rawUnit || !Number.isSafeInteger(metric.value) ||
            ((total.key === 'refund_cnt' || total.key === 'real_refund_amt') && metric.category !== '售后')) continue;
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
  roomWorkspace(args = {}) {
    const allAccounts = this.store.accounts();
    const requested = Array.isArray(args.accounts) ? args.accounts.map(String) : [];
    if (requested.length > 10 || new Set(requested).size !== requested.length) throw new Error('账号筛选无效');
    const selected = requested.length ? requested.map(id => this.store.account(id)) : allAccounts;
    if (!selected.length) return { accounts: [], startDate: args.startDate || null, endDate: args.endDate || null,
      total: 0, offset: 0, limit: 0, hasMore: false, totals: {}, summary: { selectedRooms: 0, metrics: {} }, rooms: [], rows: [] };
    const bounds = historyBounds();
    const endDate = args.endDate || bounds.latest;
    const defaultStart = new Date(Date.parse(`${endDate}T00:00:00Z`) - 29 * 86400e3).toISOString().slice(0, 10);
    const startDate = args.startDate || defaultStart;
    historyRange(startDate, endDate);
    const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('直播间分页参数无效');
    const sortBy = String(args.sortBy || 'startedAt');
    const sortDirection = String(args.sortDirection || 'desc');
    const sortableFields = new Set(['title', 'accountName', 'startedAt', 'watch_ucnt', 'pay_ucnt',
      'pay_combo_cnt', 'pay_amt', 'follow_anchor_ucnt', 'ad_spend']);
    if (!sortableFields.has(sortBy) || !['asc', 'desc'].includes(sortDirection)) throw new Error('直播间排序参数无效');
    const omitLive = args.omitLive === true;
    const selectedIds = selected.map(account => account.id);
    const records = this.store.roomOverviewRows(selectedIds);
    const matched = [], unknownDates = new Map(selectedIds.map(id => [id, 0]));
    for (const record of records) {
      const day = historyStartDate(record.room.startedAt);
      if (!day) { unknownDates.set(record.account, (unknownDates.get(record.account) || 0) + 1); continue; }
      if (day < startDate || day > endDate || (omitLive && record.room.state === 'live')) continue;
      const report = record.historyReport;
      const findHistory = (key, source) => report?.metrics?.find(item => item.key === key && item.source === source) || null;
      const findLatest = key => record.latest?.metrics?.find(item => item.key === key) || null;
      const endpoints = report?.endpoints || {};
      const validHistory = key => key === 't7payin8d_predstl_ord_amt' ? endpoints.historyTrade?.ok === true :
        endpoints.historyTrade?.ok === true && findHistory(key, 'historyTrade');
      const entryVisits = endpoints.historyCore?.ok ? findHistory('watch_ucnt', 'historyCore') : null;
      const validOrders = validHistory('t7payin8d_predstl_ord_cnt') ? findHistory('t7payin8d_predstl_ord_cnt', 'historyTrade') : null;
      const validSales = validHistory('t7payin8d_predstl_ord_amt') ? findHistory('t7payin8d_predstl_ord_amt', 'historyTrade') : null;
      const refundMetric = (keys, unit) => endpoints.historyCore?.ok === true ?
        report?.metrics?.find(item => item.source === 'historyCore' && item.category === '售后' &&
          keys.includes(item.key) && item.rawUnit === unit && Number.isSafeInteger(item.value) && item.value >= 0) || null : null;
      const refundCount = refundMetric(['refund_cnt'], 'number');
      const refundAmount = refundMetric(['real_refund_amt'], 'price');
      const latestMetrics = record.latest?.metrics || [];
      const roomAccount = selected.find(item => item.id === record.account);
      const withSource = (metric, source, retrievedAt) => metric ? { ...metric, source, retrievedAt } : null;
      const sampled = key => withSource(findLatest(key), 'compass_live_snapshot', record.latest?.time || null);
      matched.push({
        accountId: roomAccount.id, accountName: roomAccount.name || roomAccount.label,
        account: { id: roomAccount.id, uid: roomAccount.uid, name: roomAccount.name || roomAccount.label,
          state: roomAccount.state, enabled: roomAccount.enabled }, room: record.room,
        latest: record.latest ? { time: record.latest.time, metrics: latestMetrics,
          spendReconciliation: record.latest.spendReconciliation || null } : null,
        historyReport: report ? { retrievedAt: report.retrievedAt, endedAt: report.endedAt,
          metrics: report.metrics, endpoints: report.endpoints } : null,
        metrics: {
          entryVisits: withSource(entryVisits, 'compass_history', report?.retrievedAt || null),
          validOrders: withSource(validOrders, 'compass_history', report?.retrievedAt || null),
          validSales: withSource(validSales, 'compass_history', report?.retrievedAt || null),
          refundCount: withSource(refundCount, 'compass_history', report?.retrievedAt || null),
          refundAmount: withSource(refundAmount, 'compass_history', report?.retrievedAt || null),
          onlineUsers: sampled('online_user_cnt'),
          paidUsers: sampled('pay_ucnt'),
          paidOrders: sampled('pay_combo_cnt'),
          paidAmount: sampled('pay_amt'),
        },
        fieldSources: {
          entryVisits: entryVisits ? { source: 'compass_history', retrievedAt: report.retrievedAt, meaning: '进入直播间人次，不是去重观众' } : null,
          validOrders: validOrders ? { source: 'compass_history', retrievedAt: report.retrievedAt, meaning: '结算有效成交订单量' } : null,
          validSales: validSales ? { source: 'compass_history', retrievedAt: report.retrievedAt, meaning: '结算有效成交金额' } : null,
          refundCount: refundCount ? { source: 'compass_history', retrievedAt: report.retrievedAt, meaning: '历史售后退款笔数' } : null,
          refundAmount: refundAmount ? { source: 'compass_history', retrievedAt: report.retrievedAt, meaning: '历史售后实际退款金额' } : null,
          liveSnapshot: record.latest ? { source: 'compass_live_snapshot', sampledAt: record.latest.time } : null,
          adSpend: null,
        },
      });
    }
    const sortMetric = row => {
      const metrics = row.metrics;
      const reportMetric = key => row.historyReport?.metrics?.find(item => item.key === key) || null;
      const historyKey = ({ pay_combo_cnt:'t7payin8d_predstl_ord_cnt', pay_amt:'t7payin8d_predstl_ord_amt' })[sortBy] || sortBy;
      const historical = reportMetric(historyKey);
      const sampled = ({
        watch_ucnt: metrics.entryVisits,
        pay_ucnt: metrics.paidUsers,
        pay_combo_cnt: metrics.paidOrders || metrics.validOrders,
        pay_amt: metrics.paidAmount || metrics.validSales,
        follow_anchor_ucnt: row.latest?.metrics?.find(item => item.key === 'follow_anchor_ucnt') || null,
        ad_spend: row.latest?.spendReconciliation?.qianchuan ?
          { value: Number(row.latest.spendReconciliation.qianchuan.amount),
            display: row.latest.spendReconciliation.qianchuan.display } : null,
      })[sortBy];
      const metric = row.room.state !== 'live' && historical?.value != null ? historical : sampled || historical;
      if (!metric || metric.value == null) return null;
      const display = String(metric.display ?? '').replaceAll(',', '').replace(/[^0-9.-]/g, '');
      const number = Number(display);
      return Number.isFinite(number) ? number : Number.isFinite(metric.value) ? metric.value : null;
    };
    const sortValue = row => {
      if (sortBy === 'title') return row.room.title || '';
      if (sortBy === 'accountName') return row.accountName || '';
      if (sortBy === 'startedAt') {
        const time = Date.parse(row.room.startedAt || '');
        return Number.isFinite(time) ? time : null;
      }
      return sortMetric(row);
    };
    matched.sort((left, right) => {
      const a = sortValue(left), b = sortValue(right);
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      const compared = typeof a === 'string' ? a.localeCompare(b, 'zh-CN') : a - b;
      if (compared) return sortDirection === 'asc' ? compared : -compared;
      return String(left.room.id).localeCompare(String(right.room.id));
    });
    const definitions = [
      ['entryVisits', 'number', '人次'], ['validOrders', 'number', '单'], ['validSales', 'price', '元'],
      ['refundCount', 'number', '笔'], ['refundAmount', 'price', '元'],
    ];
    const totals = Object.fromEntries(definitions.map(([key, rawUnit, unit]) => {
      let rawTotal = 0, coveredRooms = 0;
      for (const row of matched) {
        const metric = row.metrics[key];
        if (!metric || metric.rawUnit !== rawUnit || !Number.isSafeInteger(metric.value)) continue;
        rawTotal += metric.value;
        if (!Number.isSafeInteger(rawTotal)) throw new Error('汇总数值超出安全范围');
        coveredRooms++;
      }
      const displayValue = rawUnit === 'price' ? rawTotal / 100 : rawTotal;
      return [key, { value: coveredRooms ? displayValue : null,
        display: !coveredRooms ? '—' : displayValue.toLocaleString('zh-CN', rawUnit === 'price' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {}),
        unit, coveredRooms, selectedRooms: matched.length, complete: matched.length > 0 && coveredRooms === matched.length }];
    }));
    const accountSummaries = selected.map(item => {
      const accountRooms = records.filter(record => record.account === item.id);
      const fromDate = new Date(Date.parse(`${bounds.latest}T00:00:00Z`) - 29 * 86400e3).toISOString().slice(0, 10);
      const recentSessions = accountRooms.filter(record => {
        const day = historyStartDate(record.room.startedAt);
        return day && day >= fromDate && day <= bounds.latest;
      }).length;
      return { id: item.id, uid: item.uid, name: item.name || item.label, state: item.state,
        enabled: item.enabled, busy: this.busy.has(item.id), error: item.error,
        lastCheck: item.lastCheck, lastSync: item.lastSync, recentSessions,
        unknownDateRooms: unknownDates.get(item.id) || 0, platform: 'douyin_ecommerce' };
    });
    const rows = matched.slice(offset, offset + limit);
    const summaryMetrics = {
      watch_ucnt: totals.entryVisits, t7payin8d_predstl_ord_cnt: totals.validOrders,
      t7payin8d_predstl_ord_amt: totals.validSales,
      refund_cnt: totals.refundCount, real_refund_amt: totals.refundAmount,
    };
    const workspaceRooms = rows.map(row => ({ accountId: row.accountId, accountName: row.accountName,
      id: row.room.id, title: row.room.title, state: row.room.state, startedAt: row.room.startedAt,
      endedAt: row.historyReport?.endedAt || null, latest: row.latest, historyReport: row.historyReport,
      spendReconciliation: row.latest?.spendReconciliation &&
        [row.latest.spendReconciliation.compass, row.latest.spendReconciliation.qianchuan]
          .every(side => !side || side.roomId === row.room.id) ? row.latest.spendReconciliation : null,
      metrics: { watch_ucnt: row.metrics.entryVisits, t7payin8d_predstl_ord_cnt: row.metrics.validOrders,
        t7payin8d_predstl_ord_amt: row.metrics.validSales, refund_cnt: row.metrics.refundCount,
        real_refund_amt: row.metrics.refundAmount, online_user_cnt: row.metrics.onlineUsers,
        pay_ucnt: row.metrics.paidUsers, pay_combo_cnt: row.metrics.paidOrders, pay_amt: row.metrics.paidAmount,
        follow_anchor_ucnt: row.latest?.metrics?.find(item => item.key === 'follow_anchor_ucnt') || null,
        ad_spend: row.latest?.spendReconciliation?.qianchuan ?
          { value: Number(row.latest.spendReconciliation.qianchuan.amount),
            display: row.latest.spendReconciliation.qianchuan.display, unit: '元',
            source: '千川同场报表', retrievedAt: row.latest.spendReconciliation.qianchuan.time } : null } }));
    const reconciled = matched.filter(row => row.latest?.spendReconciliation?.compass &&
      row.latest?.spendReconciliation?.qianchuan).length;
    const compassCovered = matched.filter(row => row.latest?.spendReconciliation?.compass).length;
    const qianchuanCovered = matched.filter(row => row.latest?.spendReconciliation?.qianchuan).length;
    return { accounts: accountSummaries, startDate, endDate, omitLive, total: matched.length, offset, limit,
      hasMore: offset + rows.length < matched.length, totals, rooms: workspaceRooms,
      summary: { selectedRooms: matched.length, metrics: summaryMetrics },
      coverage: { adSpend: { available: reconciled > 0, reconciled, compassCovered, qianchuanCovered,
        reason: reconciled ? `已采集双方消耗 ${reconciled} 场` :
          matched.find(row => row.latest?.spendReconciliation?.reasons?.qianchuan)?.latest.spendReconciliation.reasons.qianchuan ||
          '当前范围尚未采到双方同场消耗' },
        uniqueViewers: { available: false, reason: '现有历史字段是进房人次，不是去重观众' } }, rows };
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
        if (['needs_login', 'scan', 'rate_limited', 'account_changed'].includes(error.kind)) {
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
      if (a.enabled && !this.store.targetName()) { this.pause(a.id, '未指定当前直播号，自动同步已暂停'); continue; }
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
      case 'room.workspace': return this.roomWorkspace(args);
      case 'history.batch.start': return this.startHistoryBatch(String(args.id || ''), args.startDate, args.endDate);
      case 'history.batch.resume': return this.startHistoryBatch(String(args.id || ''), null, null, true);
      case 'history.batch.pause': return this.pauseHistoryBatch(String(args.id || ''));
      case 'room.review': {
        const account = this.store.account(String(args.account || ''));
        const roomId = String(args.room || '');
        if (!/^\d{1,30}$/.test(roomId)) throw new Error('经营场次 ID 无效');
        const detail = this.store.review(account.id, roomId);
        return { account: { id: account.id, uid: account.uid, label: account.name || account.label,
                            state: account.state, enabled: account.enabled, error: account.error,
                            lastCheck: account.lastCheck, lastSync: account.lastSync },
                 room: detail.room, latest: detail.latest, history: detail.history, hourly: detail.hourly,
                 historyReport: detail.historyReport };
      }
      case 'hourly.refresh': return this.refreshHourly(String(args.account || ''), String(args.room || ''));
      case 'create': return { account: this.store.create(String(args.label || '')) };
      case 'remove': return this.remove(String(args.id || ''));
      case 'open': return this.open(String(args.id));
      case 'login': return this.login(String(args.id));
      case 'verify': return this.verifyIdentity(String(args.id));
      case 'target.set': return this.setTarget(args.name);
      case 'target.confirm': return this.confirmTarget(String(args.id));
      case 'provider.qianchuan.login': return this.engine.openProviderLogin('qianchuan');
      case 'provider.qianchuan.status':
      case 'provider.qianchuan.check': {
        const result = method.endsWith('check') ? await this.engine.checkQianchuanLogin() : await this.engine.qianchuanStatus();
        if (result.state === 'logged_in') this.store.saveQianchuanLastSuccessAt(result.lastSuccessAt || new Date().toISOString());
        return { ...result, lastSuccessAt: result.lastSuccessAt || this.store.qianchuanLastSuccessAt() };
      }
      case 'provider.qianchuan.enter': return this.engine.enterQianchuanAccount(args.accountId);
      case 'sync': return this.start(String(args.id));
      case 'monitor': {
        const id = String(args.id); this.store.account(id);
        if (typeof args.enabled !== 'boolean') throw new Error('同步开关必须为布尔值');
        if (args.enabled) return this.enable(id);
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
  const root = rpaDataRoot();
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
