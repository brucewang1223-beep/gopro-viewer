/**
 * Client-side view over merged telemetry: fast lookups by global time.
 * A sample positions the camera only when the receiver reported a fix of at least
 * minFix (2 = 2D, 3 = 3D). Everything else — no lock, or no fix reported at all —
 * is invalid for the map, the marker and the exports, but is still charted.
 *
 * A sample is `precise` when its speed can be trusted as well. That rule is about the
 * steadiness of the fix behind the number and is evaluated once on the server
 * (`gps.speedOk`, see `speedOkFlags` in server/geo.js); here it is only intersected with
 * the client's own validity so it can never be the looser of the two.
 */

import { lowerIndex, bearingDeg } from './util.js';

const MAX_SAMPLE_GAP_SEC = 2.5;   // beyond this from the nearest sample the stream has nothing to say

export class Track {
  constructor(tel, { minFix = 2 } = {}) {
    this.tel = tel;
    this.gps = tel.gps;
    this.accl = tel.accl;
    this.minFix = minFix;
    this.valid = this.gps ? this.gps.t.map((_, i) => this.isValid(i)) : [];
    this.precise = this.valid.map((ok, i) => ok && (this.gps.speedOk ? !!this.gps.speedOk[i] : true));
    this.validCount = this.valid.filter(Boolean).length;
    this.utcOffsetMs = tel.utcOffsetMs;
    this.duration = tel.video?.durationSec ?? (this.gps?.n ? this.gps.t[this.gps.n - 1] : 0);
  }

  get hasGps() { return !!(this.gps && this.validCount > 1); }

  isValid(i) {
    const g = this.gps;
    if (!g || g.lat[i] == null || g.lon[i] == null) return false;
    if (!(g.fix[i] >= this.minFix)) return false;   // no lock, or no fix reported at all
    // reject the (0,0) island and wildly implausible coordinates
    if (Math.abs(g.lat[i]) < 1e-6 && Math.abs(g.lon[i]) < 1e-6) return false;
    return Math.abs(g.lat[i]) <= 90 && Math.abs(g.lon[i]) <= 180;
  }

  /**
   * Interpolated GPS state at global time t, or null before the first / after the last sample.
   * Position, altitude and speed are null wherever the sample does not qualify (no position,
   * or a fix too weak to trust its speed), so every readout shows "--" instead of a number, and
   * nothing is interpolated towards a sample that does not qualify itself.
   * @returns {{ i:number, lat:number|null, lon:number|null, alt:number|null, speed2d:number|null, speed3d:number|null,
   *   fix:number|null, dop:number|null, heading:number|null, valid:boolean, utc:number|null } | null}
   */
  sampleAt(t) {
    const g = this.gps;
    if (!g || !g.n) return null;
    const i = Math.max(0, lowerIndex(g.t, t));
    const j = Math.min(i + 1, g.n - 1);
    if (Math.min(Math.abs(t - g.t[i]), Math.abs(g.t[j] - t)) > MAX_SAMPLE_GAP_SEC) return null;
    const k = this.#blend(i, j, t);
    // a column value at i, blended towards j only when j qualifies too; null when i does not qualify
    const value = (col, ok) => (!ok[i] || col[i] == null ? null : (ok[j] && col[j] != null ? col[i] + (col[j] - col[i]) * k : col[i]));
    return {
      i, valid: this.valid[i],
      lat: value(g.lat, this.valid),
      lon: value(g.lon, this.valid),
      alt: value(g.alt, this.valid),
      speed2d: value(g.speed2d, this.precise),
      speed3d: value(g.speed3d, this.precise),
      fix: g.fix[i], dop: g.dop[i],
      utc: this.utcOffsetMs != null ? this.utcOffsetMs + t * 1000 : g.utc[i],
      heading: this.headingAt(i),
    };
  }

  /** Blend factor from sample i towards sample j at time t (0 unless t lies between two close samples). */
  #blend(i, j, t) {
    const t0 = this.gps.t[i]; const t1 = this.gps.t[j];
    if (j === i || !(t1 > t0) || t < t0 || t > t1 || t1 - t0 >= MAX_SAMPLE_GAP_SEC) return 0;
    return (t - t0) / (t1 - t0);
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
   * Contiguous runs of valid points for drawing. A run ends where the receiver loses
   * its fix — nothing is drawn across a stretch it could not position — and where more
   * than maxGapSec passed between samples.
   * @returns {Array<{ start:number, end:number }>} inclusive index ranges, all points valid
   */
  runs(maxGapSec = 5) {
    const g = this.gps; const out = [];
    if (!g) return out;
    let start = -1;
    for (let i = 0; i < g.n; i++) {
      if (!this.valid[i]) { if (start >= 0) out.push({ start, end: i - 1 }); start = -1; continue; }
      if (start < 0) start = i;
      else if (g.t[i] - g.t[i - 1] > maxGapSec) { out.push({ start, end: i - 1 }); start = i; }
    }
    if (start >= 0) out.push({ start, end: g.n - 1 });
    return out;
  }
}
