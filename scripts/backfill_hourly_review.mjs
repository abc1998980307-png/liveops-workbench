import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Store } from '../rpa/store.mjs';
import { FeishuSync } from '../rpa/feishu.mjs';

const targetName = '雪梨老师阅读100篇';
const root = process.env.LIVEOPS_RPA_DATA || path.join(process.env.LIVEOPS_DATA_ROOT ||
  (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'LiveOps') :
    path.join(os.homedir(), 'Library', 'Application Support', 'LiveOps')), 'rpa');

if (!path.isAbsolute(root) || !fs.existsSync(path.join(root, 'data.sqlite')))
  throw new Error('本机采集数据库不存在，请核对 LIVEOPS_RPA_DATA');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liveops-review-backfill-'));
let source, store, sync;
try {
  source = new DatabaseSync(path.join(root, 'data.sqlite'), { readOnly: true });
  await backup(source, path.join(temporaryRoot, 'data.sqlite'));
  source.close(); source = null;
  store = new Store(temporaryRoot);
  sync = new FeishuSync(store);
  const selected = sync.config.accountIds || [];
  if (store.targetName() !== targetName ||
      selected.filter(id => store.account(id).name === targetName).length !== 1)
    throw new Error('目标直播号与飞书同步账号不一致，已停止回填');
  if (!sync.state().configured) throw new Error('飞书应用尚未配置');
  if (process.argv.includes('--check-only')) {
    console.log(`小时复盘候选：${sync.pendingHourly().length} 行`);
  } else {
    let previous = -1;
    for (let pass = 0; pass < 1000; pass++) {
      const pending = sync.pendingHourly().length;
      if (!pending) break;
      const delivered = sync.state().hourlySynced;
      if (pending === previous && delivered === 0) throw new Error('小时复盘回填无进展');
      previous = pending;
      sync.syncReviewOnly();
      await sync.busy;
      if (sync.state().error) throw new Error(sync.state().error);
    }
    if (sync.pendingHourly().length) throw new Error('小时复盘回填未完成，请再次运行');
    console.log(`小时复盘回填完成：${sync.state().hourlySynced} 行`);
  }
} finally {
  if (sync) await sync.close();
  if (store) store.close();
  if (source) source.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
