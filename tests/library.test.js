import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoProName, Library } from '../server/library.js';
import { FIXTURES, withTempDir } from './helpers.js';

test('parseGoProName handles HERO6+ chapters, proxies, thumbnails and legacy names', () => {
  assert.deepEqual(parseGoProName('GX010001.MP4'), { family: 'GX', chapter: '01', number: '0001', kind: 'video', encoding: 'hevc' });
  assert.deepEqual(parseGoProName('GH020001.mp4'), { family: 'GX', chapter: '02', number: '0001', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GL010001.LRV'), { family: 'GX', chapter: '01', number: '0001', kind: 'proxy', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GX010001.THM'), { family: 'GX', chapter: '01', number: '0001', kind: 'thumb', encoding: null });
  assert.deepEqual(parseGoProName('GOPR0042.MP4'), { family: 'GOPR', chapter: '00', number: '0042', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GP010042.MP4'), { family: 'GOPR', chapter: '01', number: '0042', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GS010003.360'), { family: 'GS', chapter: '01', number: '0003', kind: '360', encoding: 'hevc' });
  assert.equal(parseGoProName('holiday.mp4'), null);
  assert.equal(parseGoProName('GX01000.MP4'), null);
});

test('Library groups chapters into recordings with cumulative offsets', async () => {
  await withTempDir(async (cache) => {
    const lib = new Library({ roots: [FIXTURES], cacheDir: cache });
    const data = await lib.scan();
    assert.equal(data.recordings.length, 2);
    const names = data.recordings.map((r) => r.name);
    assert.deepEqual(names, ['GH0002', 'GX0001'], 'sorted by start time, newest first');

    const gx = data.recordings.find((r) => r.name === 'GX0001');
    assert.equal(gx.chapters.length, 2);
    assert.deepEqual(gx.chapters.map((c) => c.file), ['GX010001.MP4', 'GX020001.MP4']);
    assert.equal(gx.chapters[0].offsetSec, 0);
    assert.ok(Math.abs(gx.chapters[1].offsetSec - gx.chapters[0].durationSec) < 1e-9);
    assert.ok(Math.abs(gx.durationSec - (gx.chapters[0].durationSec + gx.chapters[1].durationSec)) < 1e-9);
    assert.equal(gx.hasGpmd, true);
    assert.equal(gx.hasGps, true);
    assert.equal(gx.hasGpsFix, true, 'Hero6 fixture has a 3D fix');
    assert.equal(gx.hasImu, true);
    assert.equal(gx.chapters[0].hasGps, true);
    const gh = data.recordings.find((r) => r.name === 'GH0002');
    assert.equal(gh.hasGps, true, 'HERO8 fixture has a GPS stream');
    assert.equal(gh.hasGpsFix, false, 'but never a fix');
    assert.equal(gx.hasProxy, false);
    assert.equal(gx.codec, 'h264');
    assert.equal(gx.startTime, '2018-01-24T11:27:32.000Z');
    assert.ok(!('path' in gx.chapters[0]), 'absolute paths are not exposed');

    // registry lookups
    const file = lib.getFile(gx.chapters[0].id);
    assert.ok(file && file.path.endsWith('GX010001.MP4'));
    assert.ok(lib.getRecording(gx.id));
    assert.equal(lib.getFile('nope'), null);

    // second scan reuses the info cache and yields identical ids
    const again = await lib.scan();
    assert.deepEqual(again.recordings.map((r) => r.id), data.recordings.map((r) => r.id));
  });
});

test('Library tolerates a missing root', async () => {
  await withTempDir(async (cache) => {
    const lib = new Library({ roots: ['/definitely/not/here'], cacheDir: cache });
    const data = await lib.scan();
    assert.equal(data.recordings.length, 0);
    assert.equal(data.roots.length, 1);
  });
});
