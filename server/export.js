/**
 * Export helpers: GPX 1.1 track, GeoJSON FeatureCollection and CSV tables from merged
 * recording telemetry. Points with fix < minFix (default 2) are excluded from GPX and
 * GeoJSON; CSV keeps every sample and includes the fix column.
 */

import { haversineM, hasPosition, positionRuns } from './geo.js';

const GPS_COLUMNS = ['t_sec', 'utc_iso', 'lat', 'lon', 'alt_m', 'speed2d_ms', 'speed3d_ms', 'fix', 'dop'];
const GPX_HEAD = '<gpx version="1.1" creator="gopro-viewer" xmlns="http://www.topografix.com/GPX/1/1"'
  + ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">';

const iso = (ms) => (ms != null ? new Date(ms).toISOString() : null);

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function trackPoint(gps, i) {
  const ele = gps.alt[i] != null ? `<ele>${gps.alt[i]}</ele>` : '';
  const time = gps.utc[i] != null ? `<time>${iso(gps.utc[i])}</time>` : '';
  const speed = gps.speed2d[i] != null
    ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${gps.speed2d[i]}</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions>`
    : '';
  return `    <trkpt lat="${gps.lat[i]}" lon="${gps.lon[i]}">${ele}${time}${speed}</trkpt>`;
}

function trackPoints(gps, minFix) {
  const lines = [];
  if (!gps) return lines;
  for (let i = 0; i < gps.n; i++) if (hasPosition(gps, i, minFix)) lines.push(trackPoint(gps, i));
  return lines;
}

export function toGpx(tel, { minFix = 2 } = {}) {
  const name = xmlEscape(tel.name || 'GoPro track');
  const start = tel.utcOffsetMs != null ? `<time>${iso(tel.utcOffsetMs)}</time>` : '';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    GPX_HEAD,
    `  <metadata><name>${name}</name>${start}</metadata>`,
    `  <trk><name>${name}</name><src>${xmlEscape(tel.camera?.model || 'GoPro')}</src><trkseg>`,
    ...trackPoints(tel.gps, minFix),
    '  </trkseg></trk>',
    '</gpx>',
  ];
  return lines.join('\n') + '\n';
}

/* ---------- GeoJSON ---------- */

const COORD_DECIMALS = 7;  // ~11 mm, past GPS precision
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** [lon, lat] or [lon, lat, alt] — GeoJSON positions are x, y, z. */
function position(gps, i) {
  const p = [round(gps.lon[i], COORD_DECIMALS), round(gps.lat[i], COORD_DECIMALS)];
  if (gps.alt[i] != null) p.push(round(gps.alt[i], 2));
  return p;
}

/** Per-run geometry plus the parallel per-point arrays kept in coordinateProperties. */
function runGeometry(gps, run) {
  const coordinates = []; const times = []; const speeds = [];
  let distanceM = 0; let maxSpeedMs = 0; let speedSum = 0; let prev = -1;
  for (let i = run.start; i <= run.end; i++) {
    if (!hasPosition(gps, i)) continue;
    coordinates.push(position(gps, i));
    times.push(gps.utc[i] != null ? iso(gps.utc[i]) : null);
    const speed = gps.speed2d[i] ?? null;
    speeds.push(speed);
    maxSpeedMs = Math.max(maxSpeedMs, speed ?? 0);
    speedSum += speed ?? 0;
    if (prev >= 0) distanceM += haversineM(gps.lat[prev], gps.lon[prev], gps.lat[i], gps.lon[i]);
    prev = i;
  }
  const n = coordinates.length;
  return {
    coordinates, times, speeds, n,
    distanceM: round(distanceM, 2),
    durationSec: round(gps.t[run.end] - gps.t[run.start], 3),
    maxSpeedMs: round(maxSpeedMs, 3),
    avgSpeedMs: n ? round(speedSum / n, 3) : 0,
  };
}

const stabilizationLabel = (stab) => {
  if (!stab) return null;
  return stab.enabled ? (stab.mode || 'On') : 'Off';
};

function cameraProperties(tel) {
  return {
    camera: tel.camera?.model ?? tel.settings?.model ?? null,
    firmware: tel.camera?.firmware ?? null,
    fov: tel.settings?.fov?.name ?? null,
    hyperSmooth: stabilizationLabel(tel.settings?.stabilization),
  };
}

/** Recording-level properties repeated on every feature so each one stands alone in GIS tools. */
function recordingProperties(tel) {
  return {
    recording: tel.name ?? null,
    recordingId: tel.recordingId ?? null,
    gpsSource: tel.gps?.source ?? null,
    altitudeSystem: tel.gps?.altitudeSystem ?? null,
    ...cameraProperties(tel),
  };
}

function runFeature(tel, gps, run, index, runCount) {
  const geom = runGeometry(gps, run);
  const suffix = runCount > 1 ? ` (${index + 1}/${runCount})` : '';
  return {
    type: 'Feature',
    properties: {
      name: `${tel.name ?? 'GoPro track'}${suffix}`,
      ...recordingProperties(tel),
      points: geom.n,
      distanceM: geom.distanceM,
      durationSec: geom.durationSec,
      maxSpeedMs: geom.maxSpeedMs,
      avgSpeedMs: geom.avgSpeedMs,
      startTime: geom.times[0] ?? null,
      endTime: geom.times[geom.times.length - 1] ?? null,
      videoStartSec: round(gps.t[run.start], 3),
      videoEndSec: round(gps.t[run.end], 3),
      // parallel arrays, one entry per coordinate (the convention used by togeojson)
      coordinateProperties: { times: geom.times, speeds: geom.speeds },
    },
    geometry: { type: 'LineString', coordinates: geom.coordinates },
  };
}

/**
 * The driven route as a GeoJSON FeatureCollection: one LineString feature per contiguous
 * run of positioned samples (a lost fix or a gap longer than `maxGapSec` starts a new one),
 * with altitude as the third ordinate and per-point times/speeds in `coordinateProperties`.
 * @param {object} tel merged telemetry
 * @param {{ minFix?: number, maxGapSec?: number }} [opts]
 */
export function toGeoJson(tel, { minFix = 2, maxGapSec = 5 } = {}) {
  const gps = tel.gps;
  const runs = gps ? positionRuns(gps, { minFix, maxGapSec }) : [];
  const features = runs
    .map((run, i) => runFeature(tel, gps, run, i, runs.length))
    .filter((f) => f.geometry.coordinates.length > 1);
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 1) + '\n';
}

/* ---------- CSV ---------- */

function csvTable(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map((v) => (v == null ? '' : String(v))).join(','));
  return lines.join('\n') + '\n';
}

const gpsRows = (g) => Array.from({ length: g.n }, (_, i) => [g.t[i], iso(g.utc[i]), g.lat[i], g.lon[i], g.alt[i], g.speed2d[i], g.speed3d[i], g.fix[i], g.dop[i]]);
const imuRows = (s) => Array.from({ length: s.n }, (_, i) => [s.t[i], s.x[i], s.y[i], s.z[i], s.mag[i], s.magMax[i]]);

/**
 * @param {object} tel merged telemetry
 * @param {'gps'|'accl'|'gyro'} stream
 */
export function toCsv(tel, stream = 'gps') {
  if (stream === 'gps') return csvTable(GPS_COLUMNS, tel.gps ? gpsRows(tel.gps) : []);
  const unit = stream === 'accl' ? 'ms2' : 'rads';
  const header = ['t_sec', ...['x', 'y', 'z', 'mag', 'magmax'].map((c) => `${c}_${unit}`)];
  return csvTable(header, tel[stream] ? imuRows(tel[stream]) : []);
}
