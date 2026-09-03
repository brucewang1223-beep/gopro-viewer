/**
 * Export helpers: GPX 1.1 track and CSV tables from merged recording telemetry.
 * Points with fix < minFix (default 2) are excluded from GPX; CSV keeps everything and includes the fix column.
 */

import { hasPosition } from './telemetry.js';

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
