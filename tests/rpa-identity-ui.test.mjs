import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'rpa-ui.js'), 'utf8');
const start = script.indexOf('  function renderIdentity() {');
const end = script.indexOf('  function renderLegacy() {', start);
assert.ok(start >= 0 && end > start, 'identity renderer exists');
const renderer = script.slice(start, end);
const uncertainStart = script.indexOf('  const uncertain = a =>');
const uncertainEnd = script.indexOf('  const sessionStatus =', uncertainStart);
assert.ok(uncertainStart >= 0 && uncertainEnd > uncertainStart, 'session uncertainty helper exists');

function renderIdentity(targetName, account, qianchuanAccount = null) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent:'', value:'', hidden:false, disabled:false });
    return nodes.get(selector);
  };
  const host = {
    querySelector: node,
    classList: { toggle(name, enabled) { host.mismatch = name === 'mismatch' && enabled; } },
  };
  const context = {
    $, account: () => account, state: { targetName }, qianchuanAccount,
    actionBusy:false, document: { activeElement:null }, Date,
  };
  function $(id) { assert.equal(id, 'rpaIdentity'); return host; }
  vm.runInNewContext(`${script.slice(uncertainStart, uncertainEnd)}\n${renderer}\nrenderIdentity();`, context);
  return { host, node };
}

test('identity panel uses the observed login name rather than a stale saved name', () => {
  const view = renderIdentity('演示直播号甲', {
    name:'旧备注', observedName:'演示直播号乙', verifiedAt:new Date().toISOString(),
  });
  assert.equal(view.node('[data-rpa-observed-name]').textContent, '演示直播号乙');
  assert.equal(view.node('[data-rpa-target-name]').textContent, '演示直播号甲');
  assert.match(view.node('[data-rpa-identity-message]').textContent, /罗盘登录的是「演示直播号乙」.*当前直播号是「演示直播号甲」/);
  assert.equal(view.host.mismatch, true);
});

test('current Qianchuan account name appears after save and resets after clear without exposing an ID', () => {
  const account = { observedName:'直播号', verifiedAt:new Date().toISOString() };
  const unconfigured = renderIdentity('直播号', account);
  assert.equal(unconfigured.node('[data-rpa-qianchuan-name]').textContent, '尚未指定');

  const saved = renderIdentity('直播号', account, {
    configured:true, name:'演示千川户', maskedId:'********4321',
  });
  assert.equal(saved.node('[data-rpa-qianchuan-name]').textContent, '演示千川户');
  assert.match(saved.node('[data-rpa-identity-message]').textContent, /千川户「演示千川户」/);
  assert.doesNotMatch(saved.node('[data-rpa-qianchuan-name]').textContent, /4321/);
  assert.equal(renderIdentity('直播号', account).node('[data-rpa-qianchuan-name]').textContent, '尚未指定');
});

test('a similar live name remains a mismatch, and an unverified old name is not current login', () => {
  const similar = renderIdentity('演示直播号甲', {
    name:'演示直播号甲', observedName:'演示直播号甲分号', verifiedAt:new Date().toISOString(),
  });
  assert.equal(similar.node('[data-rpa-identity-status]').textContent, '身份不一致，自动同步禁止');
  const unverified = renderIdentity('演示直播号甲', { name:'演示直播号乙' });
  assert.equal(unverified.node('[data-rpa-observed-name]').textContent, '尚未现场核验');
  assert.match(unverified.node('[data-rpa-identity-message]').textContent, /上次保存的达人名称是「演示直播号乙」/);
  const stale = renderIdentity('演示直播号甲', {
    observedName:'演示直播号甲', verifiedAt:new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  assert.equal(stale.node('[data-rpa-observed-name]').textContent, '尚未现场核验');
  assert.equal(stale.node('[data-rpa-identity-status]').textContent, '等待校正');
  const uncertain = renderIdentity('演示直播号甲', {
    observedName:'演示直播号甲', verifiedAt:new Date().toISOString(), state:'network', enabled:true,
  });
  assert.equal(uncertain.node('[data-rpa-identity-status]').textContent, '上次身份一致，会话待确认');
});

test('provider shows verified login separately from the paused sync switch', () => {
  const helperStart = script.indexOf('  const verified = a =>');
  const helperEnd = script.indexOf('  const chip =', helperStart);
  const renderStart = script.indexOf('  function renderProviderStatus() {');
  const renderEnd = script.indexOf('  function renderIdentity() {', renderStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart && renderEnd > renderStart);
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent:'', className:'', hidden:false });
    return nodes.get(id);
  };
  const a = { observedName:'合成达人', verifiedAt:new Date().toISOString(),
    observedUidMatchesStored:true, enabled:false, state:'paused' };
  const context = { $, account: () => a, labels:{ paused:'同步已暂停' },
    actionBusy:false, date: () => 'recent', document:{ querySelectorAll: () => [] } };
  vm.runInNewContext(`${script.slice(helperStart, helperEnd)}\n${script.slice(renderStart, renderEnd)}\nrenderProviderStatus();`, context);
  assert.equal($('rpaCompassStatus').textContent, '已登录、同步已暂停');
  assert.equal($('rpaCompassSession').textContent, '已登录');
  assert.equal($('rpaCompassIdentity').textContent, '已核验');
  assert.equal($('rpaCompassSync').textContent, '已暂停');
  assert.equal($('rpaSwitchImpact').hidden, true);
  a.state = 'network';
  vm.runInNewContext('renderProviderStatus();', context);
  assert.equal($('rpaCompassSession').textContent, '暂无法确认');
  assert.equal($('rpaCompassIdentity').textContent, '上次已核验');
  assert.equal($('rpaCompassSync').textContent, '已暂停');
  a.state = 'needs_login'; a.verifiedAt = null; a.observedName = null;
  vm.runInNewContext('renderProviderStatus();', context);
  assert.equal($('rpaCompassStatus').textContent, '需要登录');
  assert.equal($('rpaCompassSession').textContent, '需要登录');
  a.state = 'ready'; a.enabled = true;
  vm.runInNewContext('renderProviderStatus();', context);
  assert.equal($('rpaSwitchImpact').hidden, false);
});
