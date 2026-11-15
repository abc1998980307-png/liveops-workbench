import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'rpa-ui.js'), 'utf8');
const start = script.indexOf('  function renderQianchuanAccount(card) {');
const end = script.indexOf('  async function act(action, payload = {}) {', start);
assert.ok(start >= 0 && end > start, 'Qianchuan account controls exist');
const controls = script.slice(start, end);

function makeCard() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent:'', hidden:false, disabled:false });
    return nodes.get(selector);
  };
  const card = {
    markup:'', form:null,
    querySelector(selector) { return selector === '[data-qianchuan-account-form]' ? this.form : null; },
    insertAdjacentHTML(_position, markup) {
      this.markup = markup;
      this.form = {
        elements: { name:{ value:'' }, accountId:{ value:'' } },
        querySelector: node,
        closest: () => card,
      };
    },
  };
  return { card, node };
}

test('account form saves a name, clears the entered ID, and returns to unconfigured', async () => {
  const { card, node } = makeCard();
  const enteredId = '9'.repeat(12);
  const calls = [];
  const context = {
    apiRequest: async (route, options) => {
      assert.equal(route, '/api/rpa/providers/qianchuan/account');
      const body = JSON.parse(options.body);
      calls.push(body);
      return body.clear ? { configured:false, name:'', maskedId:'' } :
        { configured:true, name:body.name, maskedId:'********9999' };
    },
    status() {}, toast() {}, state:null, document:{ activeElement:null },
  };
  vm.runInNewContext(`let qianchuanAccount = null, qianchuanAccountLoading = null;\n${controls}\n` +
    'globalThis.controls = { renderQianchuanAccount, saveQianchuanAccount };', context);
  context.controls.renderQianchuanAccount(card);
  assert.match(card.markup, /当前使用的户/);
  assert.match(card.markup, /户名称.*户 ID.*保存当前户.*进入当前户.*清除/);
  assert.equal(node('[data-qianchuan-account-summary]').textContent, '尚未指定');
  assert.equal(node('[data-qianchuan-account-clear]').hidden, true);

  card.form.elements.name.value = '演示千川户';
  card.form.elements.accountId.value = enteredId;
  await context.controls.saveQianchuanAccount(card.form);
  assert.equal(calls[0].accountId, enteredId);
  assert.equal(node('[data-qianchuan-account-summary]').textContent, '演示千川户 · ID ********9999');
  assert.equal(card.form.elements.accountId.value, '');
  assert.equal(node('[data-qianchuan-account-clear]').hidden, false);
  assert.ok(!card.markup.includes(enteredId));

  await context.controls.saveQianchuanAccount(card.form, true);
  assert.equal(calls[1].clear, true);
  assert.equal(node('[data-qianchuan-account-summary]').textContent, '尚未指定');
  assert.equal(node('[data-qianchuan-account-clear]').hidden, true);
});
