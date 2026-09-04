import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseChapter, mergeChapters, computeStats, normalizeTelemetry, TelemetryService, SCHEMA } from '../server/telemetry.js';
import { telemetryOptions } from '../server/decode.js';
import { readStreamOrientations, cameraFrameMapping, parseHeaderSettings } from '../server/gpmf-klv.js';
import { Library } from '../server/library.js';
import { FIX, FIXTURES, withTempDir } from './helpers.js';

const require = createRequire(import.meta.url);
const goproTelemetry = require('gopro-telemetry');

function assertMonotonic(arr, label) {
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i] >= arr[i - 1], `${label} not monotonic at ${i}: ${arr[i - 1]} → ${arr[i]}`);
}

test('parseChapter normalises GPS5 + IMU from a Hero6 chapter', async () => {
  const c = await parseChapter(FIX.gx01, { accelHz: 25 });
  assert.equal(c.schema, SCHEMA);
  assert.equal(c.camera.model, 'Hero6 Black');
  assert.equal(c.gps.source, 'GPS5');
  assert.ok(c.gps.n >= 80 && c.gps.n <= 100, `gps points ${c.gps.n}`);
  assert.ok(Math.abs(c.gps.hz - 18) < 1.5, `gps hz ${c.gps.hz}`);
  assertMonotonic(c.gps.t, 'gps.t');
  assert.ok(c.gps.t[0] >= 0 && c.gps.t[c.gps.n - 1] <= c.durationSec + 0.5);
  assert.ok(Math.abs(c.gps.lat[0] - 33.1265) < 0.01 && Math.abs(c.gps.lon[0] + 117.3272) < 0.01, 'plausible coordinates');
  assert.equal(c.gps.fix[0], 3);
  assert.ok(c.gps.dop[0] > 0 && c.gps.dop[0] < 50);
  assert.ok(c.gps.utc[0] > Date.UTC(2018, 0, 1));
  assert.equal(c.accl.hz, 25);
  assert.ok(c.accl.n >= 100 && c.accl.n <= 130, `accl bins ${c.accl.n}`);
  assertMonotonic(c.accl.t, 'accl.t');
  // resting camera: |a| ≈ 1 g
  const meanMag = c.accl.mag.reduce((a, b) => a + b, 0) / c.accl.n;
  assert.ok(meanMag > 8 && meanMag < 13, `mean |a| ${meanMag}`);
  assert.ok(c.accl.magMax.every((v, i) => v >= c.accl.mag[i] - 1e-9));
  assert.ok(c.gyro && c.gyro.n > 100);
  // camera frame: gravity reaction shows up on +z (up) for an upright camera
  assert.equal(c.accl.frame, 'camera');
  const meanZ = c.accl.z.reduce((a, b) => a + b, 0) / c.accl.n;
  assert.ok(meanZ > 7, `mean z ${meanZ} should be ≈ +9.8 (camera frame, z up)`);
  assert.deepEqual(c.warnings, []);
});

test('parseChapter keeps no-fix GPS samples and flags them (HERO8 clip)', async () => {
  const c = await parseChapter(FIX.gh01);
  assert.equal(c.camera.model, 'HERO8 Black');
  assert.ok(c.gps.n > 50);
  assert.ok(c.gps.fix.every((f) => f === 0));
  const stats = computeStats(c.gps);
  assert.equal(stats.validPoints, 0);
  assert.equal(stats.distanceM, 0);
  assert.equal(stats.fixCounts.none, c.gps.n);
});

test('computeStats ignores speeds whose fix geometry is too weak', () => {
  // sample 2 keeps a 2D fix but reports 75 m/s at DOP 3.65 — the car-park artefact
  const gps = {
    n: 4, t: [0, 1, 2, 3],
    lat: [24.45, 24.4501, 24.4502, 24.4503], lon: [54.6, 54.6, 54.6, 54.6], alt: [10, 10, 10, 10],
    speed2d: [10, 12, 75, 11], speed3d: [10, 12, 75, 11],
    fix: [3, 3, 2, 3], dop: [1, 1.5, 3.65, 2], utc: [0, 1000, 2000, 3000],
  };
  const st = computeStats(gps);
  assert.equal(st.validPoints, 4, 'all four still position the camera');
  assert.equal(st.speedPoints, 3, 'but only three carry a usable speed');
  assert.equal(st.maxSpeedMs, 12);
  assert.equal(st.avgSpeedMs, 11);
  assert.equal(st.movingTimeSec, 2, 'the untrusted leg adds no moving time');
  assert.ok(st.distanceM > 0, 'distance still counts every positioned sample');
});

