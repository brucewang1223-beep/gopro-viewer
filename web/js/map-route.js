/**
 * Route geometry for the MapLibre map.
 *
 * A track becomes one GeoJSON LineString per "run" — a stretch of valid GPS fixes,
 * split on time gaps. Alongside the coordinates each run carries:
 *
 *   cum      fraction along the run (0…1) for every point, measured in Web-Mercator
 *            units so it lines up exactly with MapLibre's `line-progress`;
 *   ramp     step ramp of speed colours, dimRamp the same colours dimmed.
 *
 * Playback then moves a single cut point along a `line-gradient` instead of pushing
 * new geometry at the renderer, so a 60 000-point drive costs the same as a short one.
 * Everything here is pure — no DOM, no MapLibre — and unit tested.
 */

import { speedColor, percentile, clamp, lowerIndex } from './util.js';

export const ROUTE = Object.freeze({
  travelled: 'rgba(76,194,255,0.95)',
  remaining: 'rgba(163,173,193,0.62)',
  casing: 'rgba(8,20,27,0.55)',
});

const SPEED_BUCKETS = 8;
const RAMP_SAMPLES = 96;  // a line-gradient is rasterised into 256 px: more stops buy nothing
const DIM = 0.34;         // colour kept by the not-yet-driven part in speed mode
const BACKDROP = [15, 17, 21];
const EPS = 1e-4;         // smallest gap between two gradient stops

/** Cut points within one stop-gap of an end belong to that end: no degenerate stops. */
const snapCut = (p) => (p < EPS ? 0 : p > 1 - EPS ? 1 : p);

/* ---------- geometry ---------- */

