// The browser modules that touch no DOM at import time run in Node as they are: formatting and the track lookups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, fmtNum, fmtKmh, fmtCameraEpoch, shortPath, describeSettings, lowerIndex } from '../web/js/util.js';
import { Track } from '../web/js/track.js';

test('fmtTime rounds before it splits, so a minute never reads 0:60.0', () => {
  assert.equal(fmtTime(59.96), '1:00.0');
  assert.equal(fmtTime(3599.97), '1:00:00.0');
  assert.equal(fmtTime(59.94), '0:59.9');
  assert.equal(fmtTime(0), '0:00.0');
  assert.equal(fmtTime(-3.5), '-0:03.5');
  assert.equal(fmtTime(3599.6, 0), '1:00:00');
  assert.equal(fmtTime(null), '--');
});

test('small formatters: fixed-width numbers, km/h, camera epochs, short paths', () => {
  assert.equal(fmtNum(3.14159, 2, 6), '  3.14');
  assert.equal(fmtNum(null, 2, 6), '    --');
  assert.equal(fmtKmh(10), '36.0');
  assert.equal(fmtKmh(null), '--');
  assert.equal(fmtCameraEpoch(1788598094), '2026-09-05 08:48');
  assert.equal(shortPath('/Users/bruce/DevNote/data/GoProFootage'), '…/data/GoProFootage');
  assert.equal(shortPath('/tmp/x'), '/tmp/x');
  assert.equal(lowerIndex([0, 1, 2], 1.5), 1);
});

test('the digital zoom is shown rounded, and as "On" when the camera only said it was on', () => {
  const row = (settings) => describeSettings(settings).find(([label]) => label === 'Zoom')?.[1];
  assert.equal(row({ digitalZoom: 1.399999976158142 }), '1.4×');
  assert.equal(row({ digitalZoom: 2 }), '2×');
  assert.equal(row({ digitalZoom: true }), 'On');
  assert.equal(row({ digitalZoom: 1 }), undefined, 'no zoom, no row');
  assert.equal(row({ digitalZoom: false }), undefined);
});

/** 1 Hz GPS: sample 2 has no fix, sample 3 is positioned but its speed is not trusted. */
const tel = {
  video: { durationSec: 5 },
  utcOffsetMs: null,
  gps: {
    n: 5, t: [0, 1, 2, 3, 4],
    lat: [33.1, 33.1001, 0, 33.1003, 33.1004], lon: [-117.3, -117.3001, 0, -117.3003, -117.3004],
    alt: [10, 20, 9000, 40, 50], speed2d: [10, 20, 30, 75, 12], speed3d: [10, 20, 30, 75, 12],
    fix: [3, 3, 0, 3, 3], dop: [1, 1, 99, 1, 1], utc: [0, 1000, 2000, 3000, 4000], speedOk: [1, 1, 0, 0, 1],
  },
};

test('Track.sampleAt never interpolates towards a sample that does not qualify, and is null outside the stream', () => {
  const track = new Track(tel);
  assert.deepEqual(track.valid, [true, true, false, true, true]);
  assert.deepEqual(track.precise, [true, true, false, false, true]);
  const mid = track.sampleAt(0.5);
  assert.ok(Math.abs(mid.lat - 33.10005) < 1e-9, 'between two positioned samples: interpolated');
  assert.equal(mid.speed2d, 15);
  assert.equal(mid.alt, 15);
  const before = track.sampleAt(1.5);
  assert.equal(before.lat, 33.1001, 'sample 2 has no fix: the position holds at sample 1');
  assert.equal(before.speed2d, 20, 'and so does the speed');
  assert.equal(before.alt, 20);
  const lost = track.sampleAt(2.5);
  assert.equal(lost.valid, false);
  assert.equal(lost.lat, null, 'no fix: no position to show');
  assert.equal(lost.alt, null, 'and no 9 000 m altitude either');
  assert.equal(lost.speed2d, null);
  const weak = track.sampleAt(3.5);
  assert.equal(weak.valid, true);
  assert.ok(Math.abs(weak.lat - 33.10035) < 1e-9);
  assert.equal(weak.speed2d, null, 'sample 3 is positioned but its 75 m/s is not trusted');
  assert.equal(track.sampleAt(4).speed2d, 12);
  assert.equal(track.sampleAt(20), null, 'long after the last sample there is nothing to show');
  assert.equal(track.sampleAt(-5), null);
  assert.deepEqual(track.runs(), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});
