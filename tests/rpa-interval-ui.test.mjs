import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'rpa-ui.js'), 'utf8');
const start = script.indexOf('  function renderLegacy() {');
const end = script.indexOf('  function renderSummary() {', start);
assert.ok(start >= 0 && end > start, 'business account renderer exists');
const business = script.slice(start, end);

test('business page shows the fixed hourly interval and retains manual sync', () => {
  assert.match(business, /id="rpaSync">立即同步/);
  assert.match(business, /<select id="rpaInterval"[^>]* disabled><option value="3600">1 小时<\/option><\/select>/);
  assert.doesNotMatch(business, /<option value="(?:30|60|120|300|600)">/);
  assert.doesNotMatch(business, /act\('settings'/);
});
