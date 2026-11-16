import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../rpa/store.mjs';
import { Collector } from '../rpa/collector.mjs';

test('removing a Compass connection archives it without clearing local history or profile', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-remove-'));
  const store = new Store(root);
  const engine = { close: async () => {} };
  const collector = new Collector(store, engine);
  try {
    const account = store.create('合成连接');
    const other = store.create('另一合成连接');
    store.save({ ...account, enabled: true });
    store.saveRoom(account.id, { id: '1', title: '合成场次', state: 'ended' });
    store.saveHistoryBatch(account.id, { status: 'running', nextIndex: 0 });
    const profile = path.join(root, 'profiles', account.id);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'marker'), 'profile remains');
    collector.feishu.config = { ...collector.feishu.config,
      accountIds: [account.id, other.id], enabled: true, historyEnabled: true };
    collector.feishu.persist();

    assert.deepEqual(await collector.command('remove', { id: account.id }), { removed: true });
    assert.deepEqual(collector.state().accounts.map(item => item.id), [other.id]);
    assert.equal(store.accounts().length, 1);
    assert.throws(() => store.account(account.id), /账号不存在/);
    assert.throws(() => store.save(account), /账号已移除/);
    assert.equal(JSON.parse(store.db.prepare('SELECT json FROM accounts WHERE id=?').get(account.id).json).enabled, false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE account=?').get(account.id).count, 1);
    assert.equal(store.historyBatch(account.id).status, 'paused');
    assert.equal(fs.readFileSync(path.join(profile, 'marker'), 'utf8'), 'profile remains');
    assert.doesNotThrow(() => collector.pause(account.id, '窗口关闭'));
    assert.deepEqual(collector.feishu.config.accountIds, [other.id]);
    assert.equal(collector.feishu.config.enabled, true);
    assert.equal(collector.feishu.config.historyEnabled, true);
    await assert.rejects(collector.command('remove', { id: account.id }), /账号不存在/);
  } finally {
    await collector.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removing the only selected connection pauses Feishu and rejects removal during a delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-remove-'));
  const store = new Store(root);
  const collector = new Collector(store, { close: async () => {} });
  try {
    const account = store.create('合成连接');
    collector.feishu.config = { ...collector.feishu.config,
      accountIds: [account.id], enabled: true, historyEnabled: true };
    collector.feishu.persist();
    collector.feishu.busy = Promise.resolve();
    assert.throws(() => collector.remove(account.id), /飞书同步正在进行/);
    assert.equal(store.accounts().length, 1);
    collector.feishu.busy = null;
    collector.remove(account.id);
    assert.deepEqual(collector.feishu.config.accountIds, []);
    assert.equal(collector.feishu.config.enabled, false);
    assert.equal(collector.feishu.config.historyEnabled, false);
  } finally {
    await collector.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('last successful Qianchuan check remains visible after collector restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-status-'));
  const store = new Store(root);
  const checkedAt = '2026-11-16T08:00:00.000Z';
  const collector = new Collector(store, {
    qianchuanStatus: async () => ({ state:'logged_in', lastSuccessAt:checkedAt }),
    close: async () => {},
  });
  try {
    assert.equal((await collector.command('provider.qianchuan.status')).lastSuccessAt, checkedAt);
    assert.equal(store.qianchuanLastSuccessAt(), checkedAt);
    const reopened = new Store(root);
    const later = new Collector(reopened, { qianchuanStatus: async () => ({ state:'unknown' }), close: async () => {} });
    assert.equal((await later.command('provider.qianchuan.status')).lastSuccessAt, checkedAt);
    await later.close();
  } finally {
    await collector.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
