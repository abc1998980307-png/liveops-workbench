import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, ORIGIN, CollectError, taskUrl, validateResponse } from './model.mjs';
import { profilePayloadFromPage, extractProfileCandidates } from './douyin-profile.mjs';
import { qianchuanSpendRequest, qianchuanSpendSample } from './spend-source.mjs';
import { qianchuanHourlyRequest } from './hourly.mjs';
import { browserExecutable } from './platform.mjs';

export const LOGIN_PROVIDERS = Object.freeze({
  qianchuan: 'https://qianchuan.jinritemai.com/',
});

export function providerLoginUrl(provider) {
  if (!Object.hasOwn(LOGIN_PROVIDERS, provider)) throw new CollectError('不支持的登录平台');
  return LOGIN_PROVIDERS[provider];
}

export function qianchuanLoginState(pages) {
  if (pages.some(page => ['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'].includes(page.origin) &&
      page.pathname === '/login' && (page.hasSelectAccount || page.hasLogoutControl) &&
      (page.hasAccountSearch || page.hasAccountRows))) return 'logged_in';
  if (pages.some(page => page.origin === 'https://business.oceanengine.com' &&
      page.pathname === '/ebp/account-manage/ecp/bidding/universe/account' &&
      page.hasAccountControl && page.hasHomeContent)) return 'logged_in';
  if (pages.some(page => page.origin === 'https://qianchuan.jinritemai.com' &&
      page.pathname === '/home' && page.hasWorkspaceText && page.hasHomeContent)) return 'logged_in';
  if (pages.some(page => page.origin === 'https://qianchuan.jinritemai.com' &&
      page.pathname === '/dataV2/bidding/site-promotion' && page.hasWorkspaceText &&
      page.hasHomeContent && !page.hasLoginInput)) return 'logged_in';
  // An open official workspace can still be loading while an older login tab remains.
  if (pages.some(page => QIANCHUAN_ORIGINS.includes(page.origin) && page.pathname !== '/login'))
    return 'unknown';
  if (pages.some(page => ['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'].includes(page.origin) &&
      page.pathname === '/login' && !page.hasSelectAccount && !page.hasLogoutControl &&
      page.hasLoginInput)) return 'needs_login';
  return 'unknown';
}

const QIANCHUAN_ORIGINS = ['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'];
const isQianchuanLoginPage = page => {
  const url = new URL(page.url());
  return QIANCHUAN_ORIGINS.includes(url.origin) && url.pathname === '/login';
};

async function isAccountSelectionPage(page) {
  if (!isQianchuanLoginPage(page)) return false;
  return page.evaluate(() => {
    const lines = (document.body?.innerText || '').split('\n').map(line => line.trim());
    const search = [...document.querySelectorAll('input')].some(el =>
      el.placeholder === '请输入账户名称/ID' && el.getClientRects().length > 0);
    return (lines.includes('选择账户') || lines.includes('退出登录')) && search;
  }).catch(() => false);
}

