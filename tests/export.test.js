import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGpx, toCsv, toGeoJson } from '../server/export.js';

const tel = {
  name: 'GX0001 <test>',
  camera: { model: 'Hero6 Black' },
  utcOffsetMs: Date.UTC(2018, 0, 24, 19, 27, 58),
  gps: {
    n: 3, t: [0, 0.5, 1], lat: [33.1, 33.1001, 33.1002], lon: [-117.3, -117.3001, -117.3002], alt: [10, 10.5, 11],
    speed2d: [1, 1.5, 2], speed3d: [1, 1.5, 2], fix: [3, 0, 3], dop: [1.2, 9.9, 1.3],
    utc: [Date.UTC(2018, 0, 24, 19, 27, 58), Date.UTC(2018, 0, 24, 19, 27, 58, 500), Date.UTC(2018, 0, 24, 19, 27, 59)],
  },
  accl: { n: 2, t: [0.02, 0.06], x: [1, 2], y: [3, 4], z: [5, 6], mag: [5.9, 7.5], magMax: [6, 8] },
  gyro: null,
};

test('toGpx writes only fixed points, escapes names and includes ele/time/speed', () => {
  const gpx = toGpx(tel);
  assert.ok(gpx.startsWith('<?xml'));
  assert.ok(gpx.includes('<name>GX0001 &lt;test&gt;</name>'));
  assert.equal((gpx.match(/<trkpt /g) || []).length, 2, 'no-fix point excluded');
  assert.ok(gpx.includes('<ele>10</ele><time>2018-01-24T19:27:58.000Z</time>'));
  assert.ok(gpx.includes('<gpxtpx:speed>2</gpxtpx:speed>'));
  assert.ok(gpx.trim().endsWith('</gpx>'));
});

test('toGeoJson writes one LineString per positioned run with altitude and per-point arrays', () => {
  const fc = JSON.parse(toGeoJson(tel));
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  const f = fc.features[0];
  assert.equal(f.geometry.type, 'LineString');
  assert.deepEqual(f.geometry.coordinates, [[-117.3, 33.1, 10], [-117.3002, 33.1002, 11]], 'lon, lat, alt; no-fix point excluded');
  assert.equal(f.properties.name, 'GX0001 <test>');
  assert.equal(f.properties.camera, 'Hero6 Black');
  assert.equal(f.properties.points, 2);
  assert.equal(f.properties.startTime, '2018-01-24T19:27:58.000Z');
  assert.equal(f.properties.endTime, '2018-01-24T19:27:59.000Z');
  assert.equal(f.properties.maxSpeedMs, 2);
  assert.ok(f.properties.distanceM > 0);
  assert.deepEqual(f.properties.coordinateProperties.speeds, [1, 2]);
  assert.equal(f.properties.coordinateProperties.times.length, f.geometry.coordinates.length);
});

test('toGeoJson splits runs on time gaps and skips recordings without a fix', () => {
  const gapped = {
    ...tel,
    gps: {
      n: 4, t: [0, 1, 30, 31],
      lat: [33.1, 33.1001, 33.2, 33.2001], lon: [-117.3, -117.3001, -117.4, -117.4001], alt: [10, 11, 12, 13],
      speed2d: [1, 2, 3, 4], speed3d: [1, 2, 3, 4], fix: [3, 3, 3, 3], dop: [1, 1, 1, 1],
      utc: [0, 1000, 30000, 31000],
    },
  };
  const features = JSON.parse(toGeoJson(gapped)).features;
  assert.equal(features.length, 2, 'a 29 s gap starts a new run');
  assert.deepEqual(features.map((f) => f.properties.name), ['GX0001 <test> (1/2)', 'GX0001 <test> (2/2)']);
  assert.equal(features[1].geometry.coordinates.length, 2);

  const noFix = { ...tel, gps: { ...tel.gps, fix: [0, 0, 0] } };
  assert.deepEqual(JSON.parse(toGeoJson(noFix)).features, []);
  assert.deepEqual(JSON.parse(toGeoJson({ ...tel, gps: null })).features, []);
});

test('toCsv gps keeps every sample with fix and dop columns', () => {
  const lines = toCsv(tel, 'gps').trim().split('\n');
  assert.equal(lines[0], 't_sec,utc_iso,lat,lon,alt_m,speed2d_ms,speed3d_ms,fix,dop');
  assert.equal(lines.length, 4);
  assert.equal(lines[2], '0.5,2018-01-24T19:27:58.500Z,33.1001,-117.3001,10.5,1.5,1.5,0,9.9');
});

test('toCsv accl / gyro columns and empty streams', () => {
  const accl = toCsv(tel, 'accl').trim().split('\n');
  assert.equal(accl[0], 't_sec,x_ms2,y_ms2,z_ms2,mag_ms2,magmax_ms2');
  assert.equal(accl.length, 3);
  const gyro = toCsv(tel, 'gyro').trim().split('\n');
  assert.equal(gyro.length, 1, 'header only when stream missing');
});
