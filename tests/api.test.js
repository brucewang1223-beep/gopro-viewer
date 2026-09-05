import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { FIXTURES } from './helpers.js';
import { sampleCard, startFakeCamera } from './fake-camera.js';

let server; let base; let tmp; let cam;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'gopro-viewer-api-'));
  cam = await startFakeCamera(sampleCard());
  const cfg = {
    host: '127.0.0.1', port: 0, roots: [FIXTURES], cacheDir: path.join(tmp, 'cache'), configFile: path.join(tmp, 'config.json'), accelHz: 25,
    map: { provider: 'osm', api: 'https://map.example/api', glyphs: 'https://map.example/styles', token: '', basemap: 'streets', labels: true },
    ledgerFile: path.join(tmp, 'import-ledger.json'), import: { dest: '', lrv: true, thm: false, camera: cam.url }, logLevel: 'warn',
  };
  const app = createApp(cfg);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await cam.close();
  await rm(tmp, { recursive: true, force: true });
});

const json = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json(), headers: r.headers }; };

test('health and config', async () => {
  const h = await json('/api/health');
  assert.equal(h.status, 200); assert.equal(h.body.ok, true);
  const c = await json('/api/config');
  assert.equal(c.body.roots.length, 1);
  assert.equal(c.body.roots[0].path, FIXTURES);
});

test('library lists recordings without file paths in the chapters', async () => {
  const { status, body } = await json('/api/library');
  assert.equal(status, 200);
  assert.equal(body.recordings.length, 2);
  for (const r of body.recordings) for (const c of r.chapters) assert.ok(!c.path);
  assert.deepEqual(body.roots.map((r) => r.exists), [true]);
});

test('requests addressed to another host name are refused (DNS rebinding), localhost spellings pass', async () => {
  const http = await import('node:http');   // fetch() will not send a foreign Host header; a raw request does
  const statusWithHost = (host) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  for (const host of ['evil.example', 'evil.example:8790', '127.0.0.1.evil.example']) assert.equal(await statusWithHost(host), 403, `Host: ${host}`);
  for (const host of ['localhost', `127.0.0.1:${server.address().port}`, '[::1]:8790', 'LOCALHOST:8790']) assert.equal(await statusWithHost(host), 200, `Host: ${host}`);
});

