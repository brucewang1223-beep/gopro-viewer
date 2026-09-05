#!/usr/bin/env node
/**
 * Entry point: load configuration, scan the library in the background, serve the UI.
 */

import { loadConfig, HELP } from './config.js';
import { createApp } from './app.js';
import { createLogger, setLogLevel } from './log.js';

const log = createLogger('main');

async function main() {
  const cfg = await loadConfig();
  if (cfg.help) { process.stdout.write(HELP); return; }
  setLogLevel(cfg.logLevel);

  const app = createApp(cfg);
  const server = app.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    log.info(`gopro-viewer listening on http://${cfg.host}:${addr.port}`);
    if (!cfg.roots.length) log.warn('no media roots configured — add one from the UI, config.json, or --media <dir>');
    else log.info(`media roots: ${cfg.roots.join(', ')}`);
    log.info(`cache: ${cfg.cacheDir}`);
    app.locals.library.scan().catch((e) => log.error('initial scan failed', e));
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log.error(`port ${cfg.port} is already in use (try --port <n>)`);
    else log.error('server error', e);
    process.exit(1);
  });

  const shutdown = (sig) => {
    log.info(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // a bug that escapes every handler ends the process with a readable line (launchd restarts it), not a bare stack
  process.on('uncaughtException', (e) => { log.error('uncaught exception — exiting', e); process.exit(1); });
  process.on('unhandledRejection', (e) => { log.error('unhandled rejection — exiting', e); process.exit(1); });
}

main().catch((e) => {
  log.error('fatal', e);
  process.stderr.write('\n' + HELP);
  process.exit(1);
});