/** Web-Mercator position in world units (x and y both span 1 across the globe). */
function mercator([lon, lat]) {
  const phi = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return [lon / 360, -Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

/** Distance of every point along a line, as a fraction of the whole (0 … 1). */
function cumulativeFraction(coordinates) {
  const cum = new Float64Array(coordinates.length);
  let prev = mercator(coordinates[0]);
  let total = 0;
  for (let k = 1; k < coordinates.length; k++) {
    const cur = mercator(coordinates[k]);
    total += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    cum[k] = total;
    prev = cur;
  }
  if (total > 0) for (let k = 0; k < cum.length; k++) cum[k] /= total;
  return cum;
}

/** Speed bucket per GPS point (0 … SPEED_BUCKETS-1, scaled to the 97th percentile). */
function speedBuckets(gps) {
  const vmax = Math.max(1, percentile(gps.speed2d, 0.97));
  const buckets = new Int8Array(gps.n);
  for (let i = 0; i < gps.n; i++) buckets[i] = Math.min(SPEED_BUCKETS - 1, Math.floor(((gps.speed2d[i] ?? 0) / vmax) * SPEED_BUCKETS));
  return buckets;
}

/** Blend a colour towards the panel backdrop. */
function dim(color) {
  const [r, g, b] = color.match(/\d+/g).map(Number);
  const mix = (v, i) => Math.round(BACKDROP[i] + (v - BACKDROP[i]) * DIM);
  return `rgb(${mix(r, 0)},${mix(g, 1)},${mix(b, 2)})`;
}

/** Step ramp of speed colours along one run: [fraction, colour], ascending, first at 0. */
function speedRamp(cum, buckets) {
  const stops = [];
  for (let s = 0; s < RAMP_SAMPLES; s++) {
    const f = s / RAMP_SAMPLES;
    const color = speedColor((buckets[Math.max(0, lowerIndex(cum, f))] + 0.5) / SPEED_BUCKETS);
    if (!stops.length || stops[stops.length - 1][1] !== color) stops.push([f, color]);
  }
  return stops;
}

/**
 * Runs, index maps and GeoJSON for a track.
 * @returns {{ runs: Array, geojson: object, bounds: [[number,number],[number,number]]|null,
 *   runOf: Int32Array, posOf: Int32Array, prevDrawn: Int32Array }}
 */
export function buildRoute(track) {
  const gps = track.gps;
  const buckets = speedBuckets(gps);
  const runOf = new Int32Array(gps.n).fill(-1);
  const posOf = new Int32Array(gps.n).fill(-1);
  const runs = [];

  for (const range of track.runs()) {
    const points = [];
    for (let i = range.start; i <= range.end; i++) if (track.valid[i]) points.push(i);
    if (points.length < 2) continue;               // a lone fix cannot be drawn as a line
    const r = runs.length;
    points.forEach((i, pos) => { runOf[i] = r; posOf[i] = pos; });
    const coordinates = points.map((i) => [gps.lon[i], gps.lat[i]]);
    const cum = cumulativeFraction(coordinates);
    const ramp = speedRamp(cum, points.map((i) => buckets[i]));
    runs.push({ coordinates, cum, ramp, dimRamp: ramp.map(([f, c]) => [f, dim(c)]) });
  }

  const prevDrawn = new Int32Array(gps.n).fill(-1);
  for (let i = 0, last = -1; i < gps.n; i++) { if (runOf[i] >= 0) last = i; prevDrawn[i] = last; }

  return { runs, runOf, posOf, prevDrawn, bounds: boundsOf(runs), geojson: featureCollection(runs) };
}

const featureCollection = (runs) => ({
  type: 'FeatureCollection',
  features: runs.map((run, r) => ({ type: 'Feature', properties: { run: r }, geometry: { type: 'LineString', coordinates: run.coordinates } })),
});

function boundsOf(runs) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const run of runs) {
    for (const [lon, lat] of run.coordinates) {
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/** Fraction along run `r` of a position between points `pos` and `pos + 1`. */
export function fractionAlong(run, pos, [lon, lat]) {
  const next = pos + 1;
  if (next >= run.coordinates.length) return 1;
  const a = mercator(run.coordinates[pos]);
  const b = mercator(run.coordinates[next]);
  const p = mercator([lon, lat]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const k = len > 0 ? clamp(Math.hypot(p[0] - a[0], p[1] - a[1]) / len, 0, 1) : 0;
  return run.cum[pos] + (run.cum[next] - run.cum[pos]) * k;
}

/* ---------- gradients ---------- */

/** Colour of a step ramp at fraction f (the last stop at or before f). */
function rampColorAt(ramp, f) {
  let color = ramp[0][1];
  for (const [stop, c] of ramp) { if (stop > f) break; color = c; }
  return color;
}

/**
 * One ramp up to `cut`, the other after it, with a hard edge between them.
 * Colours stay geographically anchored: only the cut moves during playback.
 */
export function spliceRamps(before, after, cut) {
  const p = snapCut(clamp(cut, 0, 1));
  const stops = [];
  if (p > 0) {
    stops.push([0, before[0][1]], ...before.filter(([f]) => f > 0 && f < p));
    if (p < 1) stops.push([p, rampColorAt(before, p)]);
  }
  if (p < 1) {
    const from = p > 0 ? p + EPS : 0;
    stops.push([from, rampColorAt(after, from)], ...after.filter(([f]) => f > from));
  }
  return stops;
}

/** MapLibre `line-gradient` expression for a step ramp. */
export function gradientExpression(ramp) {
  const stops = [];
  const push = (at, color) => {
    const f = Math.min(1, at);                       // compare after clamping, or 1 can be pushed twice
    if (!stops.length || f > stops[stops.length - 1][0]) stops.push([f, color]);
  };
  ramp.forEach(([f, color], i) => {
    if (i > 0) push(f, ramp[i - 1][1]);   // hold the previous colour right up to the step
    push(i === 0 ? 0 : f + EPS, color);
  });
  if (stops.length < 2) push(1, stops[0][1]);
  return ['interpolate', ['linear'], ['line-progress'], ...stops.flat()];
}

/** Gradient for one run: driven part up to `progress`, undriven after it. */
export function runGradient(run, { colorBySpeed = false, progress = 0 } = {}) {
  const before = colorBySpeed ? run.ramp : [[0, ROUTE.travelled]];
  const after = colorBySpeed ? run.dimRamp : [[0, ROUTE.remaining]];
  return gradientExpression(spliceRamps(before, after, progress));
}