test('media streaming honours Range requests', async () => {
  const { body } = await json('/api/library');
  const chapter = body.recordings[0].chapters[0];
  const r = await fetch(`${base}/api/media/${chapter.id}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(r.headers.get('content-range'), /^bytes 0-15\/\d+$/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, 16);
  assert.equal(buf.toString('latin1', 4, 8), 'ftyp');
  const full = await fetch(`${base}/api/media/${chapter.id}`, { method: 'HEAD' });
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get('content-length')), chapter.sizeBytes);
});

test('unknown ids and wrong kinds give 404', async () => {
  assert.equal((await json('/api/media/does-not-exist')).status, 404);
  assert.equal((await json('/api/thumb/does-not-exist')).status, 404);
  assert.equal((await json('/api/recordings/nope/telemetry')).status, 404);
  const { body } = await json('/api/library');
  const chapter = body.recordings[0].chapters[0];
  assert.equal((await json(`/api/thumb/${chapter.id}`)).status, 404, 'a video is not a thumbnail');
  assert.equal((await json('/api/nothing')).status, 404);
});

test('telemetry and exports for a two-chapter recording', async () => {
  const { body } = await json('/api/library');
  const rec = body.recordings.find((r) => r.name === 'GX0001');
  const t = await json(`/api/recordings/${rec.id}/telemetry`);
  assert.equal(t.status, 200);
  assert.equal(t.body.chapters.length, 2);
  assert.ok(t.body.gps.n > 150);
  assert.ok(t.body.stats.distanceM > 0);

  const gpx = await fetch(`${base}/api/recordings/${rec.id}/export.gpx`);
  assert.equal(gpx.status, 200);
  assert.match(gpx.headers.get('content-type'), /gpx\+xml/);
  assert.match(gpx.headers.get('content-disposition'), /GX0001\.gpx/);
  const gpxText = await gpx.text();
  assert.ok((gpxText.match(/<trkpt /g) || []).length > 100);

  const geo = await fetch(`${base}/api/recordings/${rec.id}/export.geojson`);
  assert.equal(geo.status, 200);
  assert.match(geo.headers.get('content-type'), /application\/geo\+json/);
  assert.match(geo.headers.get('content-disposition'), /GX0001\.geojson/);
  const fc = JSON.parse(await geo.text());
  assert.equal(fc.type, 'FeatureCollection');
  assert.ok(fc.features.length >= 2, 'the no-fix stretch in the middle of the clip cuts the track in two');
  assert.equal(fc.features[0].geometry.type, 'LineString');
  assert.ok(fc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0) > 100);
  assert.equal(fc.features[0].properties.camera, 'Hero6 Black');

  const csv = await fetch(`${base}/api/recordings/${rec.id}/export.csv?stream=accl`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = (await csv.text()).trim().split('\n');
  assert.equal(lines[0], 't_sec,x_ms2,y_ms2,z_ms2,mag_ms2,magmax_ms2');
  assert.ok(lines.length > 200);
});

test('a file with a non-Latin-1 name streams and exports like any other', async () => {
  const { mkdir, copyFile } = await import('node:fs/promises');
  const dir = path.join(tmp, 'cjk');
  await mkdir(dir, { recursive: true });
  await copyFile(path.join(FIXTURES, 'GX010001.MP4'), path.join(dir, '测试 Fahrt über Brücke 🚗.mp4'));
  const added = await json('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
  assert.equal(added.status, 200);
  const rec = added.body.recordings.find((r) => r.name.startsWith('测试'));
  assert.ok(rec, 'the recording is listed under its file name');
  const media = await fetch(`${base}/api/media/${rec.chapters[0].id}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('x-file-name'), null, 'the name is never a header value');
  const gpx = await fetch(`${base}/api/recordings/${rec.id}/export.gpx`);
  assert.equal(gpx.status, 200);
  assert.match(gpx.headers.get('content-disposition'), /attachment; filename="[^"]*"; filename\*=UTF-8''%E6%B5%8B%E8%AF%95/);
  assert.equal((await json('/api/health')).status, 200, 'and the server is still alive');
  const removed = await json(`/api/roots/${added.body.roots.find((r) => r.path === dir).id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('a folder inside a configured root is not added twice', async () => {
  const { mkdir, copyFile, rm } = await import('node:fs/promises');
  const inside = path.join(tmp, 'outer', 'inner');
  await mkdir(inside, { recursive: true });
  await copyFile(path.join(FIXTURES, 'GH010002.MP4'), path.join(inside, 'GH010009.MP4'));
  const post = (p) => json('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  const outer = await post(path.join(tmp, 'outer'));
  assert.equal(outer.status, 200);
  const before = outer.body.roots.length;
  const again = await post(inside);
  assert.equal(again.status, 200);
  assert.equal(again.body.roots.length, before, 'covered by the outer root: rescanned, not added');
  assert.ok(again.body.recordings.some((r) => r.name === 'GH0009'));
  await json(`/api/roots/${outer.body.roots.find((r) => r.path === path.join(tmp, 'outer')).id}`, { method: 'DELETE' });
  await rm(path.join(tmp, 'outer'), { recursive: true, force: true });
});

test('adding an invalid root is rejected, rescan works', async () => {
  const bad = await json('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/no/such/dir' }) });
  assert.equal(bad.status, 400);
  const empty = await json('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
  const blank = await json('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '   ' }) });
  assert.equal(blank.status, 400, 'a blank path must not resolve to the working directory');
  const rescan = await json('/api/rescan', { method: 'POST' });
  assert.equal(rescan.status, 200);
  assert.equal(rescan.body.recordings.length, 2);
});

test('UI and vendor assets are served', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.ok((await index.text()).includes('GoPro Viewer'));
  for (const p of ['/vendor/maplibre/maplibre-gl.js', '/vendor/maplibre/maplibre-gl.css', '/vendor/uplot/uPlot.iife.min.js', '/vendor/uplot/uPlot.min.css', '/js/app.js', '/style.css', '/styles/k2-streets.json', '/styles/k2-satellite.json']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
});

test('import from the camera: snapshot, job, ledger, destination becomes a media root', async () => {
  const post = (body) => json('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const until = async (check) => { for (let i = 0; i < 200; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  const snap = await json('/api/import');
  assert.equal(snap.status, 200);
  assert.equal(snap.body.camera.model, 'HERO13 Black');
  assert.equal(snap.body.items.length, 3);
  assert.ok(snap.body.items.every((it) => it.imported === null));
  assert.deepEqual(snap.body.defaults, { dest: '', lrv: true, thm: false });
  assert.equal((await json('/api/import/job')).body, null);
  assert.equal((await post({ dest: 'relative', lrv: false, thm: false, keys: ['x'] })).status, 400);
  assert.equal((await post({ dest: tmp, lrv: false, thm: false, keys: [] })).status, 400);
  assert.equal((await json('/api/import/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['x'] }) })).status, 409, 'nothing to delete from yet');

  const dest = path.join(tmp, 'footage');
  const keys = snap.body.items.filter((it) => it.name.endsWith('.MP4')).map((it) => it.key);
  const started = await post({ dest, lrv: false, thm: false, keys });
  assert.equal(started.status, 202);
  assert.equal(started.body.state, 'running');
  assert.equal(started.body.dest, dest);
  assert.ok(await until(async () => (await json('/api/import/job')).body.state !== 'running'), 'the job finishes');
  const job = (await json('/api/import/job')).body;
  assert.equal(job.state, 'done');
  assert.deepEqual(job.items.map((it) => it.status), ['done', 'done']);
  assert.equal(job.doneBytes, 30_000);
  assert.equal((await stat(path.join(dest, '2026-09-05', 'GX010004.MP4'))).size, 10_000);

  assert.ok((await json('/api/config')).body.roots.some((r) => r.path === dest), 'the destination joined the media roots');
  assert.ok(await until(async () => JSON.parse(await readFile(path.join(tmp, 'config.json'), 'utf8')).roots.includes(dest)), 'and config.json says so');
  const saved = JSON.parse(await readFile(path.join(tmp, 'config.json'), 'utf8'));
  assert.deepEqual(saved.import, { dest, lrv: false, thm: false, camera: cam.url });
  assert.equal((await json('/api/config')).body.map.provider, 'osm');
  assert.equal(saved.ledgerFile, path.join(tmp, 'import-ledger.json'), 'a custom ledger path survives a save');
  assert.equal(Object.keys(JSON.parse(await readFile(path.join(tmp, 'import-ledger.json'), 'utf8')).entries).length, 2);

  const again = await json('/api/import');
  assert.ok(again.body.items.filter((it) => it.name.endsWith('.MP4')).every((it) => it.imported?.dest === path.join(dest, '2026-09-05')));
  assert.equal(again.body.items.find((it) => it.name.endsWith('.JPG')).imported, null);
  assert.deepEqual(again.body.defaults, { dest, lrv: false, thm: false });
  assert.deepEqual((await json('/api/import/job', { method: 'DELETE' })).body, { cancelled: false });

  const refused = await json('/api/import/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [again.body.items.find((it) => it.name.endsWith('.JPG')).key] }) });
  assert.equal(refused.status, 400, 'the photo was not part of the import');
  const deleted = await json('/api/import/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.body.items.every((it) => it.deleted === true));
  assert.deepEqual((await json('/api/import')).body.items.map((it) => it.name), ['GOPR0001.JPG'], 'the camera no longer lists the deleted clips');
});
