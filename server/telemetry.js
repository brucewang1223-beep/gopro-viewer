/**
 * Telemetry pipeline
 *
 *   MP4 chapter ──readGpmfTrack──▶ raw GPMF + timing ──gopro-telemetry──▶ interpreted streams
 *              ──normalizeTelemetry──▶ columnar chapter JSON (cached on disk)
 *   recording  ──mergeChapters──▶ one timeline (chapter cts offset by cumulative video duration) + stats
 *
 * Time base: `t` is seconds since the first frame of chapter 1 ("global time"),
 * matching what the player computes as chapter.offsetSec + video.currentTime.
 */

import path from 'node:path';
import { readMp4Info, readGpmfTrack } from './mp4.js';
import { readStreamOrientations, cameraFrameMapping, headerSettingsSummary } from './gpmf-klv.js';
import { decodeTelemetry, devicesOf } from './decode.js';
import { round, positionRuns, runStats, speedOkFlags } from './geo.js';
import { clockConvention } from './camera-clock.js';
import { readJsonCache, writeJsonCache } from './json-cache.js';
import { shortId } from './ids.js';
import { createLogger } from './log.js';

const log = createLogger('telemetry');
export const SCHEMA = 'gopro-viewer.telemetry/1';
const CACHE_VERSION = 6; // bump when the chapter output changes

const GPS_COLUMNS = ['t', 'lat', 'lon', 'alt', 'speed2d', 'speed3d', 'fix', 'dop', 'utc'];
const IMU_COLUMNS = ['t', 'x', 'y', 'z', 'mag', 'magMax'];

/* ---------- per-chapter normalisation ---------- */

/** Pick the device that carries the camera sensors (most target streams, lowest id on ties). */
function pickDevice(tel) {
  const wanted = ['GPS9', 'GPS5', 'ACCL', 'GYRO'];
  let best = null; let bestScore = -1;
  for (const [id, dev] of devicesOf(tel)) {
    const score = wanted.filter((k) => dev.streams[k]?.samples?.length).length;
    if (score > bestScore || (score === bestScore && Number(id) < Number(best.id))) { best = { id, dev }; bestScore = score; }
  }
  return best;
}

/** Bin accumulator of a 3-axis stream: sums per axis plus mean and peak magnitude. */
function addToBin(bins, key, [x, y, z]) {
  let b = bins.get(key);
  if (!b) { b = { n: 0, x: 0, y: 0, z: 0, mag: 0, max: 0 }; bins.set(key, b); }
  const mag = Math.sqrt(x * x + y * y + z * z);
  b.n++; b.x += x; b.y += y; b.z += z; b.mag += mag; b.max = Math.max(b.max, mag);
}

/**
 * Downsample a 3-axis stream to `hz` by time-binning, re-expressed in the GoPro camera
 * frame (x = camera left, y = camera back, z = up) using the ORIN/ORIO mapping.
 * Output per bin: mean x/y/z, mean magnitude, max magnitude, bin centre time.
 */
