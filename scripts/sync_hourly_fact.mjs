import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rpaDataRoot } from '../rpa/platform.mjs';
import { FeishuError } from '../rpa/feishu.mjs';
import { HourlyFactSync } from '../rpa/hourly-fact-sync.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([a-z-]+)=(.*)$/.exec(arg);
  if (!match) throw new Error('仅支持明确的小时事实写入参数');
  return [match[1], match[2]];
}));
if (options.execute !== 'true' || !options.since ||
    Object.keys(options).some(key => !['execute', 'since', 'data-dir', 'limit'].includes(key)))
  throw new Error('需显式指定 --execute=true 与 --since=ISO；本入口不自动同步或回填');
const root = options['data-dir'] || rpaDataRoot();
if (!path.isAbsolute(root) || !fs.existsSync(path.join(root, 'data.sqlite')))
  throw new Error('小时事实本地数据目录无效');

const db = new DatabaseSync(path.join(root, 'data.sqlite'), { readOnly: true });
const source = {
  db,
  targetName: () => db.prepare("SELECT value FROM settings WHERE key='targetName'").get()?.value || '',
  account: id => {
    const row = db.prepare('SELECT json FROM accounts WHERE id=?').get(id);
    if (!row) throw new Error('小时事实账号不存在');
    return JSON.parse(row.json);
  },
  room: (account, room) => {
    const row = db.prepare('SELECT json FROM rooms WHERE account=? AND id=?').get(account, room);
    return row ? JSON.parse(row.json) : null;
  },
};
let sync;
try {
  sync = new HourlyFactSync(root, source);
  const result = await sync.sync({ since: options.since,
    limit: options.limit === undefined ? 20 : Number(options.limit) });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof FeishuError ? error.message : '小时事实写入失败；待同步数据已保留');
  process.exitCode = 1;
} finally {
  sync?.close();
  db.close();
}
