// Run the pinned upstream app on loopback, with a local health endpoint.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [plugin, portText, instance] = process.argv.slice(2);
const port = Number(portText);
if (!isAbsolute(plugin || '') || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{32}$/.test(instance || '')) {
  throw new Error('Invalid local hotspot service arguments');
}
const requirePlugin = createRequire(join(plugin, 'package.json'));
const pkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
if (pkg.name !== 'dailyhot-api' || pkg.version !== '2.0.8') throw new Error('Unexpected DailyHotApi version');
process.env.NODE_ENV = 'production';
process.env.USE_LOG_FILE = 'false';
const {serve} = requirePlugin('@hono/node-server');
const {default: app} = await import(pathToFileURL(join(plugin, 'dist/app.js')).href);
const {config} = await import(pathToFileURL(join(plugin, 'dist/config.js')).href);
if (typeof config.FILTER_WEIBO_ADVERTISEMENT !== 'boolean') throw new Error('DailyHotApi build lacks the configured filter; install the pinned component');
// Upstream has no console transport in production when file logging is off.
const {default: logger} = await import(pathToFileURL(join(plugin, 'dist/utils/logger.js')).href);
const {transports} = requirePlugin('winston');
logger.clear().add(new transports.Console({level:'warn'}));
const health = {service:'liveops-dailyhot', version:pkg.version, instance,
  settings:{cacheTTL:config.CACHE_TTL, requestTimeout:config.REQUEST_TIMEOUT, filterWeiboAds:config.FILTER_WEIBO_ADVERTISEMENT}};
const service = serve({
  hostname:'127.0.0.1', port,
  fetch(request, ...args) {
    if (new URL(request.url).pathname === '/__liveops_health') {
      return Response.json(health, {headers:{'cache-control':'no-store'}});
    }
    return app.fetch(request, ...args);
  },
});
service.on('error', error => { console.error(error.message); process.exit(1); });
const shutdown = () => {
  service.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
console.log('LiveOps hotspot service listening on loopback port ' + port);
