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
import { haversineM, hasPosition } from './geo.js';
import { readJsonCache, writeJsonCache } from './json-cache.js';
import { shortId } from './ids.js';
import { createLogger } from './log.js';

const log = createLogger('telemetry');
export const SCHEMA = 'gopro-viewer.telemetry/1';
const CACHE_VERSION = 6; // bump when the chapter output changes

const GPS_COLUMNS = ['t', 'lat', 'lon', 'alt', 'speed2d', 'speed3d', 'fix', 'dop', 'utc'];
const IMU_COLUMNS = ['t', 'x', 'y', 'z', 'mag', 'magMax'];

const round = (v, d) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

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

/**
 * Downsample a 3-axis stream to `hz` by time-binning, re-expressed in the GoPro camera
 * frame (x = camera left, y = camera back, z = up) using the ORIN/ORIO mapping.
 * Output per bin: mean x/y/z, mean magnitude, max magnitude, bin centre time.
 */
function downsample3(samples, hz, orientation) {
  const width = 1 / hz;
  const mapping = cameraFrameMapping(orientation || {});
  const axis = Object.fromEntries(mapping.map.map((m) => [m.axis, m]));
  const bins = new Map();
  for (const s of samples) {
    if (!Array.isArray(s.value) || s.value.length < 3 || s.cts == null) continue;
    const x = axis.x.sign * s.value[axis.x.index];
    const y = axis.y.sign * s.value[axis.y.index];
    const z = axis.z.sign * s.value[axis.z.index];
    const mag = Math.sqrt(x * x + y * y + z * z);
    const key = Math.floor(s.cts / 1000 / width);
    let b = bins.get(key);
    if (!b) { b = { n: 0, x: 0, y: 0, z: 0, mag: 0, max: 0 }; bins.set(key, b); }
    b.n++; b.x += x; b.y += y; b.z += z; b.mag += mag; b.max = Math.max(b.max, mag);
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

function normalizeGps(stream, key) {
  const out = { source: key, n: 0, t: [], lat: [], lon: [], alt: [], speed2d: [], speed3d: [], fix: [], dop: [], utc: [], altitudeSystem: null };
  let state = { fix: null, dop: null };
  for (const s of stream.samples) {
    const v = s.value;
    if (!Array.isArray(v) || v.length < 5 || s.cts == null) continue;
    state = fixAndDop(key, s, state);
    if (s['altitude system'] && !out.altitudeSystem) out.altitudeSystem = s['altitude system'];
    out.t.push(round(s.cts / 1000, 4));
    out.lat.push(round(v[0], 7)); out.lon.push(round(v[1], 7)); out.alt.push(round(v[2], 2));
    out.speed2d.push(round(v[3], 3)); out.speed3d.push(round(v[4], 3));
    out.fix.push(state.fix == null ? null : Number(state.fix)); out.dop.push(state.dop == null ? null : round(state.dop, 2));
    out.utc.push(s.date ? new Date(s.date).getTime() : null);
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
  if (streams.ACCL?.samples?.length) out.accl = downsample3(streams.ACCL.samples, accelHz, orientations.ACCL);
  if (streams.GYRO?.samples?.length) out.gyro = downsample3(streams.GYRO.samples, accelHz, orientations.GYRO);
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

/**
 * Parse and normalise a single chapter file.
 * @param {string} filePath
 * @param {{ accelHz?: number }} opts
 */
export async function parseChapter(filePath, { accelHz = 25 } = {}) {
  const t0 = Date.now();
  const info = await readMp4Info(filePath);
  const chapter = chapterHeader(filePath, info);
  if (!info.gpmd?.samples?.length) {
    chapter.warnings.push('no GPMF track in file');
    return chapter;
  }
  const { rawData, timing } = await readGpmfTrack(filePath, info);
  let tel;
  try {
    tel = await decodeTelemetry({ rawData, timing });
  } catch (e) {
    chapter.warnings.push(`gopro-telemetry failed: ${e.message}`);
    log.warn(`gopro-telemetry failed for ${filePath}: ${e.message}`);
    return chapter;
  }
  let orientations = {};
  try { orientations = readStreamOrientations(rawData); } catch (e) { chapter.warnings.push(`orientation read failed: ${e.message}`); }
  const norm = normalizeTelemetry(tel, { accelHz, orientations });
  Object.assign(chapter, { gps: norm.gps, accl: norm.accl, gyro: norm.gyro });
  chapter.camera.model = norm.model;
  chapter.warnings.push(...norm.warnings);
  log.info(`parsed ${chapter.file}: ${streamCounts(norm)} raw=${rawData.length}B in ${Date.now() - t0} ms`);
  return chapter;
}

/* ---------- stats ---------- */

function emptyStats(totalPoints) {
  return {
    validPoints: 0, totalPoints, distanceM: 0, movingTimeSec: 0, maxSpeedMs: 0, avgSpeedMs: 0,
    elevGainM: 0, elevLossM: 0, minAltM: null, maxAltM: null, fixCounts: { none: 0, fix2d: 0, fix3d: 0 },
  };
}

function countFix(counts, fix) {
  if (fix == null || fix === 0) counts.none++;
  else if (fix === 2) counts.fix2d++;
  else counts.fix3d++;
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

/** Distance and moving time contributed by the leg from valid sample `prev` to `i`. */
function addLeg(st, gps, prev, i, movingSpeedMs) {
  if (prev < 0) return;
  const dt = gps.t[i] - gps.t[prev];
  st.distanceM += haversineM(gps.lat[prev], gps.lon[prev], gps.lat[i], gps.lon[i]);
  if ((gps.speed2d[i] ?? 0) > movingSpeedMs && dt > 0 && dt < 5) st.movingTimeSec += dt;
}

export function computeStats(gps, { minFix = 2, elevThresholdM = 3, movingSpeedMs = 0.5 } = {}) {
  const st = emptyStats(gps?.n ?? 0);
  if (!gps || !gps.n) return st;
  const elev = { ref: null };
  let prev = -1; let speedSum = 0;
  for (let i = 0; i < gps.n; i++) {
    countFix(st.fixCounts, gps.fix[i]);
    if (!hasPosition(gps, i, minFix)) continue;
    st.validPoints++;
    const speed = gps.speed2d[i] ?? 0;
    st.maxSpeedMs = Math.max(st.maxSpeedMs, speed);
    speedSum += speed;
    addLeg(st, gps, prev, i, movingSpeedMs);
    trackElevation(st, gps.alt[i], elev, elevThresholdM);
    prev = i;
  }
  st.avgSpeedMs = st.validPoints ? speedSum / st.validPoints : 0;
  for (const k of ['distanceM', 'movingTimeSec', 'maxSpeedMs', 'avgSpeedMs', 'elevGainM', 'elevLossM']) st[k] = round(st[k], 2);
  return st;
}

/* ---------- merge ---------- */

function concatColumns(parts, keys) {
  const out = {};
  for (const k of keys) out[k] = [];
  for (const p of parts) for (const k of keys) if (p[k]) out[k].push(...p[k]);
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
 * clock (creation time is local wall-clock) corrected by the header time zone (TZON,
 * minutes east of UTC).
 */
function utcAlignment(gps, settings, creationTime) {
  const fromGps = gpsUtcOffset(gps);
  if (fromGps != null) return { utcOffsetMs: fromGps, utcSource: 'gps' };
  const localMs = settings?.tzMinutes != null && creationTime ? Date.parse(creationTime) : NaN;
  if (Number.isFinite(localMs)) return { utcOffsetMs: localMs - settings.tzMinutes * 60000, utcSource: 'camera-clock' };
  return { utcOffsetMs: null, utcSource: null };
}

/**
 * Merge per-chapter telemetry into one recording timeline.
 * @param {Array<{ chapter: object, data: object }>} items ordered by chapter index
 */
export function mergeChapters(recording, items) {
  const parts = { gps: [], accl: [], gyro: [] };
  const chapters = []; const warnings = [];
  let camera = { model: null, firmware: null, lens: null };
  let settings = null;
  for (const { chapter, data } of items) {
    chapters.push(chapterSummary(chapter, data));
    for (const w of data.warnings || []) warnings.push(`${chapter.file}: ${w}`);
    if (!camera.model && data.camera?.model) camera = { ...camera, ...data.camera };
    settings ??= data.settings ?? null;
    for (const key of Object.keys(parts)) if (data[key]) parts[key].push(shifted(data[key], chapter.offsetSec));
  }
  const altitudeSystem = parts.gps.find((g) => g.altitudeSystem)?.altitudeSystem ?? null;
  const gps = mergeStreams(parts.gps, GPS_COLUMNS, (first) => ({ source: first.source, hz: first.hz, altitudeSystem }));
  const accl = mergeStreams(parts.accl, IMU_COLUMNS, imuHeader);
  const gyro = mergeStreams(parts.gyro, IMU_COLUMNS, imuHeader);
  const { utcOffsetMs, utcSource } = utcAlignment(gps, settings, items[0]?.data?.creationTime);
  return {
    schema: SCHEMA,
    recordingId: recording.id,
    name: recording.name,
    camera,
    video: { codec: recording.codec, width: recording.width, height: recording.height, fps: recording.fps, durationSec: recording.durationSec },
    startTimeCamera: recording.startTime,
    settings,
    utcOffsetMs,
    utcSource,
    chapters,
    gps, accl, gyro,
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
