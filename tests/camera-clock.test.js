import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockConvention, startTimes } from '../server/camera-clock.js';
import { mergeChapters } from '../server/telemetry.js';

// A HERO13 file: mvhd 04:48:29Z, header CDAT 08:48:29 (local as UTC), TZON +240 — the creation time is UTC.
const HERO13 = { creationTime: '2026-09-05T04:48:29.000Z', settings: { createdLocalEpoch: 1788598109, tzMinutes: 240 } };
// A Hero6 file: mvhd 11:27:32Z, the GPS clock at video time 0 says 19:27:58Z — the creation time is local (UTC−8).
const HERO6 = { creationTime: '2018-01-24T11:27:32.000Z', settings: null, gpsStartUtcMs: Date.UTC(2018, 0, 24, 19, 27, 58) };

test('clockConvention tells a UTC creation time from a local one by the header or by the GPS clock', () => {
  assert.equal(clockConvention(HERO13), 'utc');
  assert.equal(clockConvention({ creationTime: '2026-09-05T08:48:29.000Z', settings: HERO13.settings }), 'local', 'a camera that wrote the local clock into mvhd');
  assert.equal(clockConvention(HERO6), 'local');
  assert.equal(clockConvention({ ...HERO6, creationTime: '2018-01-24T19:27:40.000Z' }), 'utc', 'within minutes of the GPS clock');
  assert.equal(clockConvention({ ...HERO6, gpsStartUtcMs: Date.UTC(2018, 0, 26) }), null, 'two days off is neither');
  assert.equal(clockConvention({ creationTime: '2019-11-18T15:41:25.000Z', settings: null }), null, 'nothing to compare with');
  assert.equal(clockConvention({ creationTime: null }), null);
});

test('startTimes gives the camera-local start for the sidebar and the UTC start when it can be known', () => {
  assert.deepEqual(startTimes(HERO13), { local: '2026-09-05T08:48:29.000Z', utc: '2026-09-05T04:48:29.000Z' });
  assert.deepEqual(startTimes(HERO6), { local: '2018-01-24T11:27:32.000Z', utc: '2018-01-24T19:27:58.000Z' }, 'local as written, UTC from the GPS clock');
  assert.deepEqual(startTimes({ creationTime: '2019-11-18T15:41:25.000Z', settings: null }), { local: '2019-11-18T15:41:25.000Z', utc: null }, 'an old camera without GPS: the historic reading');
  assert.deepEqual(startTimes({ creationTime: '2019-11-18T15:41:25.000Z', settings: { tzMinutes: -480 } }), { local: '2019-11-18T15:41:25.000Z', utc: '2019-11-18T23:41:25.000Z' }, 'a zone alone makes the local clock UTC');
  assert.deepEqual(startTimes({ creationTime: null, settings: null }), { local: null, utc: null });
});

test('mergeChapters anchors the HUD clock on the camera clock the right way round for both conventions', () => {
  const rec = { id: 'r', name: 'X', chapters: [{ id: 'a', file: 'a.MP4', index: 0, offsetSec: 0, durationSec: 10 }], durationSec: 10, startTime: null };
  const merged = (creationTime, settings) => mergeChapters(rec, [{ chapter: rec.chapters[0], data: { gps: null, accl: null, gyro: null, warnings: [], camera: {}, settings, creationTime } }]);
  const hero13 = merged(HERO13.creationTime, HERO13.settings);
  assert.equal(hero13.utcSource, 'camera-clock');
  assert.equal(hero13.utcOffsetMs, Date.parse('2026-09-05T04:48:29.000Z'), 'a UTC creation time is used as it is');
  const older = merged('2026-09-05T08:48:29.000Z', { tzMinutes: 240 });
  assert.equal(older.utcOffsetMs, Date.parse('2026-09-05T04:48:29.000Z'), 'a local creation time is moved back by the zone');
  assert.equal(merged('2026-09-05T08:48:29.000Z', null).utcSource, null, 'without a zone or a GPS clock there is no anchor');
});
