/**
 * Configuration: defaults ← config.json ← environment ← CLI flags.
 *
 *   CLI    : --media <dir> (repeatable)  --port <n>  --host <ip>  --config <file>  --cache <dir>  --accel-hz <n>  --log-level <lvl>
 *   Env    : GOPRO_VIEWER_MEDIA (":"-separated), GOPRO_VIEWER_PORT, GOPRO_VIEWER_HOST, GOPRO_VIEWER_CACHE, GOPRO_VIEWER_CONFIG, LOG_LEVEL
 *   File   : config.json in the project root (see config.example.json). Roots added from the UI and the
 *            last import destination / sidecar choices are persisted here; `ledgerFile`, `import.camera`
 *            and `map.provider` are file-only. Saving writes those keys back into the file's own content:
 *            a one-off `--host 0.0.0.0` or `--port` never becomes permanent, and unknown keys survive.
 *
 * The K2 map credentials live in the "map" block of config.json only (never in the
 * environment, never in a committed file): config.json is git-ignored.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './fs-util.js';
import { LOG_LEVELS } from './log.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Basemaps offered by the UI; the matching style lives in web/styles/<provider>-<name>.json. */
const BASEMAPS = ['streets', 'satellite'];
/** Where the basemaps come from: OpenStreetMap data (OpenFreeMap vector tiles + Esri imagery) or the K2 map service. */
export const MAP_PROVIDERS = ['osm', 'k2'];

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8790,
  roots: [],
  accelHz: 25,
  map: {
    provider: 'osm', // osm (OpenFreeMap tiles + Esri imagery, no key) | k2 (map.lumobility.com, needs `token`)
    api: 'https://map.lumobility.com/api',
    glyphs: 'https://map.lumobility.com/map-styles',
    token: '',
    basemap: 'streets',
    labels: true,
  },
  import: {
    dest: '',        // last destination chosen in the import dialog (pre-filled next time)
    lrv: true,       // copy each clip's LRV proxy (last choice in the dialog)
    thm: false,      // copy each clip's THM thumbnail (last choice in the dialog)
    camera: '',      // camera base URL override, e.g. http://172.21.165.51:8080; empty = find it on the USB network
  },
  cacheDir: path.join(PROJECT_ROOT, '.cache'),
  configFile: path.join(PROJECT_ROOT, 'config.json'),
  ledgerFile: path.join(PROJECT_ROOT, 'import-ledger.json'),   // outside .cache/: deleting the cache must not forget imports
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

/* ---------- command line ---------- */

/** Options that take a value: how each one lands in the parsed result. */
const VALUE_OPTIONS = {
  '--media': (out, v) => out.roots.push(v),
  '--port': (out, v) => { out.port = Number(v); },
  '--host': (out, v) => { out.host = v; },
  '--config': (out, v) => { out.configFile = path.resolve(v); },
  '--cache': (out, v) => { out.cacheDir = path.resolve(v); },
  '--accel-hz': (out, v) => { out.accelHz = Number(v); },
  '--log-level': (out, v) => { out.logLevel = v; },
};
const ALIASES = { '-m': '--media', '-p': '--port', '-c': '--config', '-h': '--help' };

function parseArgs(argv) {
  const out = { roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = ALIASES[argv[i]] ?? argv[i];
    if (a === '--help') { out.help = true; continue; }
    const apply = VALUE_OPTIONS[a];
    if (apply) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      apply(out, argv[++i]);
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      out.roots.push(a); // bare positional = media root
    }
  }
  return out;
}

/* ---------- file ---------- */

async function readConfigFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed;
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
  const all = [...(Array.isArray(fileRoots) ? fileRoots : []), ...(envRoots || '').split(':').filter(Boolean), ...cliRoots];
  return [...new Set(all.map((r) => path.resolve(String(r))))];
}

/** The import block, known keys only (an older config.json may still carry `mode`; a null block is an empty one). */
function importSettings(file) {
  const block = file && typeof file === 'object' ? file : {};
  const pick = (key) => block[key] ?? DEFAULTS.import[key];
  return { dest: pick('dest'), lrv: pick('lrv'), thm: pick('thm'), camera: pick('camera') };
}

const isHttpUrl = (s) => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

function validateServer(cfg) {
  if (typeof cfg.host !== 'string' || !cfg.host.trim()) throw new Error('host must be a non-empty address');
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  if (!(cfg.accelHz > 0 && cfg.accelHz <= 200)) throw new Error(`Invalid accelHz: ${cfg.accelHz}`);
  if (!LOG_LEVELS.includes(String(cfg.logLevel).toLowerCase())) throw new Error(`Invalid logLevel: ${cfg.logLevel} (expected ${LOG_LEVELS.join(' | ')})`);
}

function validateFeatures({ map, import: imp }) {
  if (!BASEMAPS.includes(map.basemap)) throw new Error(`Invalid map.basemap: ${map.basemap} (expected ${BASEMAPS.join(' | ')})`);
  if (!MAP_PROVIDERS.includes(map.provider)) throw new Error(`Invalid map.provider: ${map.provider} (expected ${MAP_PROVIDERS.join(' | ')})`);
  if (!isHttpUrl(map.api) || !isHttpUrl(map.glyphs)) throw new Error('map.api and map.glyphs must be http(s) URLs');
  if (typeof imp.lrv !== 'boolean' || typeof imp.thm !== 'boolean') throw new Error('import.lrv and import.thm must be true or false');
}

function validate(cfg) {
  validateServer(cfg);
  validateFeatures(cfg);
}

export async function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cli = parseArgs(argv);
  const configFile = first(cli.configFile, env.GOPRO_VIEWER_CONFIG, DEFAULTS.configFile);
  const file = await readConfigFile(configFile);
  const cfg = {
    ...DEFAULTS,
    ...file,
    file,          // the file's own content, the base every save is written onto
    configFile,
    host: first(cli.host, env.GOPRO_VIEWER_HOST, file.host, DEFAULTS.host),
    port: first(cli.port, numberOrUndefined(env.GOPRO_VIEWER_PORT), file.port, DEFAULTS.port),
    cacheDir: first(cli.cacheDir, env.GOPRO_VIEWER_CACHE, file.cacheDir ? path.resolve(file.cacheDir) : DEFAULTS.cacheDir),
    ledgerFile: file.ledgerFile ? path.resolve(file.ledgerFile) : DEFAULTS.ledgerFile,
    accelHz: first(cli.accelHz, file.accelHz, DEFAULTS.accelHz),
    logLevel: first(cli.logLevel, env.LOG_LEVEL, file.logLevel, DEFAULTS.logLevel),
    map: { ...DEFAULTS.map, ...(file.map && typeof file.map === 'object' ? file.map : {}) },
    import: importSettings(file.import),
    roots: mergeRoots(file.roots, env.GOPRO_VIEWER_MEDIA, cli.roots),
    help: !!cli.help,
  };
  validate(cfg);
  return cfg;
}

/**
 * Persist what the UI edits — the media roots and the import choices — onto the file's own
 * content, atomically. Values that came from the command line or the environment are not
 * written; a custom ledger path is kept.
 */
export async function saveConfig(cfg) {
  const base = cfg.file && typeof cfg.file === 'object' ? cfg.file : {};
  const ledger = cfg.ledgerFile !== DEFAULTS.ledgerFile ? { ledgerFile: cfg.ledgerFile } : {};
  const out = { ...base, roots: cfg.roots, import: cfg.import, ...ledger };
  await writeJsonAtomic(cfg.configFile, out, { pretty: true });
  cfg.file = out;
}
