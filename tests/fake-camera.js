/**
 * A stand-in for the Open GoPro HTTP server of a camera on USB: media list, camera info and
 * card files with Range support, plus counters so tests can see what was requested.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';

/** Media-list entries and card files for a few HERO-style clips. */
export function sampleCard() {
  const files = new Map([
    ['GX010004.MP4', randomBytes(10_000)],
    ['GL010004.LRV', randomBytes(2_000)],
    ['GX010004.THM', randomBytes(500)],
    ['GX010005.MP4', randomBytes(20_000)],     // no LRV, no THM on the card
    ['GOPR0001.JPG', randomBytes(1_000)],
  ]);
  const entry = (n, cre, glrv) => ({ n, s: String(files.get(n).length), cre: String(cre), mod: String(cre), glrv: String(glrv) });
  const list = { media: [{ d: '100GOPRO', fs: [entry('GX010005.MP4', 1788600143, 0), entry('GX010004.MP4', 1788598094, 2000), entry('GOPR0001.JPG', 1788500000, 0)] }] };
  return { files, list };
}

function serveFile(req, res, body, { throttleMs, hits }) {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const from = range ? Number(range[1]) : 0;
  hits.push({ path: req.url, range: req.headers.range ?? null });
  if (from >= body.length) { res.writeHead(416); return res.end(); }
  res.writeHead(range ? 206 : 200, { 'Content-Length': body.length - from, ...(range ? { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
  if (!throttleMs) return res.end(body.subarray(from));
  // dribble the file out so a test can cancel half-way
  let pos = from;
  const tick = () => {
    if (pos >= body.length) return res.end();
    res.write(body.subarray(pos, pos + 1000)); pos += 1000;
    return setTimeout(tick, throttleMs);
  };
  return tick();
}

/** Starts the fake camera; resolves to { url, hits, close(), throttleMs }. */
export async function startFakeCamera({ files, list }, { serial = 'C3531325563165', model = 'HERO13 Black' } = {}) {
  const state = { hits: [], throttleMs: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/gopro/camera/control/wired_usb') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    if (url.pathname === '/gopro/camera/info') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model_name: model, serial_number: serial, firmware_version: 'H24.01.02.10.00' })); }
    if (url.pathname === '/gopro/media/list') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(list)); }
    const m = /^\/videos\/DCIM\/100GOPRO\/([^/]+)$/.exec(url.pathname);
    const body = m && files.get(decodeURIComponent(m[1]));
    if (!body) { res.writeHead(404); return res.end(); }
    return serveFile(req, res, body, state);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits: state.hits,
    setThrottle: (ms) => { state.throttleMs = ms; },
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
