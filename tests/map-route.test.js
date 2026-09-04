import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../web/js/track.js';
import { buildRoute, fractionAlong, gradientExpression, spliceRamps, runGradient, ROUTE } from '../web/js/map-route.js';

/** Minimal telemetry: points are [t, lat, lon, speed, fix, dop] — a 3D lock at DOP 1 by default. */
function track(points) {
  const col = (k) => points.map((p) => p[k]);
  const gps = {
    n: points.length,
    t: col(0), lat: col(1), lon: col(2), speed2d: col(3),
    speed3d: col(3), alt: points.map(() => 10), fix: points.map((p) => (p.length > 4 ? p[4] : 3)),
    dop: points.map((p) => (p.length > 5 ? p[5] : 1)), utc: points.map(() => null),
  };
  return new Track({ gps, video: { durationSec: points.at(-1)[0] } });
}

/** A straight eastward line of `n` points, one second apart. */
const straight = (n, speed = 10, t0 = 0) => Array.from({ length: n }, (_, i) => [t0 + i, 24.45, 54.6 + i * 0.001, speed]);

const stopsOf = (expr) => expr.slice(3).reduce((out, v, i, all) => (i % 2 ? [...out, [all[i - 1], v]] : out), []);

test('runs are split on GPS gaps and lone fixes are dropped', () => {
  // 4 points, a 30 s hole, 3 more points, then a single stray fix far later
  const route = buildRoute(track([...straight(4), ...straight(3, 10, 40), [200, 24.5, 54.7, 0]]));
  assert.equal(route.runs.length, 2);
  assert.deepEqual(route.runs.map((r) => r.coordinates.length), [4, 3]);
  assert.equal(route.geojson.features.length, 2);
  assert.deepEqual(route.geojson.features[1].properties, { run: 1 });
  assert.equal(route.runOf[7], -1, 'the stray fix belongs to no run');
  assert.equal(route.prevDrawn[7], 6, 'progress falls back to the last drawn point');
});

test('a weak fix keeps its place on the map but not its speed', () => {
  // one sample carries a fixed position with hopeless geometry and an absurd speed
  const points = straight(6).map((p, i) => (i === 3 ? [p[0], p[1], p[2], 75, 2, 8] : p));
  const t = track(points);
  assert.equal(t.valid[3], true, 'a 2D fix still positions the camera');
  assert.equal(t.precise[3], false, 'but DOP 8 is too weak for a speed reading');
  assert.equal(t.sampleAt(3).speed2d, null, 'the readout has nothing to show');
  assert.equal(t.sampleAt(2).speed2d, 10, 'neighbouring samples are untouched');
  assert.equal(buildRoute(t).runs.length, 1, 'and the route is still one unbroken run');
});

test('a stream that reports no DOP keeps its speed', () => {
  const t = track(straight(4).map((p) => [...p, 3, null]));
  assert.deepEqual(t.precise, [true, true, true, true]);
  assert.equal(t.sampleAt(1).speed2d, 10);
});

test('a lost fix ends the run: nothing is drawn across an unpositioned stretch', () => {
  // 3 fixed points, 2 without a lock, then 3 more — a straight line must not bridge the hole
  const points = straight(8).map((p, i) => (i === 3 || i === 4 ? [...p, 0] : p));
  const route = buildRoute(track(points));
  assert.equal(route.runs.length, 2);
  assert.deepEqual(route.runs.map((r) => r.coordinates.length), [3, 3]);
  assert.equal(route.runOf[3], -1, 'a sample without a fix belongs to no run');
  assert.equal(route.runOf[5], 1);
  assert.equal(route.posOf[5], 0, 'the second run starts again at position 0');
  assert.equal(route.prevDrawn[4], 2, 'playback holds at the last drawn point');
});

test('cumulative fractions span 0 … 1 and index maps point back at the track', () => {
  const route = buildRoute(track(straight(5)));
  const { cum } = route.runs[0];
  assert.equal(cum[0], 0);
  assert.equal(cum.at(-1), 1);
  for (let i = 1; i < cum.length; i++) assert.ok(cum[i] > cum[i - 1], 'fractions ascend');
  assert.equal(route.runOf[3], 0);
  assert.equal(route.posOf[3], 3);
  assert.deepEqual(route.bounds, [[54.6, 24.45], [54.604, 24.45]]);
});