test('normalizeTelemetry prefers GPS9 (HERO11 raw sample)', async () => {
  const rawData = await readFile(require.resolve('gopro-telemetry/samples/hero11.raw'));
  const tel = await goproTelemetry({ rawData }, telemetryOptions());
  const n = normalizeTelemetry(tel, { accelHz: 25 });
  assert.equal(n.model, 'HERO11 Black');
  assert.equal(n.gps.source, 'GPS9');
  assert.ok(n.gps.n > 50);
  assert.equal(n.gps.fix[0], 3);
  assert.ok(n.gps.dop[0] > 0 && n.gps.dop[0] < 10, `GPS9 DOP is unscaled: ${n.gps.dop[0]}`);
  assert.ok(Math.abs(n.gps.lat[0] - 42.4261) < 0.01);
  assert.equal(n.gps.altitudeSystem, 'MSLV');
  assert.ok(n.accl.n > 100);
  // HERO11 carries ORIN "ZXY" only: values stay in raw order, mapped to the camera frame
  const orientations = readStreamOrientations(rawData);
  assert.equal(orientations.ACCL.orin, 'ZXY');
  assert.equal(orientations.ACCL.orio, null);
  const n2 = normalizeTelemetry(tel, { accelHz: 25, orientations });
  assert.equal(n2.accl.orientation.source, 'ORIN');
  const meanZ = n2.accl.z.reduce((a, b) => a + b, 0) / n2.accl.n;
  assert.ok(meanZ > 7, `mean z ${meanZ}`);
});

/** Tiny KLV encoder for header tests: key, type char, payload Buffer, element size / repeat. */
function klv(key, type, payload, size = payload.length, repeat = 1) {
  const padded = (payload.length + 3) & ~3;
  const buf = Buffer.alloc(8 + padded);
  buf.write(key, 0, 'latin1'); buf.write(type, 4, 'latin1'); buf.writeUInt8(size, 5); buf.writeUInt16BE(repeat, 6);
  payload.copy(buf, 8);
  return buf;
}
const str = (key, text) => klv(key, 'c', Buffer.from(text, 'latin1'), 1, text.length);
const container = (key, children) => { const body = Buffer.concat(children); return klv(key, '\0', body, 1, body.length); };

test('parseHeaderSettings reads HyperSmooth, FOV and time zone (flat and STRM-nested layouts)', () => {
  const dvid = Buffer.alloc(4); dvid.writeUInt32BE(1);
  const tz = Buffer.alloc(2); tz.writeInt16BE(240);
  const vres = Buffer.alloc(8); vres.writeUInt32BE(1920, 0); vres.writeUInt32BE(1080, 4);
  const flat = container('DEVC', [klv('DVID', 'L', dvid), str('DVNM', 'Global Settings'), str('MINF', 'HERO13 Black'), str('EISE', 'Y'), str('EISA', 'HS Boost'), str('HCTL', 'Level'), str('VFOV', 'L'), str('PRTN', 'Y'), str('PTCL', 'NATURAL'), klv('TZON', 's', tz, 2, 1), klv('VRES', 'L', vres, 4, 2)]);
  const s = parseHeaderSettings(flat).summary;
  assert.equal(s.model, 'HERO13 Black');
  assert.deepEqual(s.stabilization, { enabled: true, mode: 'HS Boost' });
  assert.equal(s.horizonControl, 'Horizon Leveling');
  assert.equal(s.fov.name, 'Linear');
  assert.equal(s.tzMinutes, 240);
  assert.deepEqual(s.resolution, { width: 1920, height: 1080 });
  // HERO6/7 style: settings inside a STRM, stabilisation off
  const nested = container('DEVC', [klv('DVID', 'L', dvid), str('DVNM', 'Video Global Settings'), container('STRM', [str('MINF', 'HERO6 Black'), str('EISE', 'N'), str('EISA', 'N'), str('VFOV', 'W')])]);
  const n = parseHeaderSettings(nested).summary;
  assert.equal(n.model, 'HERO6 Black');
  assert.deepEqual(n.stabilization, { enabled: false, mode: null });
  assert.equal(n.fov.name, 'Wide');
  assert.equal(parseHeaderSettings(null), null);
  assert.equal(parseHeaderSettings(Buffer.alloc(0)), null);
  // Fusion-style header: a DEVC with calibration data only → raw keys but no settings summary
  const calibration = container('DEVC', [klv('DVID', 'L', dvid), str('DVNM', 'Geometry Calibrations'), klv('CALW', 'L', dvid)]);
  assert.equal(parseHeaderSettings(calibration).summary, null);
  assert.equal(parseHeaderSettings(calibration).raw.DVNM, 'Geometry Calibrations');
});

