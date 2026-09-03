import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tileProxy, fontProxy } from '../server/map.js';

const MAP = { api: 'https://map.example/api', glyphs: 'https://map.example/styles', token: 's3cret' };

let calls;
const realFetch = globalThis.fetch;
const get = (url) => realFetch(url); // the tests talk to the proxy with the real fetch, not the stub

/** Record every upstream URL and answer with a tiny body. */
function stubFetch(status = 200, type = 'application/x-protobuf') {
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(status === 204 ? null : 'tile', { status, headers: { 'content-type': type } });
  };
}

async function serve(map = MAP) {
  const app = express();
  app.use('/api/map', tileProxy(map));
  app.use('/api/map-fonts', fontProxy(map));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let ctx;
beforeEach(async () => { calls = []; stubFetch(); ctx = await serve(); });
afterEach(async () => { globalThis.fetch = realFetch; await new Promise((r) => ctx.server.close(r)); });

test('tile requests are signed with the configured token', async () => {
  const res = await get(`${ctx.base}/api/map/v2/tiles/UAE-Vector/14/10677/7047.pbf`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'tile');
  assert.equal(calls[0], 'https://map.example/api/v2/tiles/UAE-Vector/14/10677/7047.pbf?token=s3cret');
  assert.match(res.headers.get('cache-control'), /max-age=604800/);
});

test('TileJSON is proxied too', async () => {
  await get(`${ctx.base}/api/map/v2/tiles/UAE-Satellite.json`);
  assert.equal(calls[0], 'https://map.example/api/v2/tiles/UAE-Satellite.json?token=s3cret');
});

test('glyph ranges go to the style host without a token', async () => {
  await get(`${ctx.base}/api/map-fonts/Noto%20Sans%20Regular/0-255.pbf`);
  assert.equal(calls[0], 'https://map.example/styles/fonts/Noto%20Sans%20Regular/0-255.pbf');
});

test('paths outside the tile and glyph shapes are refused, never forwarded', async () => {
  const refused = ['/api/map/v2/search?q=abu', '/api/map/%2e%2e/%2e%2e/etc/passwd', '/api/map/v2/tiles/UAE-Vector/14/10677/7047.exe', '/api/map-fonts/%2e%2e/secret.pbf'];
  for (const p of refused) assert.notEqual((await get(ctx.base + p)).status, 200, p);
  assert.deepEqual(calls, []);
});

test('an upstream miss is passed through and not cached', async () => {
  stubFetch(404, 'text/plain');
  const res = await get(`${ctx.base}/api/map/v2/tiles/UAE-Satellite/19/1/1.jpeg`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('without a token the proxy reports the misconfiguration instead of calling upstream', async () => {
  await new Promise((r) => ctx.server.close(r));
  ctx = await serve({ ...MAP, token: '' });
  const res = await get(`${ctx.base}/api/map/v2/tiles/UAE-Vector/14/10677/7047.pbf`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not configured/);
  assert.deepEqual(calls, []);
});
