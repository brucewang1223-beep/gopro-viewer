/**
 * Client-side view over merged telemetry: fast lookups by global time.
 * GPS samples with fix < minFix are treated as invalid for positioning (but still charted).
 */

import { lowerIndex, bearingDeg } from './util.js';

export class Track {
  constructor(tel, { minFix = 2 } = {}) {
    this.tel = tel;
    this.gps = tel.gps;
    this.accl = tel.accl;
    this.minFix = minFix;
    this.valid = this.gps ? this.gps.t.map((_, i) => this.isValid(i)) : [];
    this.validCount = this.valid.filter(Boolean).length;
    this.utcOffsetMs = tel.utcOffsetMs;
    this.duration = tel.video?.durationSec ?? (this.gps?.n ? this.gps.t[this.gps.n - 1] : 0);
  }

  get hasGps() { return !!(this.gps && this.validCount > 1); }

  isValid(i) {
    const g = this.gps;
    if (!g || g.lat[i] == null || g.lon[i] == null) return false;
    const f = g.fix[i];
    if (f != null && f < this.minFix) return false;
    // reject the (0,0) island and wildly implausible coordinates
    if (Math.abs(g.lat[i]) < 1e-6 && Math.abs(g.lon[i]) < 1e-6) return false;
    return Math.abs(g.lat[i]) <= 90 && Math.abs(g.lon[i]) <= 180;
  }

  /**
   * Interpolated GPS state at global time t.
   * @returns {{ i:number, lat:number, lon:number, alt:number, speed2d:number, speed3d:number, fix:number|null,
   *   dop:number|null, heading:number|null, valid:boolean, utc:number|null } | null}
   */
  sampleAt(t) {
    const g = this.gps;
    if (!g || !g.n) return null;
    let i = lowerIndex(g.t, t);
    if (i < 0) i = 0;
    const j = Math.min(i + 1, g.n - 1);
    const t0 = g.t[i]; const t1 = g.t[j];
    let k = 0;
    if (j !== i && t1 > t0 && t >= t0 && t <= t1 && (t1 - t0) < 2.5) k = (t - t0) / (t1 - t0);
    const both = this.valid[i] && this.valid[j];
    const lerp = (a, b) => (a == null ? b : b == null ? a : a + (b - a) * k);
    const out = {
      i, valid: this.valid[i],
      lat: both ? lerp(g.lat[i], g.lat[j]) : g.lat[i],
      lon: both ? lerp(g.lon[i], g.lon[j]) : g.lon[i],
      alt: lerp(g.alt[i], g.alt[j]),
      speed2d: lerp(g.speed2d[i], g.speed2d[j]),
      speed3d: lerp(g.speed3d[i], g.speed3d[j]),
      fix: g.fix[i], dop: g.dop[i],
      utc: this.utcOffsetMs != null ? this.utcOffsetMs + t * 1000 : g.utc[i],
      heading: null,
    };
    out.heading = this.headingAt(i);
    return out;
  }

  /** Heading from a small window around index i (null when stationary or invalid). */
  headingAt(i) {
    const g = this.gps;
    const a = Math.max(0, i - 2); const b = Math.min(g.n - 1, i + 2);
    if (!this.valid[a] || !this.valid[b] || a === b) return null;
    const speed = g.speed2d[i] ?? 0;
    if (speed < 0.7) return null;
    return bearingDeg(g.lat[a], g.lon[a], g.lat[b], g.lon[b]);
  }

  /** Nearest valid GPS index to a map coordinate (cheap planar distance, fine at track scale). */
  nearestToLatLng(lat, lon) {
    const g = this.gps;
    if (!g) return -1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    let best = -1; let bestD = Infinity;
    for (let i = 0; i < g.n; i++) {
      if (!this.valid[i]) continue;
      const dy = g.lat[i] - lat; const dx = (g.lon[i] - lon) * cosLat;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Contiguous runs of valid points for drawing, split on time gaps > maxGapSec.
   * @returns {Array<{ start:number, end:number }>} inclusive index ranges
   */
  runs(maxGapSec = 5) {
    const g = this.gps; const out = [];
    if (!g) return out;
    let start = -1; let prev = -1;
    for (let i = 0; i < g.n; i++) {
      if (!this.valid[i]) continue;
      if (start < 0) start = i;
      else if (g.t[i] - g.t[prev] > maxGapSec) { out.push({ start, end: prev }); start = i; }
      prev = i;
    }
    if (start >= 0) out.push({ start, end: prev });
    return out;
  }
}
