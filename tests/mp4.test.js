import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readMp4Info, readGpmfTrack, probeGpmfStreams, Mp4Error } from '../server/mp4.js';
import { FIX } from './helpers.js';

test('readMp4Info exposes movie, video and gpmd track metadata', async () => {
  const info = await readMp4Info(FIX.gx01);
  assert.equal(info.brand, 'isom');
  assert.ok(Math.abs(info.durationSec - 5.014) < 0.05, `duration ${info.durationSec}`);
  assert.equal(info.creationTime.toISOString(), '2018-01-24T11:27:32.000Z');
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.width, 848);
  assert.equal(info.video.height, 480);
  assert.ok(Math.abs(info.video.fps - 29.97) < 0.01, `fps ${info.video.fps}`);
  assert.equal(info.audio.codec, 'aac');
  assert.ok(info.gpmd, 'gpmd track present');
  assert.equal(info.gpmd.timescale, 1000);
  assert.equal(info.gpmd.samples.length, 5);
  assert.equal(info.gpmd.samples[0].ctsMs, 0);
  assert.equal(info.gpmd.samples[1].ctsMs, 1001);
  assert.equal(info.gpmd.samples[1].durationMs, 1001);
  const size = (await stat(FIX.gx01)).size;
  for (const s of info.gpmd.samples) assert.ok(s.offset > 0 && s.offset + s.size <= size, 'sample range inside file');
});

test('withSamples:false skips the sample table but keeps track presence', async () => {
  const info = await readMp4Info(FIX.gh01, { withSamples: false });
  assert.ok(info.gpmd);
  assert.equal(info.gpmd.samples, null);
  assert.equal(info.gpmd.nbSamples, 5);
});

test('readGpmfTrack returns the concatenated GPMF payloads and ms timing', async () => {
  const info = await readMp4Info(FIX.gx01);
  const { rawData, timing } = await readGpmfTrack(FIX.gx01, info);
  assert.equal(rawData.length, info.gpmd.samples.reduce((a, s) => a + s.size, 0));
  assert.equal(rawData.toString('latin1', 0, 4), 'DEVC', 'payload starts with a DEVC key');
  assert.equal(timing.samples.length, 5);
  assert.deepEqual(timing.samples[0], { cts: 0, duration: 1001 });
  assert.ok(Math.abs(timing.frameDuration - 1 / 29.97) < 1e-4);
  assert.ok(Math.abs(timing.videoDuration - info.durationSec) < 1e-6);
  assert.ok(timing.start instanceof Date);
});

test('probeGpmfStreams detects GPS and IMU keys from the first payloads', async () => {
  const p = await probeGpmfStreams(FIX.gx01);
  assert.equal(p.gps, true);
  assert.equal(p.imu, true);
  assert.ok(p.keys.includes('GPS5') && p.keys.includes('ACCL') && p.keys.includes('GYRO'), p.keys.join(','));
  assert.ok(!p.keys.includes('GPS9'), 'Hero6 has no GPS9');
});

test('probeGpsFix distinguishes a locked receiver from a searching one', async () => {
  const { probeGpsFix } = await import('../server/gpmf-probe.js');
  const locked = await probeGpsFix(FIX.gx01);
  assert.ok(locked.checked > 0 && locked.hasFix && locked.fixRatio > 0.3, JSON.stringify(locked));
  const searching = await probeGpsFix(FIX.gh01);
  assert.ok(searching.gpsSamples > 0 && !searching.hasFix, JSON.stringify(searching));
});

test('non-MP4 input raises Mp4Error', async () => {
  await assert.rejects(readMp4Info(path.resolve('package.json')), (e) => e instanceof Mp4Error);
});

/** A copy of the Hero6 fixture with one 32-bit field of its gpmd track patched. */
async function patchedFixture(dir, name, match, value) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const buf = Buffer.from(await readFile(FIX.gx01));
  const moovEnd = buf.length;   // the whole file is small: search the lot
  let at = -1;
  for (let off = 0; off + 4 <= moovEnd; off++) {
    if (buf.toString('latin1', off, off + 4) === match.box) { at = off; break; }
  }
  assert.ok(at > 0, `${match.box} box found`);
  const target = path.join(dir, name);
  buf.writeUInt32BE(value, at + match.offset);
  await writeFile(target, buf);
  return target;
}

test('corrupt sample tables are refused with an Mp4Error instead of a crash or a huge allocation', async () => {
  const { withTempDir } = await import('./helpers.js');
  await withTempDir(async (dir) => {
    // the first stts in the file belongs to the video track: 4 (type) + 4 (version/flags) → entry count
    const stts = await patchedFixture(dir, 'stts.MP4', { box: 'stts', offset: 8 }, 0x7fffffff);
    await assert.rejects(readMp4Info(stts), (e) => e instanceof Mp4Error && /Corrupt 'stts' table/.test(e.message));
    // stsz: 4 (type) + 4 (version/flags) + 4 (sample_size) → sample count
    const stsz = await patchedFixture(dir, 'stsz.MP4', { box: 'stsz', offset: 12 }, 0x3fffffff);
    await assert.rejects(readMp4Info(stsz), (e) => e instanceof Mp4Error && /Corrupt 'stsz' table/.test(e.message));
    // mvhd: 4 (type) + 4 (version/flags) + 4 + 4 (creation, modification) → timescale
    const mvhd = await patchedFixture(dir, 'mvhd.MP4', { box: 'mvhd', offset: 16 }, 0);
    await assert.rejects(readMp4Info(mvhd), (e) => e instanceof Mp4Error && /timescale/.test(e.message));
  });
});
