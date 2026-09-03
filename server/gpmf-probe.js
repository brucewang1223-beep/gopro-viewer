/**
 * Scan-time GPS fix probe.
 *
 * `probeGpmfStreams` (mp4.js) only tells whether a GPS stream exists. A camera with GPS
 * enabled but no satellite lock still writes GPS5/GPS9 samples (lat/lon 0 or garbage,
 * fix = 0, DOP 99.99). To label recordings honestly, this probe decodes a handful of
 * payloads spread evenly over the file (≈ 50 × ~6 KB, independent of file size) and
 * reports whether a 2D/3D fix was seen anywhere.
 */

import { readMp4Info, readSampleData } from './mp4.js';
import { decodeTelemetry, devicesOf } from './decode.js';

/** Every `step`-th sample so that at most ~`max` are picked. */
function pickEvenly(samples, max) {
  const step = Math.max(1, Math.floor(samples.length / max));
  const picked = [];
  for (let i = 0; i < samples.length; i += step) picked.push(samples[i]);
  return picked;
}

/** GPS9 carries the fix per sample (value[8]). */
function countGps9(samples, counts) {
  for (const s of samples) {
    if (!Array.isArray(s.value)) continue;
    counts.gpsSamples++;
    if ((s.value[8] ?? 0) >= 2) counts.fixSamples++;
  }
}

/** GPS5's GPSF is a sticky per-payload value: carry it forward like the main pipeline does. */
function countGps5(samples, counts) {
  let fix = 0;
  for (const s of samples) {
    if (!Array.isArray(s.value)) continue;
    if (s.fix != null) fix = s.fix;
    counts.gpsSamples++;
    if (fix >= 2) counts.fixSamples++;
  }
}

function countFixes(tel) {
  const counts = { gpsSamples: 0, fixSamples: 0 };
  for (const [, dev] of devicesOf(tel)) {
    const gps9 = dev.streams.GPS9?.samples;
    const gps5 = dev.streams.GPS5?.samples;
    if (gps9?.length) countGps9(gps9, counts);
    else if (gps5?.length) countGps5(gps5, counts);
  }
  return counts;
}

/**
 * @param {string} filePath
 * @param {object} [info] result of readMp4Info(filePath)
 * @param {{ maxPayloads?: number }} [opts]
 * @returns {Promise<{ checked: number, gpsSamples: number, fixSamples: number, hasFix: boolean, fixRatio: number }>}
 */
export async function probeGpsFix(filePath, info, { maxPayloads = 48 } = {}) {
  const meta = info ?? await readMp4Info(filePath);
  const picked = pickEvenly(meta.gpmd?.samples ?? [], maxPayloads);
  const empty = { checked: picked.length, gpsSamples: 0, fixSamples: 0, hasFix: false, fixRatio: 0 };
  if (!picked.length) return empty;
  const rawData = await readSampleData(filePath, picked);
  let tel;
  try {
    tel = await decodeTelemetry({ rawData }, ['GPS']);
  } catch {
    return empty;
  }
  const { gpsSamples, fixSamples } = countFixes(tel);
  return { checked: picked.length, gpsSamples, fixSamples, hasFix: fixSamples > 0, fixRatio: gpsSamples ? fixSamples / gpsSamples : 0 };
}
