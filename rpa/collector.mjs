import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { BrowserEngine } from './engine.mjs';
import { roomList, historyBounds, historyWindow, historyRange, historyStartDate, historyRoomPage, validateHistoryEndpoint, normalizeHistoryReport, normalizeSnapshot, CollectError } from './model.mjs';
import { FeishuSync } from './feishu.mjs';

export class Collector {
  constructor(store, engine) {
    this.store = store; this.engine = engine; this.busy = new Map(); this.historyBusy = new Map(); this.next = new Map(); this.generation = new Map(); this.stopping = false;
    this.feishu = new FeishuSync(store);
  }
  state() {
    return { ready: true, accounts: this.store.accounts().map(a => ({ ...a, busy: this.busy.has(a.id), historyBusy: this.historyBusy.has(a.id), history: this.store.historyProgress(a.id), nextSync: a.enabled ? new Date(this.next.get(a.id) || Date.now()).toISOString() : null, rooms: this.store.rooms(a.id) })), events: this.store.events(), retentionDays: 30, historyBounds: historyBounds() };
  }
  pause(id, message = '已暂停自动同步') {
    const a = this.store.account(id);
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    this.store.save({ ...a, enabled: false, state: 'paused', error: null });
    this.store.event(id, message);
  }
  async login(id) {
    const a = this.store.account(id);
    await this.engine.open(id, true);
    this.store.save({ ...a, enabled: true, state: a.uid ? 'ready' : 'needs_login', error: null });
    this.next.set(id, 0);
    this.store.event(id, '已打开罗盘窗口，完成登录后将自动同步');
    this.start(id);
    return { ok: true };
  }
  start(id) {
    this.store.account(id);
    if (this.stopping) throw new Error('采集器正在停止');
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
      this.store.save({ ...this.store.account(id), state, error: errors.slice(0, 3).join('；') || null, lastSync: failed && !successes ? a.lastSync : new Date().toISOString(), lastCheck: checkedAt });
      this.store.event(id, rooms.length ? `检测到 ${rooms.length} 个今日场次，采集 ${selected.length} 场${failed ? `，${failed} 项接口失败` : '，数据已保存'}` : '账号在线，今日暂无直播场次');
      this.next.set(id, Date.now() + this.store.account(id).interval * 1000);
    } catch (error) {
      if (!current()) return;
      const state = error.kind || 'error';
      const message = String(error.message || '采集失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250);
      this.store.save({ ...this.store.account(id), state, error: message, lastCheck: checkedAt });
      this.store.event(id, message);
      this.next.set(id, Date.now() + (state === 'needs_login' ? 30 : state === 'rate_limited' ? 300 : 60) * 1000);
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
        const message = String(error.message || '历史场次读取失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250);
        this.store.saveHistoryProgress(id, { ...progress, error: message, lastReadAt: new Date().toISOString() });
        this.store.event(id, message);
        throw error;
      }
    })();
    this.historyBusy.set(id, task);
    try { return await task; } finally { this.historyBusy.delete(id); }
  }
  async historyReport(id, roomId) {
    const account = this.store.account(id);
    if (this.stopping || this.busy.has(id) || this.historyBusy.has(id)) throw new Error('该账号正在执行其他读取任务');
    if (!account.uid) throw new Error('请先完成罗盘账号身份核验');
    if (!/^\d{1,30}$/.test(roomId)) throw new Error('历史场次 ID 无效');
    const room = this.store.room(id, roomId);
    if (!room) throw new Error('请先将历史场次目录导入本机');
    if (room.state === 'live') throw new Error('直播中的场次请使用实时采集');
    const version = this.generation.get(id) || 0;
    const current = () => !this.stopping && version === (this.generation.get(id) || 0);
    const task = (async () => {
      try {
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return { cancelled: true };
        const names = ['historyBasic', 'historyCore', 'historyTrade'];
        const values = await Promise.all(names.map(async name => {
          try { return { ok: true, body: validateHistoryEndpoint(name, await this.engine.request(id, name, roomId)) }; }
          catch (error) {
            if (['needs_login', 'rate_limited', 'account_changed'].includes(error.kind)) throw error;
            return { ok: false, error: String(error.message || '读取失败').slice(0, 200) };
          }
        }));
        if (!current()) return { cancelled: true };
        const results = Object.fromEntries(names.map((name, index) => [name, values[index]]));
        if (!values.some(value => value.ok)) throw new CollectError('三个历史详情接口均未成功，原报表未覆盖。');
        await this.verifyHistoryIdentity(id, account.uid);
        if (!current()) return { cancelled: true };
        if (JSON.stringify(results).length > 2 * 1024 * 1024) throw new CollectError('历史详情超过本机保存上限，原报表未覆盖。');
        const report = normalizeHistoryReport(results, roomId);
        const previous = this.store.historyReport(id, roomId);
        if (previous && Object.values(previous.endpoints || {}).every(endpoint => endpoint.ok) && values.some(value => !value.ok)) {
          this.store.event(id, `历史场次 ${roomId} 本次部分接口失败，保留上次完整报表`);
          return { report: previous, warning: '部分接口失败，已保留上次完整报表' };
        }
        this.store.saveHistoryReport(id, roomId, report, results);
        this.store.event(id, `历史场次 ${roomId} 报表已读取：${report.metrics.length} 项指标${values.some(value => !value.ok) ? '，部分接口失败' : ''}；未写入飞书`);
        return { report };
      } catch (error) {
        if (!current()) return { cancelled: true };
        this.store.event(id, String(error.message || '历史报表读取失败').replace(/https?:\/\/\S+/g, '罗盘页面').slice(0, 250));
        throw error;
      }
    })();
    this.historyBusy.set(id, task);
    try { return await task; } finally { this.historyBusy.delete(id); }
  }
  tick() {
    if (this.stopping) return;
    this.feishu.tick();
    for (const a of this.store.accounts()) if (a.enabled && !this.busy.has(a.id) && !this.historyBusy.has(a.id) && Date.now() >= (this.next.get(a.id) || 0)) this.start(a.id);
  }
  async command(method, args = {}) {
    switch (method) {
      case 'feishu.state': return this.feishu.state();
      case 'feishu.config': return this.feishu.configure(args);
      case 'feishu.destination': return this.feishu.saveDestination(args);
      case 'feishu.test': return this.feishu.test();
      case 'feishu.sync': return this.feishu.sync();
      case 'feishu.monitor': return this.feishu.monitor(args.enabled);
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
        if (args.enabled) { this.store.save({ ...a, enabled: true }); this.next.set(id, 0); this.start(id); }
        else this.pause(id);
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
  let collector;
  const store = new Store(root);
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
  const close = async () => { if (closing) return; closing = true; clearInterval(timer); await collector.close(); process.exit(0); };
  reader.on('close', close); process.on('SIGTERM', close); process.on('SIGINT', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exit(1); });
