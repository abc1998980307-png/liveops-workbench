import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { browserExecutable, rpaDataRoot } from '../rpa/platform.mjs';

const winHome = 'C:\\Users\\测试用户';

test('RPA data directory follows the shared platform root and overrides', () => {
  assert.equal(rpaDataRoot({ platform: 'darwin', env: {}, home: '/Users/测试用户' }),
    '/Users/测试用户/Library/Application Support/LiveOps/rpa');
  assert.equal(rpaDataRoot({ platform: 'win32', env: { APPDATA: `${winHome}\\AppData\\Roaming` }, home: winHome }),
    `${winHome}\\AppData\\Roaming\\LiveOps\\rpa`);
  assert.equal(rpaDataRoot({ platform: 'win32', env: {}, home: winHome }),
    `${winHome}\\AppData\\Roaming\\LiveOps\\rpa`);
  assert.equal(rpaDataRoot({ platform: 'win32', env: { LIVEOPS_DATA_ROOT: 'D:\\直播数据' }, home: winHome }),
    'D:\\直播数据\\rpa');
  assert.equal(rpaDataRoot({ platform: 'win32', env: {
    LIVEOPS_DATA_ROOT: 'D:\\直播数据', LIVEOPS_RPA_DATA: 'E:\\采集数据' }, home: winHome }),
  'E:\\采集数据');
  assert.throws(() => rpaDataRoot({ platform: 'win32', env: { LIVEOPS_DATA_ROOT: 'relative' }, home: winHome }), /绝对路径/);
  assert.throws(() => rpaDataRoot({ platform: 'darwin', env: { LIVEOPS_RPA_DATA: 'relative' } }), /绝对路径/);
});

test('Windows browser discovery checks Chrome locations then Edge', () => {
  const env = { PROGRAMFILES: 'D:\\Program Files', 'PROGRAMFILES(X86)': 'D:\\Program Files (x86)',
    LOCALAPPDATA: `${winHome}\\AppData\\Local` };
  const chrome = path.win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const edge = path.win32.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const options = { platform: 'win32', env, home: winHome };
  assert.equal(browserExecutable({ ...options, exists: candidate => candidate === chrome || candidate === edge }), chrome);
  assert.equal(browserExecutable({ ...options, exists: candidate => candidate === edge }), edge);
  assert.equal(browserExecutable({ ...options, exists: () => false }), null);
  assert.equal(browserExecutable({ ...options, env: { ...env, LIVEOPS_CHROME: 'E:\\Browser\\chrome.exe' },
    exists: () => false }), 'E:\\Browser\\chrome.exe');
});

test('macOS browser discovery keeps Chrome and honors an explicit executable', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(browserExecutable({ platform: 'darwin', env: {}, exists: candidate => candidate === chrome }), chrome);
  assert.equal(browserExecutable({ platform: 'darwin', env: {}, exists: () => false }), null);
  assert.equal(browserExecutable({ platform: 'darwin', env: { LIVEOPS_CHROME: '/custom/browser' },
    exists: () => false }), '/custom/browser');
});