test('fractionAlong interpolates inside a segment and saturates at the end', () => {
  const run = buildRoute(track(straight(3))).runs[0];
  assert.ok(Math.abs(fractionAlong(run, 0, [54.6005, 24.45]) - 0.25) < 1e-6);
  assert.equal(fractionAlong(run, 2, [54.602, 24.45]), 1);
});

test('a gradient expression is anchored at 0 and strictly ascending', () => {
  const expr = gradientExpression([[0, 'rgb(1,1,1)'], [0.5, 'rgb(2,2,2)'], [0.8, 'rgb(3,3,3)']]);
  assert.deepEqual(expr.slice(0, 3), ['interpolate', ['linear'], ['line-progress']]);
  const stops = stopsOf(expr);
  assert.equal(stops[0][0], 0);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i][0] > stops[i - 1][0], `stop ${i} ascends`);
  assert.ok(stops.at(-1)[0] <= 1);
});

test('splicing puts one ramp before the cut and the other after it', () => {
  const before = [[0, 'A']];
  const after = [[0, 'B']];
  assert.deepEqual(spliceRamps(before, after, 0).map((s) => s[1]), ['B']);
  assert.deepEqual(spliceRamps(before, after, 1).map((s) => s[1]), ['A']);
  const mid = spliceRamps(before, after, 0.4);
  assert.deepEqual(mid.map((s) => s[1]), ['A', 'A', 'B']);
  assert.equal(mid[1][0], 0.4);
  assert.ok(mid[2][0] > 0.4 && mid[2][0] < 0.401, 'the cut is a hard edge');
});

test('progress colouring uses the two route colours, speed colouring many', () => {
  const run = buildRoute(track(straight(30).map((p, i) => [p[0], p[1], p[2], i]))).runs[0];
  const progress = new Set(stopsOf(runGradient(run, { progress: 0.5 })).map((s) => s[1]));
  assert.deepEqual([...progress].sort(), [ROUTE.remaining, ROUTE.travelled].sort());
  const speed = new Set(stopsOf(runGradient(run, { colorBySpeed: true, progress: 0.5 })).map((s) => s[1]));
  assert.ok(speed.size > 3, `expected a speed ramp, got ${speed.size} colours`);
  assert.ok(!speed.has(ROUTE.travelled));
});

test('gradient stops stay strictly ascending for every cut position', () => {
  const run = buildRoute(track(straight(40).map((p, i) => [p[0], p[1], p[2], i % 11]))).runs[0];
  for (const colorBySpeed of [false, true]) {
    for (const progress of [0, 1e-9, 5e-5, 0.0001, 0.25, 0.5, 0.9999, 1 - 1e-9, 1, 1.5, -0.2]) {
      const stops = stopsOf(runGradient(run, { colorBySpeed, progress }));
      assert.ok(stops.length >= 2, `cut ${progress}: needs two stops`);
      assert.equal(stops[0][0], 0, `cut ${progress}: starts at 0`);
      assert.ok(stops.at(-1)[0] <= 1, `cut ${progress}: ends within 1`);
      for (let i = 1; i < stops.length; i++) {
        assert.ok(stops[i][0] > stops[i - 1][0], `cut ${progress}: stop ${i} (${stops[i][0]}) must exceed ${stops[i - 1][0]}`);
      }
    }
  }
});

test('a track without a usable fix produces no runs', () => {
  const route = buildRoute(track([[0, 24.45, 54.6, 0]]));
  assert.deepEqual(route.runs, []);
  assert.equal(route.bounds, null);
  assert.equal(route.geojson.features.length, 0);

  const unreported = track(straight(4).map((p) => [...p, null]));   // GPS stream with no GPSF at all
  assert.equal(unreported.hasGps, false);
  assert.deepEqual(buildRoute(unreported).runs, []);
});
