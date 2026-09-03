/**
 * Reverse proxy for the K2 map service (map.lumobility.com).
 *
 *   GET /api/map/v2/tiles/<tileset>/<z>/<x>/<y>.<ext>   vector (.pbf) and raster (.jpeg/.png) tiles
 *   GET /api/map/v2/tiles/<tileset>.json                TileJSON
 *   GET /api/map-fonts/<fontstack>/<range>.pbf          glyph ranges (no token needed upstream)
 *
 * The access token lives in config.json and is appended here, so it never reaches
 * the browser and never appears in a committed style file. Paths are whitelisted:
 * this is a map proxy, not an open one.
 */

import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from './log.js';

const log = createLogger('map');

const TILE_PATH = /^\/v2\/tiles\/[\w-]{1,40}(\/\d{1,2}\/\d{1,7}\/\d{1,7}\.(pbf|png|jpe?g|webp)|\.json)$/;
const GLYPH_PATH = /^\/[\w%.-]{1,80}\/\d{1,6}-\d{1,6}\.pbf$/;
const TILE_CACHE = 'public, max-age=604800';  // z/x/y addresses fixed content: a week in the browser cache
const ABORTED = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']);

const withToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

/** Copy an upstream response (status, content type, body) to the client. */
async function forward(url, res) {
  const upstream = await fetch(url, { headers: { accept: '*/*' } });
  const type = upstream.headers.get('content-type');
  res.status(upstream.status);
  if (type) res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', upstream.ok ? TILE_CACHE : 'no-store');
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
 * @param {RegExp} allow  request paths this proxy accepts
 * @param {(path: string) => string|null} target  upstream URL for an accepted path
 */
function proxyRouter(allow, target) {
  const router = express.Router();
  router.get(/.*/, (req, res, next) => {
    if (!allow.test(req.path)) return res.status(400).json({ error: `unsupported map path: ${req.path}` });
    const url = target(req.path);
    if (!url) return res.status(503).json({ error: 'map service is not configured (set map.token in config.json)' });
    return forward(url, res).catch(next);
  });
  return router;
}

/** Tiles and TileJSON, signed with the configured token. */
export function tileProxy({ api, token }) {
  if (!token) log.warn('map.token is not set — the basemap will stay blank until config.json has one');
  return proxyRouter(TILE_PATH, (p) => (token ? withToken(api + p, token) : null));
}

/** Glyph ranges. Served from the style host rather than the API host, and unauthenticated. */
export function fontProxy({ glyphs }) {
  return proxyRouter(GLYPH_PATH, (p) => `${glyphs}/fonts${p}`);
}
