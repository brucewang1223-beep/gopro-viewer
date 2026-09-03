/**
 * Express application factory (used by index.js and by tests).
 *
 * Routes
 *   GET  /api/health
 *   GET  /api/config                       roots, port, cache dir, tiles preference
 *   POST /api/roots        {path}          add a media root (persisted to config.json) and rescan
 *   DELETE /api/roots/:id                  remove a root and rescan
 *   POST /api/rescan
 *   GET  /api/library                      recordings with chapters (ids only, no absolute paths)
 *   GET  /api/media/:fileId                video bytes with HTTP Range support (MP4 / LRV)
 *   GET  /api/thumb/:fileId                THM/JPEG thumbnail
 *   GET  /api/recordings/:id/telemetry     merged, normalised telemetry JSON
 *   GET  /api/recordings/:id/export.gpx
 *   GET  /api/recordings/:id/export.geojson    driven route as a FeatureCollection of LineStrings
 *   GET  /api/recordings/:id/export.csv?stream=gps|accl|gyro
 *   /  , /vendor/leaflet/*, /vendor/uplot/*   static UI + vendored libraries from node_modules
 */

import express from 'express';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PROJECT_ROOT, saveConfig } from './config.js';
import { Library } from './library.js';
import { TelemetryService } from './telemetry.js';
import { toGpx, toCsv, toGeoJson } from './export.js';
import { shortId } from './ids.js';
import { createLogger } from './log.js';

const require = createRequire(import.meta.url);
const log = createLogger('http');

