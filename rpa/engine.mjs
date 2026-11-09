import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, ORIGIN, CollectError, taskUrl, validateResponse } from './model.mjs';

export class BrowserEngine {
  constructor(root, onClosed) { this.root = root; this.onClosed = onClosed; this.sessions = new Map(); this.launches = new Map(); this.stopping = false; }
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
  async close() {
    this.stopping = true;
    await Promise.allSettled([...this.launches.values()]);
    await Promise.allSettled([...this.sessions.values()].map(s => s.context.close()));
    this.sessions.clear();
  }
}
