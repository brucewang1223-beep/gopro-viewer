import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { loadConfig, saveConfig, PROJECT_ROOT } from '../server/config.js';
import { withTempDir } from './helpers.js';

const NO_ENV = {};   // the real environment must not leak into the tests

test('command-line options: aliases, repeatable roots, positional roots, and clear errors', async () => withTempDir(async (dir) => {
  const cfg = await loadConfig({ argv: ['-m', dir, '--media', dir, '/tmp', '-p', '9000', '--host', '0.0.0.0', '--log-level', 'DEBUG', '--accel-hz', '50', '-c', path.join(dir, 'none.json')], env: NO_ENV });
  assert.deepEqual(cfg.roots, [dir, '/tmp'], 'unique, in order');
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.logLevel, 'DEBUG', 'case is the logger\'s business');
  assert.equal(cfg.accelHz, 50);
  await assert.rejects(loadConfig({ argv: ['--port'], env: NO_ENV }), /--port needs a value/);
  await assert.rejects(loadConfig({ argv: ['--media'], env: NO_ENV }), /--media needs a value/);
  await assert.rejects(loadConfig({ argv: ['--bogus'], env: NO_ENV }), /Unknown option: --bogus/);
  await assert.rejects(loadConfig({ argv: ['--port', 'abc'], env: NO_ENV }), /Invalid port/);
  await assert.rejects(loadConfig({ argv: ['--log-level', 'loud'], env: NO_ENV }), /Invalid logLevel/);
  await assert.rejects(loadConfig({ argv: ['--host', ''], env: NO_ENV }), /host must be/);
  assert.equal((await loadConfig({ argv: ['--help'], env: NO_ENV })).help, true);
}));

test('config.json: defaults fill the gaps, a null import block is an empty one, bad values are refused', async () => withTempDir(async (dir) => {
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ port: 8791, roots: [dir], import: null, map: { provider: 'osm' }, extra: 'kept' }));
  const cfg = await loadConfig({ argv: ['--config', file], env: NO_ENV });
  assert.equal(cfg.port, 8791);
  assert.equal(cfg.host, '127.0.0.1');
  assert.deepEqual(cfg.import, { dest: '', lrv: true, thm: false, camera: '' });
  assert.equal(cfg.map.basemap, 'streets');
  assert.equal(cfg.extra, 'kept');
  assert.equal(cfg.cacheDir, path.join(PROJECT_ROOT, '.cache'));
  await writeFile(file, JSON.stringify({ map: { provider: 'k2', api: 'map.lumobility.com/api' } }));
  await assert.rejects(loadConfig({ argv: ['--config', file], env: NO_ENV }), /map.api and map.glyphs must be http\(s\) URLs/);
  await writeFile(file, JSON.stringify({ import: { lrv: 'yes' } }));
  await assert.rejects(loadConfig({ argv: ['--config', file], env: NO_ENV }), /import.lrv and import.thm/);
  await writeFile(file, '[1, 2]');
  await assert.rejects(loadConfig({ argv: ['--config', file], env: NO_ENV }), /not a JSON object/);
  await writeFile(file, '{ nope');
  await assert.rejects(loadConfig({ argv: ['--config', file], env: NO_ENV }), /Cannot read config/);
}));

test('saveConfig writes the UI\'s changes onto the file\'s own content — command-line values never become permanent', async () => withTempDir(async (dir) => {
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ port: 8791, logLevel: 'debug', cacheDir: '/tmp/gv-cache', roots: [], map: { provider: 'osm', token: 'keep-me' }, note: 'unknown keys survive' }, null, 2));
  const cfg = await loadConfig({ argv: ['--config', file, '--port', '9999', '--host', '0.0.0.0', '--media', dir], env: { GOPRO_VIEWER_MEDIA: '/tmp' } });
  assert.equal(cfg.port, 9999);
  cfg.roots = [...cfg.roots, path.join(dir, 'more')];
  cfg.import = { ...cfg.import, dest: path.join(dir, 'footage'), lrv: false };
  await saveConfig(cfg);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.port, 8791, 'the --port of this run is not written');
  assert.equal(saved.host, undefined, 'nor the --host');
  assert.equal(saved.logLevel, 'debug');
  assert.equal(saved.cacheDir, '/tmp/gv-cache');
  assert.equal(saved.note, 'unknown keys survive');
  assert.equal(saved.map.token, 'keep-me');
  assert.deepEqual(saved.roots, ['/tmp', dir, path.join(dir, 'more')], 'the roots as the UI sees them (file, environment, command line, then the addition)');
  assert.deepEqual(saved.import, { dest: path.join(dir, 'footage'), lrv: false, thm: false, camera: '' });
  assert.equal(saved.ledgerFile, undefined, 'the default ledger path is not pinned');
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'the temporary file of the atomic write is gone');
  // a second save starts from what the first one wrote
  cfg.roots = [dir];
  await saveConfig(cfg);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).roots, [dir]);
}));

test('saveConfig without a config.json writes only what the UI owns, plus a custom ledger path', async () => withTempDir(async (dir) => {
  const file = path.join(dir, 'config.json');
  const cfg = { configFile: file, roots: [dir], import: { dest: '', lrv: true, thm: false, camera: '' }, ledgerFile: path.join(dir, 'ledger.json'), host: '0.0.0.0', port: 1234 };
  await saveConfig(cfg);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { roots: [dir], import: cfg.import, ledgerFile: cfg.ledgerFile });
}));