test('cameraFrameMapping honours ORIO, ORIN and the ZXY default with signs', () => {
  const withOrio = cameraFrameMapping({ orin: 'YxZ', orio: 'ZXY' });
  assert.equal(withOrio.source, 'ORIO');
  assert.deepEqual(withOrio.map, [{ axis: 'z', index: 0, sign: 1 }, { axis: 'x', index: 1, sign: 1 }, { axis: 'y', index: 2, sign: 1 }]);
  const onlyOrin = cameraFrameMapping({ orin: 'YxZ' });
  assert.equal(onlyOrin.source, 'ORIN');
  assert.deepEqual(onlyOrin.map, [{ axis: 'y', index: 0, sign: 1 }, { axis: 'x', index: 1, sign: -1 }, { axis: 'z', index: 2, sign: 1 }]);
  assert.equal(cameraFrameMapping({}).order, 'ZXY');
  assert.equal(cameraFrameMapping({ orin: 'AB?' }).source, 'default');
});

test('mergeChapters offsets chapter 2 and computes stats', async () => {
  await withTempDir(async (cache) => {
    const lib = new Library({ roots: [FIXTURES], cacheDir: cache });
    const { recordings } = await lib.scan();
    const rec = lib.getRecording(recordings.find((r) => r.name === 'GX0001').id);
    const svc = new TelemetryService({ cacheDir: cache, accelHz: 25 });
    const t0 = Date.now();
    const merged = await svc.recordingTelemetry(rec);
    const firstMs = Date.now() - t0;
    assert.equal(merged.recordingId, rec.id);
    assert.equal(merged.chapters.length, 2);
    assert.equal(merged.gps.source, 'GPS5');
    assertMonotonic(merged.gps.t, 'merged gps.t');
    const c1 = merged.chapters[0]; const c2 = merged.chapters[1];
    assert.equal(merged.gps.n, c1.gpsPoints + c2.gpsPoints);
    const firstOfSecond = merged.gps.t[c1.gpsPoints];
    assert.ok(firstOfSecond >= c2.offsetSec - 1e-6, `chapter 2 starts at ${firstOfSecond}, offset ${c2.offsetSec}`);
    assert.ok(merged.stats.validPoints > 100);
    assert.ok(merged.stats.distanceM > 0);
    assert.ok(merged.stats.maxSpeedMs >= merged.stats.avgSpeedMs);
    assert.ok(merged.utcOffsetMs > Date.UTC(2018, 0, 1));
    assert.equal(merged.video.durationSec, rec.durationSec);
    // cached second call is much faster and identical
    const t1 = Date.now();
    const again = await svc.recordingTelemetry(rec);
    const secondMs = Date.now() - t1;
    assert.deepEqual(again.gps.t, merged.gps.t);
    assert.ok(secondMs <= Math.max(50, firstMs), `cache hit took ${secondMs} ms vs ${firstMs} ms`);
  });
});

test('mergeChapters with a chapter lacking telemetry keeps warnings', () => {
  const rec = { id: 'r', name: 'X', chapters: [{ id: 'a', file: 'a.MP4', index: 0, offsetSec: 0, durationSec: 10 }], durationSec: 10, startTime: null };
  const merged = mergeChapters(rec, [{ chapter: rec.chapters[0], data: { gps: null, accl: null, gyro: null, warnings: ['no GPMF track in file'], camera: {} } }]);
  assert.equal(merged.gps, null);
  assert.deepEqual(merged.warnings, ['a.MP4: no GPMF track in file']);
  assert.equal(merged.stats.validPoints, 0);
});
