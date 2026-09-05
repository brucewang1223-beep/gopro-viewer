/**
 * Reverse proxy for the K2 map service (map.lumobility.com), used when `map.provider` is `k2`.
 *
 *   GET /api/map/v2/tiles/<tileset>/<z>/<x>/<y>.<ext>   vector (.pbf) and raster (.jpeg/.png) tiles
 *   GET /api/map/v2/tiles/<tileset>.json                TileJSON
 *   GET /api/map-fonts/<fontstack>/<range>.pbf          glyph ranges (no token needed upstream)
 *
 * The access token lives in config.json and is appended here, so it never reaches
 * the browser and never appears in a committed style file — not even in an error
 * message. Paths are whitelisted: this is a map proxy, not an open one.
 */

import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from './log.js';

const log = createLogger('map');

const TILE_PATH = /^\/v2\/tiles\/[\w-]{1,40}(\/\d{1,2}\/\d{1,7}\/\d{1,7}\.(pbf|png|jpe?g|webp)|\.json)$/;
const GLYPH_PATH = /^\/([^/]{1,120})\/\d{1,6}-\d{1,6}\.pbf$/;
const FONT_NAME = /^[\w -]{1,80}$/;   // "Noto Sans Regular": letters, digits, spaces, hyphens — never a dot, so `..` cannot be smuggled in, encoded or not

/** Whether a glyph request names a font the way a style does. */
function isGlyphPath(p) {
  const m = GLYPH_PATH.exec(p);
  if (!m) return false;
  try { return FONT_NAME.test(decodeURIComponent(m[1])); } catch { return false; }
}
const CACHE_CONTROL = 'public, max-age=604800';  // z/x/y addresses fixed content: a week in the browser cache
const UPSTREAM_TIMEOUT_MS = 15_000;
const ABORTED = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']);

const withToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

/** The same error with every trace of the token removed from its message. */
function withoutSecret(err, secret) {
  if (!secret || !err?.message?.includes(secret)) return err;
  const clean = new Error(err.message.replaceAll(secret, '***'));
  clean.name = err.name;
  return clean;
}

/** Copy an upstream response (status, content type, body) to the client. */
async function forward(url, res) {
  const upstream = await fetch(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const type = upstream.headers.get('content-type');
  res.status(upstream.status);
  if (type) res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', upstream.ok ? CACHE_CONTROL : 'no-store');
  if (!upstream.body) return res.end();
  try {
    return await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (!ABORTED.has(e.code) && e.name !== 'AbortError') throw e;
    return undefined; // the browser cancelled a tile it no longer needs
  }
}

/**
 * Router factory shared by the tile and glyph proxies.
 * @param {(path: string) => boolean} allow  request paths this proxy accepts
 * @param {(path: string) => string|null} target  upstream URL for an accepted path
 * @param {string} [secret]  never allowed into an error message
 */
function proxyRouter(allow, target, secret = '') {
  const router = express.Router();
  router.get(/.*/, (req, res, next) => {
    if (!allow(req.path)) return res.status(400).json({ error: `unsupported map path: ${req.path}` });
    const url = target(req.path);
    if (!url) return res.status(503).json({ error: 'map service is not configured (set map.token in config.json)' });
    return forward(url, res).catch((e) => next(withoutSecret(e, secret)));
  });
  return router;
}

/** Tiles and TileJSON, signed with the configured token (warned about only when the K2 provider is in use). */
export function tileProxy({ api, token, provider = 'k2' }) {
  if (!token && provider === 'k2') log.warn('map.provider is k2 but map.token is not set — the basemap will stay blank until config.json has one');
  return proxyRouter((p) => TILE_PATH.test(p), (p) => (token ? withToken(api + p, token) : null), token);
}

/** Glyph ranges. Served from the style host rather than the API host, and unauthenticated. */
export function fontProxy({ glyphs }) {
  return proxyRouter(isGlyphPath, (p) => `${glyphs}/fonts${p}`);
}
