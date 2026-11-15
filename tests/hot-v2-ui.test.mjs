import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../hot-insights-ui.js', import.meta.url), 'utf8');

function element() {
  const listeners = new Map();
  return { value:'', checked:false, textContent:'', innerHTML:'', disabled:false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatch(name) { return listeners.get(name)?.({preventDefault() {}, target:this}); },
    querySelector() { return this.submit || (this.submit = element()); },
  };
}

test('hot refresh settings and isolated sync controls use explicit opt-in', async () => {
  const elements = new Map(), requests = [];
  const get = id => elements.get(id) || (elements.set(id, element()), elements.get(id));
  const hot = {terms:[], latest:{sampledAt:'2026-11-15T10:00:00Z'}, sampleCount:1,
    stale:true, sessions:[], autoRefresh:{enabled:false,paused:false,intervalMinutes:60,lastError:null}};
  const sync = {enabled:false,configured:false,pending:0,retry:0,synced:0};
  const context = vm.createContext({document:{getElementById:get,activeElement:null},window:{},
    location:{hash:'#keywords'}, esc:value => String(value), formatTime:value => value,
    toast() {}, apiRequest:async (path, options) => {
      requests.push({path,options});
      return path === '/api/hot-insights/sync' ? sync : hot;
    }, downloadCsv() {}});
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(get('hotInsightsStatus').textContent, /采样已过期/);
  assert.equal(get('hotSyncEnabled').checked, false);
  get('hotAutoEnabled').checked = true;
  get('hotAutoPaused').checked = true;
  get('hotAutoInterval').value = '30';
  get('hotAutoForm').dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  const auto = requests.find(item => item.path === '/api/hot-insights/auto-refresh');
  assert.deepEqual(JSON.parse(auto.options.body), {enabled:true,paused:true,intervalMinutes:30});
  get('hotSyncEnabled').checked = true;
  get('hotSyncAppId').value = 'synthetic_app';
  get('hotSyncSecret').value = 'dummy_secret';
  get('hotSyncTable').value = 'https://demo.feishu.cn/base/synthetic?table=tblSynthetic';
  await get('hotSyncForm').dispatch('submit');
  const config = requests.find(item => item.path === '/api/hot-insights/sync/config');
  assert.equal(JSON.parse(config.options.body).enabled, true);
  assert.equal(get('hotSyncSecret').value, '');
  assert.equal(get('hotSyncTable').value, '');
});
