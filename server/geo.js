/**
 * Geodesic helpers shared by the telemetry pipeline and the exporters: which GPS samples
 * position the camera, how they group into runs, what a run adds up to, and the rule that
 * decides which samples carry a speed worth showing (`speedOkFlags`).
 */

const R_EARTH = 6371008.8;

/** Round to `d` decimals; null (and NaN) stay null. */
export const round = (v, d) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad; const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Whether GPS sample i carries a usable position: the receiver reported a fix of at
 * least `minFix` (2 = 2D, 3 = 3D) and the coordinates are finite, in range and not the
 * (0, 0) island a camera writes before it has a lock. A sample without a reported fix
 * is not positioned. The client applies the same rule (web/js/track.js).
 */
export function hasPosition(gps, i, minFix = 2) {
  if (!(gps.fix[i] >= minFix)) return false;
  const lat = gps.lat[i]; const lon = gps.lon[i];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
}

/**
 * Contiguous index ranges where `ok(i)` holds; `splitBefore(i)` starts a new range at i
 * even though i and i − 1 both qualify (a time gap, say).
 * @returns {Array<{ start: number, end: number }>} inclusive ranges
 */
export function runsWhere(n, ok, splitBefore = () => false) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (!ok(i)) { if (start >= 0) runs.push({ start, end: i - 1 }); start = -1; continue; }
    if (start < 0) start = i;
    else if (splitBefore(i)) { runs.push({ start, end: i - 1 }); start = i; }
  }
  if (start >= 0) runs.push({ start, end: n - 1 });
  return runs;
}

/**
 * Contiguous runs of positioned samples, split where the receiver lost its fix or
 * where more than `maxGapSec` passed between samples.
 * @returns {Array<{ start: number, end: number }>} inclusive index ranges, all positioned
 */
export function positionRuns(gps, { minFix = 2, maxGapSec = 5 } = {}) {
  if (!gps?.n) return [];
  return runsWhere(gps.n, (i) => hasPosition(gps, i, minFix), (i) => gps.t[i] - gps.t[i - 1] > maxGapSec);
}

/**
 * What one run of positioned samples adds up to: distance along it, time spent moving,
 * and the maximum / mean of the speeds worth trusting (`speedOk`, all of them when absent).
 * @param {{ start: number, end: number }} run
 * @param {{ speedOk?: ArrayLike<number>|null, movingSpeedMs?: number, maxLegSec?: number }} [opts]
 */
export function runStats(gps, { start, end }, { speedOk = null, movingSpeedMs = 0.5, maxLegSec = 5 } = {}) {
  const st = { distanceM: 0, movingTimeSec: 0, maxSpeedMs: 0, avgSpeedMs: 0, speedPoints: 0 };
  let speedSum = 0;
  for (let i = start; i <= end; i++) {
    const speed = !speedOk || speedOk[i] ? gps.speed2d[i] : null;
    if (speed != null) { st.maxSpeedMs = Math.max(st.maxSpeedMs, speed); speedSum += speed; st.speedPoints++; }
    if (i === start) continue;
    st.distanceM += haversineM(gps.lat[i - 1], gps.lon[i - 1], gps.lat[i], gps.lon[i]);
    if (isMovingLeg(gps, i, speed, movingSpeedMs, maxLegSec)) st.movingTimeSec += gps.t[i] - gps.t[i - 1];
  }
  st.avgSpeedMs = st.speedPoints ? speedSum / st.speedPoints : 0;
  return st;
}

/** The leg into sample i counts as moving time when its (trusted) speed is above walking pace and it is a normal-length leg. */
function isMovingLeg(gps, i, speed, movingSpeedMs, maxLegSec) {
  const dt = gps.t[i] - gps.t[i - 1];
  return speed != null && speed > movingSpeedMs && dt > 0 && dt < maxLegSec;
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

const spanSec = (gps, { start, end }) => gps.t[end] - gps.t[start];

/** Flip a short dip in geometry back to good when it sits between two good samples. */
function closeDips(gps, ok, minFix, maxDipSec) {
  for (const dip of runsWhere(gps.n, (i) => !ok[i] && hasPosition(gps, i, minFix))) {
    const enclosed = dip.start > 0 && ok[dip.start - 1] && dip.end + 1 < gps.n && ok[dip.end + 1];
    if (enclosed && spanSec(gps, dip) < maxDipSec) ok.fill(1, dip.start, dip.end + 1);
  }
}

/** Drop stretches of good samples too short to show the fix is really back. */
function dropShortRuns(gps, ok, minSteadySec) {
  for (const run of runsWhere(gps.n, (i) => ok[i])) {
    if (spanSec(gps, run) < minSteadySec) ok.fill(0, run.start, run.end + 1);
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
