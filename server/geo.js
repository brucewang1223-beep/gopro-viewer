/**
 * Geodesic helpers shared by the telemetry pipeline and the exporters, plus the rule
 * that decides which GPS samples carry a speed worth showing (`speedOkFlags`).
 */

const R_EARTH = 6371008.8;

export function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad; const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Whether GPS sample i carries a usable position: the receiver reported a fix of at
 * least `minFix` (2 = 2D, 3 = 3D) and the coordinates are there. A sample without a
 * reported fix is not positioned — the camera writes coordinates before it has a lock.
 */
export function hasPosition(gps, i, minFix = 2) {
  if (!(gps.fix[i] >= minFix)) return false;
  return gps.lat[i] != null && gps.lon[i] != null;
}

/**
 * Contiguous runs of positioned samples, split where the receiver lost its fix or
 * where more than `maxGapSec` passed between samples.
 * @returns {Array<{ start: number, end: number }>} inclusive index ranges, all positioned
 */
export function positionRuns(gps, { minFix = 2, maxGapSec = 5 } = {}) {
  const runs = [];
  if (!gps?.n) return runs;
  let start = -1; let prev = -1;
  for (let i = 0; i < gps.n; i++) {
    if (!hasPosition(gps, i, minFix)) { if (start >= 0) runs.push({ start, end: prev }); start = -1; continue; }
    if (start < 0) start = i;
    else if (gps.t[i] - gps.t[prev] > maxGapSec) { runs.push({ start, end: prev }); start = i; }
    prev = i;
  }
  if (start >= 0) runs.push({ start, end: prev });
  return runs;
}

/* ---------- speed quality ---------- */

/**
 * How good the fix behind a speed reading has to be.
 *   maxDop        highest DOP a sample may carry (a stream that reports no DOP passes).
 *   maxDipSec     a dip above maxDop shorter than this, with good samples on both sides,
 *                 is ignored — on a normal city drive DOP crosses 3 for a tenth of a
 *                 second at a time, and a bare per-sample threshold shreds the line.
 *   minSteadySec  an island of good samples shorter than this is dropped: a receiver that
 *                 has just come back for half a second has not proven anything yet, and
 *                 the speed it reports is still the stale one it froze on.
 * Measured on Bruce's HERO13 (GPS9): driving sits at DOP 1.42 (p50) / 3.17 (p99), the
 * implausible readings start at 3.65, 17 of the 20 weak stretches last under a second,
 * and the longest is 7.1 s. These three values leave his drive as one unbroken line and
 * still take the maximum from 271.8 km/h to 54.7 km/h.
 */
export const SPEED_QUALITY = Object.freeze({ maxDop: 3, maxDipSec: 2, minSteadySec: 3 });

/** Flip a short dip in geometry back to good when it sits between two good samples. */
function closeDips(gps, ok, minFix, maxDipSec) {
  let start = -1;
  for (let i = 0; i < gps.n; i++) {
    if (!ok[i] && hasPosition(gps, i, minFix)) { if (start < 0) start = i; continue; }
    if (start >= 0 && ok[i] && start > 0 && ok[start - 1] && gps.t[i - 1] - gps.t[start] < maxDipSec) ok.fill(1, start, i);
    start = -1;
  }
}

/** Drop stretches of good samples too short to show the fix is really back. */
function dropShortRuns(gps, ok, minSteadySec) {
  let start = -1;
  for (let i = 0; i <= gps.n; i++) {
    if (i < gps.n && ok[i]) { if (start < 0) start = i; continue; }
    if (start >= 0 && gps.t[i - 1] - gps.t[start] < minSteadySec) ok.fill(0, start, i);
    start = -1;
  }
}

/**
 * Which samples carry a speed worth showing: positioned, with steady fix geometry.
 * A receiver that has lost its lock repeats its last speed, so the rule is about the
 * fix behind the number rather than the number itself.
 * @returns {Uint8Array} 1 per usable sample
 */
export function speedOkFlags(gps, { minFix = 2, ...quality } = {}) {
  const { maxDop, maxDipSec, minSteadySec } = { ...SPEED_QUALITY, ...quality };
  const n = gps?.n ?? 0;
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = hasPosition(gps, i, minFix) && !(gps.dop[i] > maxDop) ? 1 : 0;
  closeDips(gps, ok, minFix, maxDipSec);
  dropShortRuns(gps, ok, minSteadySec);
  return ok;
}