export class BrowserEngine {
  constructor(root, onClosed) { this.root = root; this.onClosed = onClosed; this.sessions = new Map(); this.launches = new Map(); this.profileSession = null; this.profileLaunch = null; this.profileQueue = Promise.resolve(); this.lastQianchuanSuccessAt = null; this.stopping = false; }
  async session(id) {
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
    return session;
  }
  async open(id, foreground = false) {
    const session = await this.session(id);
    if (session.page.url() === 'about:blank') await session.page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (foreground) await session.page.bringToFront();
    return session;
  }
  async openProviderLogin(provider) {
    const url = providerLoginUrl(provider);
    const session = await this.session(`provider-${provider}`);
    const pages = session.context.pages().filter(page => !page.isClosed());
    const selectionPages = await Promise.all(pages.map(async page =>
      await isAccountSelectionPage(page) ? page : null));
    const accountPage = pages.find(page => {
      const current = new URL(page.url());
      return current.origin === 'https://business.oceanengine.com' &&
        current.pathname === '/ebp/account-manage/ecp/bidding/universe/account';
    });
    const workspacePage = pages.find(page => {
      const current = new URL(page.url());
      return QIANCHUAN_ORIGINS.includes(current.origin) &&
        ['/home', '/dataV2/bidding/site-promotion'].includes(current.pathname);
    });
    const loginPage = pages.find(page => {
      const current = new URL(page.url());
      return ['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'].includes(current.origin) &&
        current.pathname === '/login';
    });
    session.page = selectionPages.find(Boolean) || accountPage || workspacePage || loginPage || session.page;
    if (session.page.url() === 'about:blank' ||
        !['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'].includes(new URL(session.page.url()).origin)) {
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await session.page.bringToFront();
    return { opened: true, provider };
  }
  async qianchuanStatus() {
    const session = this.sessions.get('provider-qianchuan');
    if (!session) return { state: 'unknown', lastSuccessAt: this.lastQianchuanSuccessAt };
    const pages = await Promise.all(session.context.pages().filter(page => !page.isClosed()).map(async page => {
      const current = new URL(page.url());
      if (!['https://qianchuan.jinritemai.com', 'https://business.oceanengine.com'].includes(current.origin))
        return { origin: current.origin, pathname: current.pathname };
      const signals = await page.evaluate(() => ({
        hasTextInput: [...document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="password"]')].some(el =>
          el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'),
        hasLoginInput: [...document.querySelectorAll('input')].some(el =>
          el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' &&
          (['password', 'email'].includes(el.type) || /密码|邮箱|手机号|验证码/.test(el.placeholder || ''))),
        hasAccountSearch: [...document.querySelectorAll('input')].some(el =>
          el.placeholder === '请输入账户名称/ID' && el.getClientRects().length > 0),
        hasSelectAccount: (document.body?.innerText || '').split('\n').some(line => line.trim() === '选择账户'),
        hasLogoutControl: (document.body?.innerText || '').split('\n').some(line => line.trim() === '退出登录'),
        hasAccountRows: /(?:^|\n)\s*ID\s*[:：]\s*\d{1,64}(?=\s*(?:\n|$))/m.test(document.body?.innerText || ''),
        hasWorkspaceText: /首页|工作台|推广|投放|计划/.test(document.body?.innerText || ''),
        hasAccountControl: [...document.querySelectorAll('button,[role="button"]')].some(el =>
          el.innerText?.trim() === '账户' && el.getClientRects().length > 0),
        hasHomeContent: (document.body?.innerText || '').includes('首页'),
      })).catch(() => ({}));
      return { origin: current.origin, pathname: current.pathname, ...signals };
    }));
    const checkedAt = new Date().toISOString();
    const state = qianchuanLoginState(pages);
    if (state === 'logged_in') this.lastQianchuanSuccessAt = checkedAt;
    return { state, checkedAt, lastSuccessAt: this.lastQianchuanSuccessAt,
      pages: pages.map(page => ({ ...page, pathname: page.pathname.replace(/\d+/g, '[已隐藏]') })) };
  }
  async checkQianchuanLogin() {
    const session = await this.session('provider-qianchuan');
    const current = await this.qianchuanStatus();
    if (current.state !== 'unknown') return current;
    if (session.context.pages().some(page => {
      if (page.isClosed()) return false;
      const url = new URL(page.url());
      return QIANCHUAN_ORIGINS.includes(url.origin);
    })) return current;
    if (session.page.url() !== 'about:blank') return current;
    await session.page.goto(providerLoginUrl('qianchuan'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await session.page.waitForURL(url => url.origin === 'https://business.oceanengine.com' &&
      url.pathname === '/ebp/account-manage/ecp/bidding/universe/account', { timeout: 6000 }).catch(() => {});
    return this.qianchuanStatus();
  }
  async enterQianchuanAccount(accountId) {
    if (typeof accountId !== 'string' || !/^\d{1,64}$/.test(accountId))
      throw new CollectError('请先在“当前使用的户”填写并保存户 ID。');
    const session = await this.session('provider-qianchuan');
    const state = await this.checkQianchuanLogin();
    if (state.state === 'needs_login')
      throw new CollectError('千川会话需要登录，请先在官网完成登录。', 'needs_login');
    if (state.state !== 'logged_in')
      throw new CollectError('暂无法确认千川已登录，请检查官方千川窗口。');
    const pages = session.context.pages().filter(page => !page.isClosed());
    const selectionPages = await Promise.all(pages.map(async page =>
      await isAccountSelectionPage(page) ? page : null));
    let page = selectionPages.find(Boolean);
    if (!page) {
      page = pages.find(candidate => QIANCHUAN_ORIGINS.includes(new URL(candidate.url()).origin)) || session.page;
      await page.goto(new URL('/login', providerLoginUrl('qianchuan')).href,
        { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('input[placeholder="请输入账户名称/ID"]').waitFor({ state: 'visible', timeout: 12000 })
        .catch(() => {});
      if (!await isAccountSelectionPage(page))
        throw new CollectError('已登录，但未能到达千川官方“选择账户”页，请检查千川窗口。');
    }
    session.page = page;
    return this.enterQianchuanAccountPage(page, accountId, session.context);
  }
  async enterQianchuanAccountPage(page, accountId, context) {
    if (!await isAccountSelectionPage(page))
      throw new CollectError('当前窗口不是千川官方“选择账户”页。');
    try {
      await page.locator('input[placeholder="请输入账户名称/ID"]').fill(accountId);
      await page.waitForFunction(id =>
        [...document.querySelectorAll('body *')].some(el =>
          el.getClientRects().length > 0 &&
          [...String(el.innerText || '').matchAll(/(?:^|\n)\s*ID\s*[:：]\s*(\d{1,64})(?=\s*(?:\n|$))/g)]
            .some(match => match[1] === id)), accountId, { timeout: 8000 }).catch(() => {});
      const target = await page.evaluate(id => {
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const ids = text => [...String(text || '').matchAll(/(?:^|\n)\s*ID\s*[:：]\s*(\d{1,64})(?=\s*(?:\n|$))/g)]
          .map(match => match[1]);
        const matches = [...document.querySelectorAll('body *')].filter(el =>
          visible(el) && ids(el.innerText).includes(id) &&
          ![...el.children].some(child => visible(child) && ids(child.innerText).includes(id)));
        document.querySelectorAll('[data-liveops-qianchuan-target]').forEach(el =>
          el.removeAttribute('data-liveops-qianchuan-target'));
        if (matches.length === 1) matches[0].setAttribute('data-liveops-qianchuan-target', 'true');
        return matches.length;
      }, accountId);
      if (target === 0) throw new CollectError('选户列表中未找到已保存的当前户 ID。');
      if (target !== 1) throw new CollectError('选户列表中该户 ID 出现多次，已停止进入。');
      const priorPages = new Set(context.pages());
      await page.locator('[data-liveops-qianchuan-target="true"]').click();
      await page.waitForURL(url => QIANCHUAN_ORIGINS.includes(url.origin) && url.pathname !== '/login',
        { timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return !text.split('\n').some(line => line.trim() === '选择账户') &&
          /首页|工作台|推广|投放|计划/.test(text);
      }, undefined, { timeout: 15000 }).catch(() => {});
      const candidates = [page, ...context.pages().filter(candidate => !priorPages.has(candidate))];
      for (const candidate of candidates) {
        if (candidate.isClosed()) continue;
        const url = new URL(candidate.url());
        if (!QIANCHUAN_ORIGINS.includes(url.origin) || url.pathname === '/login') continue;
        const workspace = await candidate.evaluate(() => {
          const text = document.body?.innerText || '';
          return !text.split('\n').some(line => line.trim() === '选择账户') &&
            /首页|工作台|推广|投放|计划/.test(text);
        }).catch(() => false);
        if (workspace) return { entered: true, origin: url.origin,
          pathname: url.pathname.replace(/\d+/g, '[已隐藏]') };
      }
      throw new CollectError('已点击匹配的户，但未确认进入工作台；请检查千川窗口。');
    } catch (error) {
      if (error instanceof CollectError) throw error;
      throw new CollectError('千川选户操作失败，请检查官方页面后重试。');
    }
  }
  async qianchuanSpend(accountId, room) {
    const session = this.sessions.get('provider-qianchuan');
    if (!session || session.page.isClosed())
      throw new CollectError('千川会话未打开或已关闭，无法确认当前户。');
    const pages = session.context.pages().filter(page => !page.isClosed());
    const current = new URL(session.page.url());
    if (current.origin !== 'https://qianchuan.jinritemai.com' ||
        current.pathname === '/login' || current.searchParams.get('aavid') !== accountId ||
        pages.some(page => {
          const url = new URL(page.url());
          return url.origin === current.origin &&
            (url.pathname === '/login' || (url.searchParams.has('aavid') && url.searchParams.get('aavid') !== accountId));
        })) throw new CollectError('千川当前页不在已保存的当前户，已停止本轮消耗赋值。');
    const loggedIn = await session.page.evaluate(() => {
      const text = document.body?.innerText || '';
      const loginInput = [...document.querySelectorAll('input')].some(el =>
        el.getClientRects().length > 0 && (el.type === 'password' || /验证码|手机号/.test(el.placeholder || '')));
      return !loginInput && /首页|全域投放数据|整体消耗/.test(text);
    }).catch(() => false);
    if (!loggedIn) throw new CollectError('千川登录态或当前户页面无法确认，已停止本轮消耗赋值。', 'needs_login');
    const request = qianchuanSpendRequest(accountId, room.id, room.startedAt);
    const response = await session.page.evaluate(async ({ url, body }) => {
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
        const text = await res.text();
        if (text.length > 1024 * 1024) return { status: 413 };
        let json; try { json = JSON.parse(text); } catch { json = null; }
        return { status: res.status, body: json };
      } catch { return { status: 0 }; }
    }, request);
    if ([401, 403].includes(response.status))
      throw new CollectError('千川登录失效或当前户无权查看同场报表。', 'needs_login');
    if (response.status !== 200 || !response.body)
      throw new CollectError('千川同场报表请求失败或没有返回可核验数据。');
    try { return qianchuanSpendSample(response.body, room.id, new Date().toISOString()); }
    catch (error) { throw new CollectError(String(error.message).slice(0, 120)); }
  }
  async qianchuanHourly(accountId, room) {
    const session = this.sessions.get('provider-qianchuan');
    if (!session || session.page.isClosed()) throw new CollectError('千川会话未打开，小时桶未读取。');
    const current = new URL(session.page.url());
    if (current.origin !== 'https://qianchuan.jinritemai.com' || current.pathname !== '/home' ||
        current.searchParams.get('aavid') !== accountId)
      throw new CollectError('千川不在已保存当前户的 /home，小时桶未读取。');
    const request = qianchuanHourlyRequest(accountId, room);
    const response = await session.page.evaluate(async ({ url, body }) => {
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
        const text = await res.text();
        if (text.length > 2 * 1024 * 1024) return { status: 413 };
        return { status: res.status, body: JSON.parse(text) };
      } catch { return { status: 0 }; }
    }, request);
    if ([401, 403].includes(response.status)) throw new CollectError('千川登录失效或当前户无权查看分时报表。', 'needs_login');
    if (response.status !== 200 || !response.body) throw new CollectError('千川分时报表请求失败。');
    return response.body;
  }
  async launch(id) {
    const modulePath = process.env.LIVEOPS_PLAYWRIGHT_MODULE;
    if (!modulePath || !fs.existsSync(modulePath)) throw new CollectError('浏览器采集组件未安装，请运行本地启动脚本。');
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const executablePath = browserExecutable();
    if (!executablePath || !fs.existsSync(executablePath))
      throw new CollectError('未找到 Chrome 或 Edge，请安装浏览器或设置 LIVEOPS_CHROME。');
    const profile = path.join(this.root, 'profiles', id);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: false, viewport: null, acceptDownloads: false,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const session = { context, page: context.pages()[0] || await context.newPage() };
    this.sessions.set(id, session);
    context.on('close', () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      if (!this.stopping && !id.startsWith('provider-')) this.onClosed(id);
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
        const executablePath = browserExecutable();
        if (!executablePath || !fs.existsSync(executablePath))
          throw new CollectError('未找到 Chrome 或 Edge，请安装浏览器或设置 LIVEOPS_CHROME。');
        const browser = await chromium.launch({
          executablePath,
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
