import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const hotScript = readFileSync(new URL('../hot-insights-ui.js', import.meta.url), 'utf8');
const teamScript = readFileSync(new URL('../team-overview-ui.js', import.meta.url), 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
}[char]));
const tick = () => new Promise(resolve => setImmediate(resolve));

function node() {
  const listeners = new Map();
  return {
    innerHTML:'', textContent:'', value:'', disabled:false, dataset:{},
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatch(type, event = {}) { return listeners.get(type)?.({preventDefault() {}, target:this, ...event}); },
    querySelector() { return this.submit || (this.submit = node()); },
    setAttribute(name, value) { this[name] = value; },
  };
}

test('hot monitor escapes input and exports actual observations and session matches', async () => {
  const elements = new Map();
  const get = id => elements.get(id) || (elements.set(id, node()), elements.get(id));
  const exports = [], paths = [];
  const state = {
    terms:[{term:'<新品>', currentHot:123, currentRank:4, firstSeenAt:'2026-11-12T10:00:00Z', lastSeenAt:'2026-11-12T11:00:00Z',
      trend:[{sampledAt:'2026-11-12T10:00:00Z',hot:null,rank:null},{sampledAt:'2026-11-12T11:00:00Z',hot:123,rank:4}]}],
    latest:{sampledAt:'2026-11-12T11:00:00Z'}, sampleCount:2,
    sessions:[{title:'<促销场>',startedAt:'2026-11-12T10:00:00Z',matches:[{term:'<新品>',matchedIn:['title'],hotDuringSession:[{title:'<新品榜单>',hot:123,sampledAt:'2026-11-12T10:30:00Z'}]}]}],
  };
  const context = vm.createContext({
    document:{getElementById:get}, window:{}, location:{hash:'#keywords'}, esc:escape,
    formatTime:value => value || '—', toast() {},
    apiRequest:async path => { paths.push(path); return state; },
    downloadCsv:(filename, rows) => exports.push({filename,rows}),
  });
  vm.runInContext(hotScript, context);
  await tick();
  assert.match(get('hotWatchRows').innerHTML, /&lt;新品&gt;/);
  assert.doesNotMatch(get('hotWatchRows').innerHTML, /<新品>/);
  assert.match(get('hotWatchRows').innerHTML, /class="missing"/);
  assert.match(get('hotSessionRows').innerHTML, /&lt;促销场&gt;/);
  assert.match(get('hotSessionRows').innerHTML, /热度 123/);
  get('hotInsightsExport').dispatch('click');
  assert.equal(exports[0].filename, '热词监控与场次.csv');
  assert.equal(exports[0].rows.length, 4);
  assert.equal(exports[0].rows.at(-1)[7], '<促销场>');
  get('hotWatchTerm').value = '选题';
  get('hotWatchForm').dispatch('submit');
  await tick();
  assert.ok(paths.includes('/api/hot-insights/watch'));
});

test('team overview keeps missing metrics empty and switches aggregation dimension', async () => {
  const elements = new Map();
  const get = id => elements.get(id) || (elements.set(id, node()), elements.get(id));
  const tabs = ['accounts','stores','members'].map(value => ({...node(), dataset:{overviewGroup:value}}));
  const requested = [];
  const response = {
    available:true,startDate:'2026-11-01',endDate:'2026-11-15',totalSessions:3,loadedSessions:3,unmappedSessions:1,truncated:false,
    groups:{
      accounts:[{name:'<直播号>',sessions:2,watch:{value:120,coveredRooms:1},sales:{value:null,coveredRooms:0},spend:{value:'18.50',coveredRooms:1},reconciliation:{matched:1,compared:2,rate:.5}}],
      stores:[{name:'演示店铺',sessions:1,watch:{value:null,coveredRooms:0},sales:{value:20,coveredRooms:1},spend:{value:null,coveredRooms:0},reconciliation:{matched:0,compared:0,rate:null}}],
      members:[],
    },todos:[{memberName:'甲',actions:'核对 <内容>',dueDate:'2026-11-16'}],
  };
  const context = vm.createContext({
    document:{getElementById:get, querySelectorAll:() => tabs}, window:{}, location:{hash:'#operations'},
    URLSearchParams, esc:escape, apiRequest:async path => { requested.push(path); return response; },
  });
  vm.runInContext(teamScript, context);
  await tick();
  assert.match(get('opsOverviewRows').innerHTML, /&lt;直播号&gt;/);
  assert.match(get('opsOverviewRows').innerHTML, /1 \/ 2 场有值/);
  assert.match(get('opsOverviewRows').innerHTML, /未采集/);
  assert.doesNotMatch(get('opsOverviewRows').innerHTML, /NaN|<直播号>/);
  assert.match(get('opsTodoRows').innerHTML, /核对 &lt;内容&gt;/);
  tabs[1].dispatch('click');
  assert.match(get('opsOverviewRows').innerHTML, /演示店铺/);
  assert.doesNotMatch(get('opsOverviewRows').innerHTML, /<直播号>/);
  get('opsOverviewStart').value = '2026-11-04';
  get('opsOverviewStart').dispatch('change');
  await tick();
  assert.match(requested.at(-1), /startDate=2026-11-04/);
});

test('team source confirmation shows audit and submits the selected local mapping', async () => {
  const elements = new Map();
  const get = id => elements.get(id) || (elements.set(id, node()), elements.get(id));
  const ref = 'a'.repeat(64), requests = [];
  let state = {available:true, totalSessions:2, loadedSessions:2, groups:{accounts:[],stores:[],members:[]},
    mappings:[{id:'local-mapping',name:'合成直播号',sourceAlias:'同名来源',active:true}],
    sourceCandidates:[{sourceRef:ref,sourceAlias:'同名来源',sessions:1,sampleTitle:'<合成场次>'}],
    sourceConfirmations:[], todos:[]};
  const context = vm.createContext({document:{getElementById:get, querySelectorAll:() => [],
    querySelector:() => ({value:'local-mapping'})}, window:{}, location:{hash:'#operations'},
    URLSearchParams, esc:escape, apiRequest:async (path, options) => {
      requests.push({path,options});
      if (path.endsWith('/confirm')) state = {...state, sourceConfirmations:[{id:'audit-one',sourceRef:ref,
        sourceAlias:'同名来源',mappingId:'local-mapping',confirmedBy:'合成确认人',confirmedAt:'2026-11-15T10:00:00Z'}]};
      return state;
    }});
  vm.runInContext(teamScript, context);
  await tick();
  assert.match(get('opsSourceRows').innerHTML, /&lt;合成场次&gt;/);
  get('opsSourceActor').value = '合成确认人';
  get('opsSourceRows').dispatch('click', {target:{closest: selector => selector === '[data-source-confirm]' ?
    {dataset:{sourceConfirm:ref,sourceAlias:'同名来源'}} : null}});
  await tick();
  const confirmation = requests.find(item => item.path === '/api/team-overview/confirm');
  assert.ok(confirmation);
  assert.equal(JSON.parse(confirmation.options.body).actor, '合成确认人');
  assert.match(get('opsSourceAudit').innerHTML, /合成确认人/);
});
