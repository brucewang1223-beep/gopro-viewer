/**
 * Scan-time GPS fix probe.
 *
 * `probeGpmfStreams` (mp4.js) only tells whether a GPS stream exists. A camera with GPS
 * enabled but no satellite lock still writes GPS5/GPS9 samples (lat/lon 0 or garbage,
 * fix = 0, DOP 99.99). To label recordings honestly, this probe decodes a handful of
 * payloads spread evenly over the file (≈ 50 × ~6 KB, independent of file size) and
 * reports whether a 2D/3D fix was seen anywhere — and, from the first fixed sample, the
 * GPS clock at the start of the file, which settles what the camera's own clock means.
 */

import { readMp4Info, readSampleData, gpmfTiming } from './mp4.js';
import { decodeTelemetry, devicesOf } from './decode.js';

/** Every `step`-th sample so that at most ~`max` are picked. */
function pickEvenly(samples, max) {
  const step = Math.max(1, Math.floor(samples.length / max));
  const picked = [];
  for (let i = 0; i < samples.length; i += step) picked.push(samples[i]);
  return picked;
}

/** GPS9 carries the fix per sample (value[8]); GPS5's GPSF is a sticky per-payload value carried forward like the main pipeline does. */
function fixOf(s, key, sticky) {
  if (key === 'GPS9') return s.value[8] ?? 0;
  if (s.fix != null) sticky.fix = s.fix;
  return sticky.fix;
}

/** Fix counts of one GPS stream, plus the GPS clock at video time 0 from its first fixed, dated sample. */
function countStream(samples, key, counts) {
  const sticky = { fix: 0 };
  for (const s of samples) {
    if (!Array.isArray(s.value)) continue;
    counts.gpsSamples++;
    if (!(fixOf(s, key, sticky) >= 2)) continue;
    counts.fixSamples++;
    const dated = Date.parse(s.date ?? '');
    if (counts.utcAtStartMs == null && Number.isFinite(dated) && s.cts != null) counts.utcAtStartMs = dated - s.cts;
  }
}

function countFixes(tel) {
  const counts = { gpsSamples: 0, fixSamples: 0, utcAtStartMs: null };
  for (const [, dev] of devicesOf(tel)) {
    const key = ['GPS9', 'GPS5'].find((k) => dev.streams[k]?.samples?.length);
    if (key) countStream(dev.streams[key].samples, key, counts);
  }
  return counts;
}

/**
 * @param {string} filePath
 * @param {object} [info] result of readMp4Info(filePath)
 * @param {{ maxPayloads?: number }} [opts]
 * @returns {Promise<{ checked: number, gpsSamples: number, fixSamples: number, hasFix: boolean, fixRatio: number, utcAtStartMs: number|null }>}
 */
export async function probeGpsFix(filePath, info, { maxPayloads = 48 } = {}) {
  const meta = info ?? await readMp4Info(filePath);
  const picked = pickEvenly(meta.gpmd?.samples ?? [], maxPayloads);
  const empty = { checked: picked.length, gpsSamples: 0, fixSamples: 0, hasFix: false, fixRatio: 0, utcAtStartMs: null };
  if (!picked.length) return empty;
  const rawData = await readSampleData(filePath, picked);
  let tel;
  try {
    tel = await decodeTelemetry({ rawData, timing: gpmfTiming(meta, picked) }, ['GPS']);
  } catch {
    return empty;
  }
  const { gpsSamples, fixSamples, utcAtStartMs } = countFixes(tel);
  return { checked: picked.length, gpsSamples, fixSamples, hasFix: fixSamples > 0, fixRatio: gpsSamples ? fixSamples / gpsSamples : 0, utcAtStartMs };
}
