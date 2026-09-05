import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoProName, Library } from '../server/library.js';
import { FIX, FIXTURES, withTempDir } from './helpers.js';

test('parseGoProName handles HERO6+ chapters, proxies, thumbnails and legacy names', () => {
  assert.deepEqual(parseGoProName('GX010001.MP4'), { family: 'GX', chapter: '01', number: '0001', kind: 'video', encoding: 'hevc' });
  assert.deepEqual(parseGoProName('GH020001.mp4'), { family: 'GX', chapter: '02', number: '0001', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GL010001.LRV'), { family: 'GX', chapter: '01', number: '0001', kind: 'proxy', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GX010001.THM'), { family: 'GX', chapter: '01', number: '0001', kind: 'thumb', encoding: null });
  assert.deepEqual(parseGoProName('GOPR0042.MP4'), { family: 'GOPR', chapter: '00', number: '0042', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GP010042.MP4'), { family: 'GOPR', chapter: '01', number: '0042', kind: 'video', encoding: 'h264' });
  assert.deepEqual(parseGoProName('GP010042.LRV'), { family: 'GOPR', chapter: '01', number: '0042', kind: 'proxy', encoding: 'h264' }, 'a HERO5 proxy stays in the GOPR family');
  assert.equal(parseGoProName('GPFR0001.MP4'), null, 'chapters are digits: a Fusion front file is a loose video');
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

test('the sidebar start is the camera clock as written for old cameras, with the UTC start from the GPS clock beside it', async () => {
  await withTempDir(async (cache) => {
    const lib = new Library({ roots: [FIXTURES], cacheDir: cache });
    const { recordings } = await lib.scan();
    const gx = recordings.find((r) => r.name === 'GX0001');
    assert.equal(gx.startTime, '2018-01-24T11:27:32.000Z', 'Hero6 wrote its local clock into the file');
    assert.equal(gx.startTimeUtc, '2018-01-24T19:27:58.000Z', 'the GPS clock at the start of the file');
    assert.equal(gx.chapters[0].clock, 'local');
    const gh = recordings.find((r) => r.name === 'GH0002');
    assert.equal(gh.startTimeUtc, null, 'no fix, no header: nothing to derive UTC from');
    assert.equal(gh.chapters[0].clock, null);
  });
});

test('a root that is not on disk is reported as such; a root added during a scan is scanned too', async () => {
  await withTempDir(async (cache) => {
    const lib = new Library({ roots: ['/definitely/not/here'], cacheDir: cache });
    await lib.scan();
    assert.deepEqual(lib.rootRecords().map((r) => r.exists), [false]);
    const first = lib.scan();                    // a scan in flight …
    lib.roots = ['/definitely/not/here', FIXTURES];
    const second = lib.scan();                   // … and a root added meanwhile
    assert.equal((await first).recordings.length, 0, 'the scan that was already running knew one root');
    assert.equal((await second).recordings.length, 2, 'the caller that added the root gets a scan that includes it');
    assert.deepEqual(lib.rootRecords().map((r) => r.exists), [false, true]);
  });
});

test('symlinked folders are followed, unreadable files are skipped, HERO5 proxies attach to their chapter', async () => {
  const { symlink, mkdir, copyFile, writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  await withTempDir(async (dir) => {
    const root = path.join(dir, 'root');
    await mkdir(root);
    await symlink(FIXTURES, path.join(root, 'linked'));
    const legacy = path.join(root, 'legacy');
    await mkdir(legacy);
    await copyFile(FIX.gh01, path.join(legacy, 'GOPR0042.MP4'));
    await copyFile(FIX.gh01, path.join(legacy, 'GP010042.MP4'));
    await writeFile(path.join(legacy, 'GP010042.LRV'), 'not really a proxy');
    await writeFile(path.join(legacy, 'GX010042.MP4'), 'not an mp4 at all');
    await symlink(path.join(legacy, 'gone.MP4'), path.join(legacy, 'GX010099.MP4'));   // a dangling link: listed, unreadable, skipped
    const lib = new Library({ roots: [root], cacheDir: path.join(dir, 'cache') });
    const data = await lib.scan();
    const names = data.recordings.map((r) => r.name).sort();
    assert.deepEqual(names, ['GH0002', 'GOPR0042', 'GX0001'], 'the two fixture recordings through the symlink plus the legacy pair (the bogus GX010042 is skipped)');
    const gopr = data.recordings.find((r) => r.name === 'GOPR0042');
    assert.deepEqual(gopr.chapters.map((c) => c.file), ['GOPR0042.MP4', 'GP010042.MP4']);
    assert.equal(gopr.chapters[1].proxyId != null, true, 'GP010042.LRV is the proxy of chapter 01');
    assert.equal(gopr.hasProxy, false, 'chapter 00 has none');
  });
});

test('two files for the same chapter make one chapter and a warning, not a nine-second recording', async () => {
  const { mkdir, copyFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  await withTempDir(async (dir) => {
    const root = path.join(dir, 'root');
    await mkdir(root);
    await copyFile(FIX.gx01, path.join(root, 'GX010007.MP4'));
    await copyFile(FIX.gx02, path.join(root, 'GX010007.mov'));
    const lib = new Library({ roots: [root], cacheDir: path.join(dir, 'cache') });
    const data = await lib.scan();
    assert.equal(data.recordings.length, 1);
    assert.equal(data.recordings[0].chapters.length, 1);
    assert.match(data.recordings[0].warnings[0], /same chapter as GX010007\.MP4, skipped/);
  });
});
