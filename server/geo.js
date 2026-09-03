/** Geodesic helpers shared by the telemetry pipeline and the exporters. */

const R_EARTH = 6371008.8;

export function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad; const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Whether GPS sample i carries a usable position (fix at least `minFix`, coordinates present). */
export function hasPosition(gps, i, minFix = 2) {
  const fix = gps.fix[i];
  if (fix != null && fix < minFix) return false;
  return gps.lat[i] != null && gps.lon[i] != null;
}

/**
 * Contiguous runs of positioned samples, split where the receiver lost its fix or
 * where more than `maxGapSec` passed between samples.
 * @returns {Array<{ start: number, end: number }>} inclusive index ranges
 */
export function positionRuns(gps, { minFix = 2, maxGapSec = 5 } = {}) {
  const runs = [];
  if (!gps?.n) return runs;
  let start = -1; let prev = -1;
  for (let i = 0; i < gps.n; i++) {
    if (!hasPosition(gps, i, minFix)) continue;
    if (start < 0) start = i;
    else if (gps.t[i] - gps.t[prev] > maxGapSec) { runs.push({ start, end: prev }); start = i; }
    prev = i;
  }
  if (start >= 0) runs.push({ start, end: prev });
  return runs;
}
