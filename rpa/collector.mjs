import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { BrowserEngine } from './engine.mjs';
import { roomList, normalizeSnapshot, CollectError } from './model.mjs';
import { FeishuSync } from './feishu.mjs';

export class Collector {
  constructor(store, engine) {
    this.store = store; this.engine = engine; this.busy = new Map(); this.next = new Map(); this.generation = new Map(); this.stopping = false;
    this.feishu = new FeishuSync(store);
  }
  state() {
    return { ready: true, accounts: this.store.accounts().map(a => ({ ...a, busy: this.busy.has(a.id), nextSync: a.enabled ? new Date(this.next.get(a.id) || Date.now()).toISOString() : null, rooms: this.store.rooms(a.id) })), events: this.store.events(), retentionDays: 30 };
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
    if (this.busy.has(id)) return { ok: true, queued: false, busy: true };
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
  tick() {
    if (this.stopping) return;
    this.feishu.tick();
    for (const a of this.store.accounts()) if (a.enabled && !this.busy.has(a.id) && Date.now() >= (this.next.get(a.id) || 0)) this.start(a.id);
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