function downsample3(samples, hz, orientation) {
  const width = 1 / hz;
  const mapping = cameraFrameMapping(orientation || {});
  const axis = Object.fromEntries(mapping.map.map((m) => [m.axis, m]));
  const inCameraFrame = (v) => ['x', 'y', 'z'].map((k) => axis[k].sign * v[axis[k].index]);
  const bins = new Map();
  for (const s of samples) {
    if (!Array.isArray(s.value) || s.value.length < 3 || s.cts == null) continue;
    addToBin(bins, Math.floor(s.cts / 1000 / width), inCameraFrame(s.value));
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const out = {
    hz, n: keys.length, frame: 'camera', // x: camera left, y: camera back, z: up
    orientation: { orin: orientation?.orin ?? null, orio: orientation?.orio ?? null, order: mapping.order, source: mapping.source },
    t: [], x: [], y: [], z: [], mag: [], magMax: [],
  };
  for (const k of keys) {
    const b = bins.get(k);
    out.t.push(round((k + 0.5) * width, 4));
    out.x.push(round(b.x / b.n, 3)); out.y.push(round(b.y / b.n, 3)); out.z.push(round(b.z / b.n, 3));
    out.mag.push(round(b.mag / b.n, 3)); out.magMax.push(round(b.max, 3));
  }
  return out;
}

/** GPS9 carries fix/DOP per sample (value[8] / value[7]); GPS5 gets sticky GPSF/GPSP values attached to each sample. */
function fixAndDop(key, s, prev) {
  if (key === 'GPS9') return { fix: s.value[8] ?? prev.fix, dop: s.value[7] ?? prev.dop };
  return { fix: s.fix ?? prev.fix, dop: s.precision != null ? s.precision / 100 : prev.dop };
}

/** One GPS sample as a row of the columnar stream. */
function gpsRow(s, state) {
  const v = s.value;
  return {
    t: round(s.cts / 1000, 4), lat: round(v[0], 7), lon: round(v[1], 7), alt: round(v[2], 2),
    speed2d: round(v[3], 3), speed3d: round(v[4], 3),
    fix: state.fix == null ? null : Number(state.fix), dop: state.dop == null ? null : round(state.dop, 2),
    utc: s.date ? new Date(s.date).getTime() : null,
  };
}

function normalizeGps(stream, key) {
  const out = { source: key, n: 0, altitudeSystem: null, hz: 0 };
  for (const c of GPS_COLUMNS) out[c] = [];
  let state = { fix: null, dop: null };
  for (const s of stream.samples) {
    if (!Array.isArray(s.value) || s.value.length < 5 || s.cts == null) continue;
    state = fixAndDop(key, s, state);
    if (s['altitude system'] && !out.altitudeSystem) out.altitudeSystem = s['altitude system'];
    const row = gpsRow(s, state);
    for (const c of GPS_COLUMNS) out[c].push(row[c]);
  }
  out.n = out.t.length;
  const dt = out.n > 1 ? (out.t[out.n - 1] - out.t[0]) / (out.n - 1) : 0;
  out.hz = dt > 0 ? round(1 / dt, 2) : 0;
  return out;
}

/**
 * Convert a gopro-telemetry result into the viewer's columnar streams.
 * Exported for tests (works on raw GPMF samples without an MP4 container).
 */
export function normalizeTelemetry(tel, { accelHz = 25, orientations = {} } = {}) {
  const out = { model: null, gps: null, accl: null, gyro: null, warnings: [] };
  const picked = pickDevice(tel);
  if (!picked) { out.warnings.push('no telemetry device found'); return out; }
  const { streams } = picked.dev;
  out.model = picked.dev['device name'] ?? null;
  const gpsKey = ['GPS9', 'GPS5'].find((k) => streams[k]?.samples?.length);
  if (gpsKey) out.gps = normalizeGps(streams[gpsKey], gpsKey);
  else out.warnings.push('no GPS stream');
  const imu = (key) => (streams[key]?.samples?.length ? downsample3(streams[key].samples, accelHz, orientations[key]) : null);
  out.accl = imu('ACCL');
  out.gyro = imu('GYRO');
  return out;
}

function chapterHeader(filePath, info) {
  return {
    schema: SCHEMA,
    file: path.basename(filePath),
    fileSize: info.fileSize,
    mtimeMs: info.mtimeMs,
    durationSec: info.durationSec,
    creationTime: info.creationTime ? info.creationTime.toISOString() : null,
    video: info.video,
    camera: { model: null, firmware: info.udta?.firmware ?? null, lens: info.udta?.lens ?? null },
    settings: headerSettingsSummary(info.udta?.gpmfHeader),
    gps: null, accl: null, gyro: null,
    warnings: [],
  };
}

const streamCounts = ({ gps, accl, gyro }) => `gps=${gps?.n ?? 0} (${gps?.source ?? '-'}) accl=${accl?.n ?? 0} gyro=${gyro?.n ?? 0}`;

/** Decode + normalise the raw GPMF payloads of a chapter; a failure is a warning on the chapter, never an exception. */
async function decodeChapter(chapter, filePath, rawData, timing, accelHz) {
  let orientations = {};
  try { orientations = readStreamOrientations(rawData); } catch (e) { chapter.warnings.push(`orientation read failed: ${e.message}`); }
  try {
    return normalizeTelemetry(await decodeTelemetry({ rawData, timing }), { accelHz, orientations });
  } catch (e) {
    chapter.warnings.push(`telemetry decode failed: ${e.message}`);
    log.warn(`telemetry decode failed for ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Parse and normalise a single chapter file.
 * @param {string} filePath
 * @param {{ accelHz?: number, info?: object }} opts  `info`: an already-read `readMp4Info(filePath)` (with samples)
 */
export async function parseChapter(filePath, { accelHz = 25, info = null } = {}) {
  const t0 = Date.now();
  info ??= await readMp4Info(filePath);
  const chapter = chapterHeader(filePath, info);
  if (!info.gpmd?.samples?.length) {
    chapter.warnings.push('no GPMF track in file');
    return chapter;
  }
  const { rawData, timing } = await readGpmfTrack(filePath, info);
  const norm = await decodeChapter(chapter, filePath, rawData, timing, accelHz);
  if (!norm) return chapter;
  Object.assign(chapter, { gps: norm.gps, accl: norm.accl, gyro: norm.gyro });
  chapter.camera.model = norm.model;
  chapter.warnings.push(...norm.warnings);
  log.info(`parsed ${chapter.file}: ${streamCounts(norm)} raw=${rawData.length}B in ${Date.now() - t0} ms`);
  return chapter;
}

/* ---------- stats ---------- */

function emptyStats(totalPoints) {
  return {
    validPoints: 0, speedPoints: 0, totalPoints, distanceM: 0, movingTimeSec: 0, maxSpeedMs: 0, avgSpeedMs: 0,
    elevGainM: 0, elevLossM: 0, minAltM: null, maxAltM: null, fixCounts: { none: 0, fix2d: 0, fix3d: 0 },
  };
}

/** Samples per reported fix quality: 3D, 2D, and everything else (no lock, no report, an odd value). */
function fixHistogram(gps) {
  const counts = { none: 0, fix2d: 0, fix3d: 0 };
  for (let i = 0; i < gps.n; i++) {
    const fix = gps.fix[i];
    if (fix >= 3) counts.fix3d++;
    else if (fix === 2) counts.fix2d++;
    else counts.none++;
  }
  return counts;
}

/** Min/max altitude plus hysteresis-filtered gain/loss (a change counts once it exceeds the threshold). */
function trackElevation(st, alt, elev, thresholdM) {
  if (alt == null) return;
  st.minAltM = st.minAltM == null ? alt : Math.min(st.minAltM, alt);
  st.maxAltM = st.maxAltM == null ? alt : Math.max(st.maxAltM, alt);
  if (elev.ref == null) elev.ref = alt;
  else if (alt - elev.ref >= thresholdM) { st.elevGainM += alt - elev.ref; elev.ref = alt; }
  else if (elev.ref - alt >= thresholdM) { st.elevLossM += elev.ref - alt; elev.ref = alt; }
}

/** Elevation figures over the samples with a 3D fix — a 2D fix carries no altitude worth the name. */
function elevationStats(st, gps, runs, thresholdM) {
  const elev = { ref: null };
  for (const { start, end } of runs) {
    for (let i = start; i <= end; i++) if (gps.fix[i] >= 3) trackElevation(st, gps.alt[i], elev, thresholdM);
  }
}

/**
 * Ride statistics over the positioned samples, run by run: distance never bridges a stretch
 * the receiver could not position (the same runs the map draws and GeoJSON exports), speeds
 * come from the samples with a steady fix, elevation from 3D fixes.
 */
export function computeStats(gps, { minFix = 2, elevThresholdM = 3, movingSpeedMs = 0.5 } = {}) {
  const st = emptyStats(gps?.n ?? 0);
  if (!gps || !gps.n) return st;
  const speedOk = gps.speedOk ?? speedOkFlags(gps, { minFix });
  const runs = positionRuns(gps, { minFix });
  addRunStats(st, gps, runs, { speedOk, movingSpeedMs });
  st.fixCounts = fixHistogram(gps);
  elevationStats(st, gps, runs, elevThresholdM);
  for (const k of ['distanceM', 'movingTimeSec', 'maxSpeedMs', 'avgSpeedMs', 'elevGainM', 'elevLossM']) st[k] = round(st[k], 2);
  return st;
}

/** Distance, moving time and the speed summary of every run, folded into `st`. */
function addRunStats(st, gps, runs, opts) {
  let speedSum = 0;
  for (const run of runs) {
    const r = runStats(gps, run, opts);
    st.validPoints += run.end - run.start + 1;
    st.distanceM += r.distanceM; st.movingTimeSec += r.movingTimeSec;
    st.maxSpeedMs = Math.max(st.maxSpeedMs, r.maxSpeedMs);
    speedSum += r.avgSpeedMs * r.speedPoints; st.speedPoints += r.speedPoints;
  }
  st.avgSpeedMs = st.speedPoints ? speedSum / st.speedPoints : 0;
}

/* ---------- merge ---------- */

/** Column-wise concatenation (a plain loop: spreading a long chapter into push() overflows the stack). */
function concatColumns(parts, keys) {
  const out = {};
  for (const k of keys) out[k] = [];
  for (const p of parts) for (const k of keys) if (p[k]) for (const v of p[k]) out[k].push(v);
  return out;
}

/** Stream copy with its time column shifted into recording time. */
function shifted(stream, offsetSec) {
  return { ...stream, t: stream.t.map((t) => round(t + offsetSec, 4)) };
}

/** Concatenate per-chapter streams; `header(first)` supplies the scalar fields of the merged stream. */
function mergeStreams(parts, columns, header) {
  if (!parts.length) return null;
  const out = { ...header(parts[0]), ...concatColumns(parts, columns) };
  out.n = out.t.length;
  return out;
}

const imuHeader = (first) => ({ hz: first.hz, frame: first.frame, orientation: first.orientation });

function chapterSummary(chapter, data) {
  const { id, file, index, offsetSec, durationSec } = chapter;
  return { id, file, index, offsetSec, durationSec, gpsPoints: data.gps?.n ?? 0, gpsSource: data.gps?.source ?? null, warnings: data.warnings };
}

/** The camera of a recording: the first chapter that names a model, else the first that says anything. */
function cameraOf(items) {
  const cameras = items.map((it) => it.data.camera).filter(Boolean);
  const camera = cameras.find((c) => c.model) ?? cameras.find((c) => c.firmware || c.lens);
  return { model: null, firmware: null, lens: null, ...camera };
}

/**
 * utc = t*1000 + offset, anchored on the first GPS sample with a real fix (GPS time is
 * only trustworthy once the receiver has locked), else on any dated sample.
 */
function gpsUtcOffset(gps) {
  if (!gps) return null;
  let anyIdx = -1;
  for (let i = 0; i < gps.n; i++) {
    if (gps.utc[i] == null) continue;
    if (anyIdx < 0) anyIdx = i;
    if (gps.fix[i] == null || gps.fix[i] >= 2) return gps.utc[i] - gps.t[i] * 1000;
  }
  return anyIdx >= 0 ? gps.utc[anyIdx] - gps.t[anyIdx] * 1000 : null;
}

/**
 * Wall-clock alignment of the recording: GPS time when available, otherwise the camera
 * clock — the creation time as it is when the camera writes UTC (HERO12+), corrected by
 * the header time zone (TZON) when it writes local time (see camera-clock.js).
 */
function utcAlignment(gps, settings, creationTime) {
  const fromGps = gpsUtcOffset(gps);
  if (fromGps != null) return { utcOffsetMs: fromGps, utcSource: 'gps' };
  const clockMs = Date.parse(creationTime ?? '');
  const tz = settings?.tzMinutes;
  if (!Number.isFinite(clockMs)) return { utcOffsetMs: null, utcSource: null };
  if (clockConvention({ creationTime, settings }) === 'utc') return { utcOffsetMs: clockMs, utcSource: 'camera-clock' };
  if (tz != null) return { utcOffsetMs: clockMs - tz * 60000, utcSource: 'camera-clock' };
  return { utcOffsetMs: null, utcSource: null };
}

/**
 * Attach the speed-quality flags to the merged stream, so the UI and the statistics read
 * one answer. Derived here rather than per chapter: the rule spans chapter boundaries.
 */
function withSpeedFlags(gps) {
  if (gps) gps.speedOk = Array.from(speedOkFlags(gps));
  return gps;
}

/** Per-chapter streams shifted into recording time, plus the chapter summaries and warnings. */
function collectParts(items) {
  const parts = { gps: [], accl: [], gyro: [] };
  const chapters = []; const warnings = [];
  for (const { chapter, data } of items) {
    chapters.push(chapterSummary(chapter, data));
    for (const w of data.warnings || []) warnings.push(`${chapter.file}: ${w}`);
    for (const key of Object.keys(parts)) if (data[key]) parts[key].push(shifted(data[key], chapter.offsetSec));
  }
  return { parts, chapters, warnings };
}

/**
 * Merge per-chapter telemetry into one recording timeline.
 * @param {Array<{ chapter: object, data: object }>} items ordered by chapter index
 */
export function mergeChapters(recording, items) {
  const { parts, chapters, warnings } = collectParts(items);
  const settings = items.map((it) => it.data.settings).find(Boolean) ?? null;
  const altitudeSystem = parts.gps.find((g) => g.altitudeSystem)?.altitudeSystem ?? null;
  const gps = withSpeedFlags(mergeStreams(parts.gps, GPS_COLUMNS, (first) => ({ source: first.source, hz: first.hz, altitudeSystem })));
  const { utcOffsetMs, utcSource } = utcAlignment(gps, settings, items[0]?.data?.creationTime);
  return {
    schema: SCHEMA,
    recordingId: recording.id,
    name: recording.name,
    camera: cameraOf(items),
    video: { codec: recording.codec, width: recording.width, height: recording.height, fps: recording.fps, durationSec: recording.durationSec },
    startTimeCamera: recording.startTime,
    settings,
    utcOffsetMs,
    utcSource,
    chapters,
    gps,
    accl: mergeStreams(parts.accl, IMU_COLUMNS, imuHeader),
    gyro: mergeStreams(parts.gyro, IMU_COLUMNS, imuHeader),
    stats: computeStats(gps),
    warnings,
  };
}

/* ---------- cache + service ---------- */

export class TelemetryService {
  constructor({ cacheDir, accelHz = 25 }) {
    this.cacheDir = path.join(cacheDir, 'telemetry');
    this.accelHz = accelHz;
    this.inflight = new Map(); // cache key → pending parse, so concurrent requests share one decode
  }

  #cacheFile(chapter) {
    const created = chapter.creationTime ? Date.parse(chapter.creationTime) : 0;
    const key = shortId('tel', chapter.path, String(chapter.sizeBytes), String(Math.round(created)), `v${CACHE_VERSION}`, `hz${this.accelHz}`);
    return path.join(this.cacheDir, `${key}.json`);
  }

  async #parseAndCache(chapter, cacheFile) {
    const data = await parseChapter(chapter.path, { accelHz: this.accelHz });
    await writeJsonCache(cacheFile, data, log);
    return data;
  }

  async chapterTelemetry(chapter) {
    const cacheFile = this.#cacheFile(chapter);
    const cached = await readJsonCache(cacheFile, (c) => c.schema === SCHEMA && c.fileSize === chapter.sizeBytes);
    if (cached) return cached;
    if (!this.inflight.has(cacheFile)) {
      this.inflight.set(cacheFile, this.#parseAndCache(chapter, cacheFile).finally(() => this.inflight.delete(cacheFile)));
    }
    return this.inflight.get(cacheFile);
  }

  async recordingTelemetry(recording) {
    const items = [];
    for (const chapter of recording.chapters) items.push({ chapter, data: await this.chapterTelemetry(chapter) });
    return mergeChapters(recording, items);
  }
}
