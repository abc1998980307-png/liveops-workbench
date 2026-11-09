import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, ORIGIN, CollectError, taskUrl, validateResponse } from './model.mjs';
import { profilePayloadFromPage, extractProfileCandidates } from './douyin-profile.mjs';

export class BrowserEngine {
  constructor(root, onClosed) { this.root = root; this.onClosed = onClosed; this.sessions = new Map(); this.launches = new Map(); this.profileSession = null; this.profileLaunch = null; this.profileQueue = Promise.resolve(); this.stopping = false; }
  async open(id, foreground = false) {
    let session = this.sessions.get(id);
    if (!session) {
      let pending = this.launches.get(id);
      if (!pending) {
        pending = this.launch(id).finally(() => this.launches.delete(id));
        this.launches.set(id, pending);
      }
      session = await pending;
    }
    if (session.page.isClosed()) session.page = await session.context.newPage();
    if (session.page.url() === 'about:blank') await session.page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (foreground) await session.page.bringToFront();
    return session;
  }
  async launch(id) {
    const modulePath = process.env.LIVEOPS_PLAYWRIGHT_MODULE;
    if (!modulePath || !fs.existsSync(modulePath)) throw new CollectError('浏览器采集组件未安装，请运行本地启动脚本。');
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const profile = path.join(this.root, 'profiles', id);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.LIVEOPS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: false, viewport: null, acceptDownloads: false,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const session = { context, page: context.pages()[0] || await context.newPage() };
    this.sessions.set(id, session);
    context.on('close', () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      if (!this.stopping) this.onClosed(id);
    });
    return session;
  }
  async request(id, task, room) {
    const session = await this.open(id);
    if (new URL(session.page.url()).origin !== ORIGIN) throw new CollectError('请在弹出的浏览器中完成罗盘登录。', 'needs_login');
    const response = await session.page.evaluate(async url => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { credentials: 'include', signal: controller.signal, headers: { Accept: 'application/json' } });
        const text = await res.text();
        if (text.length > 4 * 1024 * 1024) return { status: 413, body: null };
        let body; try { body = JSON.parse(text); } catch { body = null; }
        return { status: res.status, body };
      } catch (error) { return { status: 0, message: error.name === 'AbortError' ? '请求超时，请检查网络后重试。' : '网页请求失败，请检查浏览器和网络。' }; }
      finally { clearTimeout(timer); }
    }, taskUrl(task, room));
    if (!response.status) throw new CollectError(response.message);
    return validateResponse(response);
  }
  async lookupProfile(secUserId) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(secUserId))) throw new CollectError('抖音主页 ID 无效。');
    const request = this.profileQueue.then(() => this.readProfile(secUserId));
    this.profileQueue = request.catch(() => {});
    return request;
  }
  async openProfileReader() {
    if (this.profileSession?.browser.isConnected()) return this.profileSession;
    if (!this.profileLaunch) {
      this.profileLaunch = (async () => {
        const modulePath = process.env.LIVEOPS_PLAYWRIGHT_MODULE;
        if (!modulePath || !fs.existsSync(modulePath)) throw new CollectError('浏览器采集组件未安装，请运行本地启动脚本。');
        const { chromium } = await import(pathToFileURL(modulePath).href);
        const browser = await chromium.launch({
          executablePath: process.env.LIVEOPS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          headless: true,
          args: ['--no-first-run', '--no-default-browser-check'],
        });
        const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(30000);
        this.profileSession = { browser, context, page };
        return this.profileSession;
      })().finally(() => { this.profileLaunch = null; });
    }
    return this.profileLaunch;
  }
  async readProfile(secUserId) {
    const { page } = await this.openProfileReader();
    const profileUrl = `https://www.douyin.com/user/${encodeURIComponent(secUserId)}`;
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (new URL(page.url()).origin !== 'https://www.douyin.com') throw new CollectError('抖音主页跳转到了非抖音页面，已停止检测。');
      const response = await page.evaluate(async userId => {
        const url = new URL('/aweme/v1/web/user/profile/other/', window.location.origin);
        url.searchParams.set('device_platform', 'webapp');
        url.searchParams.set('aid', '6383');
        url.searchParams.set('sec_user_id', userId);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const res = await fetch(url.href, { credentials: 'include', signal: controller.signal, headers: { Accept: 'application/json, text/plain, */*' } });
          const rawText = await res.text();
          return { status: res.status, rawText: rawText.length <= 2 * 1024 * 1024 ? rawText : null, tooLarge: rawText.length > 2 * 1024 * 1024 };
        } catch (error) {
          return { status: 0, message: error.name === 'AbortError' ? '抖音主页请求超时。' : '抖音主页请求失败，请检查网络。' };
        } finally { clearTimeout(timer); }
      }, secUserId);
      if ([401, 403].includes(response.status)) throw new CollectError('抖音限制了主页查询，请稍后重试。');
      if (response.status === 429) throw new CollectError('抖音主页查询触发限流，请稍后重试。');
      if (response.tooLarge) throw new CollectError('抖音主页响应过大，已停止处理。');
      if (typeof response.rawText === 'string') {
        try {
          const parsed = JSON.parse(response.rawText);
          if (response.status === 200 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const code = parsed.status_code ?? parsed.code;
            const user = parsed.user;
            if ((code != null && String(code) !== '0') || (user && Object.hasOwn(user, 'room_data') && user.room_data !== null)) {
              return { rawJson: response.rawText };
            }
          }
        } catch {}
      }
      const candidates = await page.evaluate(extractProfileCandidates);
      const payload = profilePayloadFromPage(candidates, secUserId);
      if (payload) return payload;
      throw new CollectError(response.message || '无法从抖音主页确认直播状态。');
    } catch (error) {
      if (error instanceof CollectError) throw error;
      const message = String(error.message || '抖音主页读取失败').replace(/https?:\/\/\S+/g, '抖音主页').slice(0, 180);
      throw new CollectError(message);
    }
  }
  async close() {
    this.stopping = true;
    await Promise.allSettled([...this.launches.values()]);
    await Promise.allSettled([...this.sessions.values()].map(s => s.context.close()));
    this.sessions.clear();
    if (this.profileLaunch) await Promise.allSettled([this.profileLaunch]);
    if (this.profileSession) await this.profileSession.browser.close().catch(() => {});
    this.profileSession = null;
  }
}
