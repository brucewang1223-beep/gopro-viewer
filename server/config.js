/**
 * Configuration: defaults ← config.json ← environment ← CLI flags.
 *
 *   CLI    : --media <dir> (repeatable)  --port <n>  --host <ip>  --config <file>  --cache <dir>  --accel-hz <n>  --log-level <lvl>
 *   Env    : GOPRO_VIEWER_MEDIA (":"-separated), GOPRO_VIEWER_PORT, GOPRO_VIEWER_HOST, GOPRO_VIEWER_CACHE, GOPRO_VIEWER_CONFIG, LOG_LEVEL
 *   File   : config.json in the project root (see config.example.json). Roots added from the UI are persisted here.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8790,
  roots: [],
  accelHz: 25,
  tiles: 'osm',
  cacheDir: path.join(PROJECT_ROOT, '.cache'),
  configFile: path.join(PROJECT_ROOT, 'config.json'),
  logLevel: 'info',
});

export const HELP = `gopro-viewer — local GoPro video + telemetry viewer

Usage: node server/index.js [options] [mediaDir ...]

Options:
  -m, --media <dir>     media root to scan (repeatable; positional args work too)
  -p, --port <n>        listen port (default 8790)
      --host <ip>       bind address (default 127.0.0.1; use 0.0.0.0 to expose on LAN)
  -c, --config <file>   config file (default ./config.json)
      --cache <dir>     cache directory (default ./.cache)
      --accel-hz <n>    IMU downsample rate sent to the UI (default 25)
      --log-level <l>   debug | info | warn | error
  -h, --help            show this help
`;

function parseArgs(argv) {
  const out = { roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--media': case '-m': out.roots.push(next()); break;
      case '--port': case '-p': out.port = Number(next()); break;
      case '--host': out.host = next(); break;
      case '--config': case '-c': out.configFile = path.resolve(next()); break;
      case '--cache': out.cacheDir = path.resolve(next()); break;
      case '--accel-hz': out.accelHz = Number(next()); break;
      case '--log-level': out.logLevel = next(); break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
        out.roots.push(a); // bare positional = media root
    }
  }
  return out;
}

async function readConfigFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot read config ${file}: ${e.message}`, { cause: e });
  }
}

/** First value that is neither undefined nor null. */
const first = (...values) => values.find((v) => v != null);

const numberOrUndefined = (s) => (s ? Number(s) : undefined);

/** Unique, absolute media roots in precedence order (file, env, CLI). */
function mergeRoots(fileRoots, envRoots, cliRoots) {
  const all = [...(fileRoots || []), ...(envRoots || '').split(':').filter(Boolean), ...cliRoots];
  return [...new Set(all.map((r) => path.resolve(r)))];
}

function validate(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  if (!(cfg.accelHz > 0 && cfg.accelHz <= 200)) throw new Error(`Invalid accelHz: ${cfg.accelHz}`);
}

export async function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cli = parseArgs(argv);
  const configFile = first(cli.configFile, env.GOPRO_VIEWER_CONFIG, DEFAULTS.configFile);
  const file = await readConfigFile(configFile);
  const cfg = {
    ...DEFAULTS,
    ...file,
    configFile,
    host: first(cli.host, env.GOPRO_VIEWER_HOST, file.host, DEFAULTS.host),
    port: first(cli.port, numberOrUndefined(env.GOPRO_VIEWER_PORT), file.port, DEFAULTS.port),
    cacheDir: first(cli.cacheDir, env.GOPRO_VIEWER_CACHE, file.cacheDir ? path.resolve(file.cacheDir) : DEFAULTS.cacheDir),
    accelHz: first(cli.accelHz, file.accelHz, DEFAULTS.accelHz),
    logLevel: first(cli.logLevel, env.LOG_LEVEL, file.logLevel, DEFAULTS.logLevel),
    roots: mergeRoots(file.roots, env.GOPRO_VIEWER_MEDIA, cli.roots),
    help: !!cli.help,
  };
  validate(cfg);
  return cfg;
}

/** Persist the user-editable subset (roots, port, host, tiles) back to config.json. */
export async function saveConfig(cfg) {
  const out = { host: cfg.host, port: cfg.port, roots: cfg.roots, accelHz: cfg.accelHz, tiles: cfg.tiles };
  await mkdir(path.dirname(cfg.configFile), { recursive: true });
  await writeFile(cfg.configFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
}