const MIME = { '.mp4': 'video/mp4', '.lrv': 'video/mp4', '.mov': 'video/quicktime', '.thm': 'image/jpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const CSV_STREAMS = ['gps', 'accl', 'gyro'];

const vendorDir = (pkg) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist');
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- middleware ---------- */

function requestLogger(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path.startsWith('/api/media/') && res.statusCode === 206) return; // range chatter
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    log.debug(`${req.method} ${req.originalUrl} → ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}

function apiNotFound(req, res) {
  res.status(404).json({ error: `no route ${req.method} ${req.originalUrl}` });
}

// Express recognises error handlers by their arity: the fourth parameter must stay.
function errorHandler(err, req, res, _next) {
  log.error(`${req.method} ${req.originalUrl} failed`, err);
  if (res.headersSent) return;
  res.status(err.status ?? 500).json({ error: err.message ?? 'internal error', type: err.name });
}

/* ---------- routes ---------- */

/** Absolute path of an existing directory, or the reason it was rejected. */
async function resolveDirectory(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return { error: 'path is required' };
  const dir = path.resolve(trimmed);
  try {
    if (!(await stat(dir)).isDirectory()) return { error: `not a directory: ${dir}` };
  } catch {
    return { error: `directory not found: ${dir}` };
  }
  return { path: dir };
}

function libraryRoutes(router, { cfg, library }) {
  const setRoots = async (roots) => {
    cfg.roots = roots;
    library.roots = roots;
    try { await saveConfig(cfg); } catch (e) { log.warn(`config not saved: ${e.message}`); }
  };

  router.get('/health', (req, res) => res.json({ ok: true, name: 'gopro-viewer', node: process.version, scannedAt: library.scannedAt }));
  router.get('/config', (req, res) => {
    const { host, port, cacheDir, accelHz, tiles } = cfg;
    res.json({ host, port, cacheDir, accelHz, tiles, roots: library.rootRecords() });
  });
  router.post('/roots', asyncRoute(async (req, res) => {
    const dir = await resolveDirectory(req.body?.path);
    if (dir.error) return res.status(400).json({ error: dir.error });
    if (!cfg.roots.includes(dir.path)) await setRoots([...cfg.roots, dir.path]);
    return res.json(await library.scan());
  }));
  router.delete('/roots/:id', asyncRoute(async (req, res) => {
    const roots = cfg.roots.filter((root) => shortId('root', root) !== req.params.id);
    if (roots.length === cfg.roots.length) return res.status(404).json({ error: 'root not found' });
    await setRoots(roots);
    return res.json(await library.scan());
  }));
  router.post('/rescan', asyncRoute(async (req, res) => res.json(await library.scan())));
  router.get('/library', asyncRoute(async (req, res) => {
    if (!library.scannedAt) await library.scan();
    res.json(library.toJSON());
  }));
}

function mediaRoutes(router, { library }) {
  const sendFile = (kinds) => (req, res) => {
    const file = library.getFile(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'unknown file id' });
    const kind = file.parsed?.kind ?? (MIME[file.ext]?.startsWith('video') ? 'video' : 'other');
    if (!kinds.includes(kind)) return res.status(404).json({ error: 'not a media file of the requested kind' });
    const headers = { 'Content-Type': MIME[file.ext] ?? 'application/octet-stream', 'X-File-Name': file.name };
    return res.sendFile(file.path, { acceptRanges: true, cacheControl: true, maxAge: '1h', lastModified: true, headers }, (err) => {
      if (err && !res.headersSent) res.status(err.status ?? 500).json({ error: err.message });
    });
  };
  router.get('/media/:fileId', sendFile(['video', 'proxy']));
  router.get('/thumb/:fileId', sendFile(['thumb']));
}

function telemetryRoutes(router, { library, telemetry }) {
  /** Runs `handler(req, res, rec)` for a known recording id, 404 otherwise. */
  const withRecording = (handler) => asyncRoute(async (req, res) => {
    const rec = library.getRecording(req.params.id);
    if (!rec) return res.status(404).json({ error: 'unknown recording id' });
    return handler(req, res, rec);
  });

  router.get('/recordings/:id/telemetry', withRecording(async (req, res, rec) => {
    const t0 = Date.now();
    const tel = await telemetry.recordingTelemetry(rec);
    log.info(`telemetry ${rec.name}: gps=${tel.gps?.n ?? 0} chapters=${rec.chapters.length} ${Date.now() - t0} ms`);
    res.setHeader('Cache-Control', 'no-cache');
    res.json(tel);
  }));
  router.get('/recordings/:id/export.gpx', withRecording(async (req, res, rec) => {
    res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rec.name}.gpx"`);
    res.send(toGpx(await telemetry.recordingTelemetry(rec)));
  }));
  router.get('/recordings/:id/export.geojson', withRecording(async (req, res, rec) => {
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rec.name}.geojson"`);
    res.send(toGeoJson(await telemetry.recordingTelemetry(rec)));
  }));
  router.get('/recordings/:id/export.csv', withRecording(async (req, res, rec) => {
    const stream = CSV_STREAMS.includes(req.query.stream) ? req.query.stream : 'gps';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rec.name}_${stream}.csv"`);
    res.send(toCsv(await telemetry.recordingTelemetry(rec), stream));
  }));
}

/* ---------- app ---------- */

export function createApp(cfg) {
  const app = express();
  const library = new Library({ roots: cfg.roots, cacheDir: cfg.cacheDir });
  const telemetry = new TelemetryService({ cacheDir: cfg.cacheDir, accelHz: cfg.accelHz });
  Object.assign(app.locals, { library, telemetry, config: cfg });

  const api = express.Router();
  libraryRoutes(api, { cfg, library });
  mediaRoutes(api, { library });
  telemetryRoutes(api, { library, telemetry });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(requestLogger);
  app.use('/api', api);
  app.use('/vendor/leaflet', express.static(vendorDir('leaflet'), { maxAge: '7d' }));
  app.use('/vendor/uplot', express.static(vendorDir('uplot'), { maxAge: '7d' }));
  // UI files: always revalidate so a plain reload picks up updates (vendor libs above stay cached).
  app.use(express.static(path.join(PROJECT_ROOT, 'web'), { etag: true, lastModified: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use('/api', apiNotFound);
  app.use(errorHandler);
  return app;
}
