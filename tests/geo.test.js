import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPosition, runsWhere, positionRuns, runStats, haversineM } from '../server/geo.js';
import { computeStats } from '../server/telemetry.js';

/** A 10 Hz GPS stream heading north at 10 m/s; `fix` per sample can be overridden. */
function stream(n, { fix = () => 3, lat = (i) => 24.45 + i * 1e-5, lon = () => 54.6, speed = () => 10, dop = () => 1, alt = () => 10 } = {}) {
  const idx = Array.from({ length: n }, (_, i) => i);
  return {
    n, t: idx.map((i) => i / 10), lat: idx.map(lat), lon: idx.map(lon), alt: idx.map(alt),
    speed2d: idx.map(speed), speed3d: idx.map(speed), fix: idx.map(fix), dop: idx.map(dop), utc: idx.map((i) => i * 100),
  };
}

test('hasPosition needs a reported fix and a coordinate that is finite, in range and off the (0,0) island', () => {
  const gps = { fix: [3, 3, 3, 3, 3, 0, null, 1, 2], lat: [24.45, 0, 91, NaN, null, 24.45, 24.45, 24.45, 24.45], lon: [54.6, 0, 54.6, 54.6, 54.6, 54.6, 54.6, 54.6, 54.6] };
  assert.equal(hasPosition(gps, 0), true);
  assert.equal(hasPosition(gps, 1), false, '(0, 0) is where a searching receiver writes');
  assert.equal(hasPosition(gps, 2), false, 'latitude 91 does not exist');
  assert.equal(hasPosition(gps, 3), false, 'NaN');
  assert.equal(hasPosition(gps, 4), false, 'null');
  assert.equal(hasPosition(gps, 5), false, 'fix 0');
  assert.equal(hasPosition(gps, 6), false, 'no fix reported at all');
  assert.equal(hasPosition(gps, 7), false, 'fix 1 is below 2D');
  assert.equal(hasPosition(gps, 8), true, '2D counts');
  assert.equal(hasPosition(gps, 8, 3), false, 'unless 3D is required');
});

test('runsWhere groups qualifying indices and splits where asked', () => {
  const ok = [1, 1, 0, 1, 1, 1, 0, 0, 1];
  assert.deepEqual(runsWhere(ok.length, (i) => ok[i]), [{ start: 0, end: 1 }, { start: 3, end: 5 }, { start: 8, end: 8 }]);
  assert.deepEqual(runsWhere(ok.length, (i) => ok[i], (i) => i === 4), [{ start: 0, end: 1 }, { start: 3, end: 3 }, { start: 4, end: 5 }, { start: 8, end: 8 }]);
  assert.deepEqual(runsWhere(0, () => true), []);
  assert.deepEqual(runsWhere(3, () => false), []);
});

test('positionRuns ends a run at a lost fix and at a time gap', () => {
  const gps = stream(30, { fix: (i) => (i >= 10 && i < 20 ? 0 : 3) });
  assert.deepEqual(positionRuns(gps), [{ start: 0, end: 9 }, { start: 20, end: 29 }]);
  const gapped = stream(30);
  for (let i = 15; i < 30; i++) gapped.t[i] += 10;   // a 10 s hole between samples 14 and 15
  assert.deepEqual(positionRuns(gapped), [{ start: 0, end: 14 }, { start: 15, end: 29 }]);
  assert.deepEqual(positionRuns(null), []);
});

test('runStats sums distance along a run and takes speeds from the trusted samples only', () => {
  const gps = stream(20, { speed: (i) => (i >= 15 ? 75 : 10) });
  const all = runStats(gps, { start: 0, end: 19 });
  const legM = haversineM(gps.lat[0], gps.lon[0], gps.lat[1], gps.lon[1]);
  assert.ok(Math.abs(all.distanceM - 19 * legM) < 1e-6);
  assert.equal(all.maxSpeedMs, 75, 'without flags every speed counts');
  assert.equal(all.speedPoints, 20);
  const speedOk = gps.t.map((_, i) => (i < 15 ? 1 : 0));
  const trusted = runStats(gps, { start: 0, end: 19 }, { speedOk });
  assert.equal(trusted.maxSpeedMs, 10);
  assert.equal(trusted.avgSpeedMs, 10);
  assert.equal(trusted.speedPoints, 15);
  assert.ok(Math.abs(trusted.distanceM - all.distanceM) < 1e-9, 'distance is unaffected by the speed rule');
  assert.ok(Math.abs(trusted.movingTimeSec - 1.4) < 1e-9, 'moving time counts the legs into trusted samples');
});

test('computeStats never bridges a stretch without a fix: two clusters 50 km apart add up to in-cluster legs only', () => {
  const far = stream(40, {
    fix: (i) => (i >= 10 && i < 30 ? 0 : 3),
    lat: (i) => (i < 30 ? 24.45 + i * 1e-5 : 24.9 + (i - 30) * 1e-5),   // the second cluster sits 50 km north
  });
  const st = computeStats(far);
  const legM = haversineM(24.45, 54.6, 24.45 + 1e-5, 54.6);
  assert.equal(st.validPoints, 20);
  assert.ok(st.distanceM < 30, `distance ${st.distanceM} m is the legs inside the two clusters (${(18 * legM).toFixed(1)} m), not a 50 km chord`);
  assert.ok(Math.abs(st.distanceM - 18 * legM) < 0.05);
});

test('computeStats counts fix qualities and takes elevation figures from 3D fixes only', () => {
  const gps = stream(30, { fix: (i) => [0, 1, 2, 3, 3, 3][i % 6], alt: (i) => (i % 6 === 2 ? 9000 : 10 + i) });
  const st = computeStats(gps);
  assert.deepEqual(st.fixCounts, { none: 10, fix2d: 5, fix3d: 15 }, 'a fix of 1 is no fix, not a 3D one');
  assert.equal(st.validPoints, 20, '2D and 3D samples position the camera');
  assert.ok(st.maxAltM < 100, `the 9 000 m altitude of the 2D samples stays out (max ${st.maxAltM})`);
});
