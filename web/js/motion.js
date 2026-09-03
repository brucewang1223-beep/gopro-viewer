/**
 * Vehicle-motion model derived from the IMU streams (camera frame: x = left, y = back, z = up).
 *
 * The gravity direction is estimated per sample with a long moving average of the
 * accelerometer (a car-mounted camera keeps a stable attitude, manoeuvres are short).
 * From it we derive a body frame — up = gravity reaction, forward = camera optical axis
 * projected on the horizontal plane, right = forward × up — and express everything in
 * driver terms: longitudinal / lateral g, yaw / pitch / roll rates, pitch / roll angles.
 * A camera mounted upside down or tilted is handled automatically because "up" is measured.
 */

import { G, lowerIndex, clamp } from './util.js';

const F_CAM = [0, -1, 0]; // camera optical axis (forward) in the camera frame
const R_CAM = [-1, 0, 0]; // camera right-hand side in the camera frame
const RAD2DEG = 180 / Math.PI;
const MIN_GRAVITY = 4;        // m/s²: below this the moving average is a data gap, not gravity
const MIN_FORWARD = 0.1;      // camera pointing straight up/down has no usable heading axis
const GYRO_MATCH_SEC = 0.2;   // max distance between an accelerometer bin and its gyro bin

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Centred moving average of a numeric array (nulls carried forward), window in samples. */
function movingAverage(arr, window) {
  const n = arr.length;
  const filled = new Float64Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { if (arr[i] != null && Number.isFinite(arr[i])) last = arr[i]; filled[i] = last; }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + filled[i];
  const half = Math.max(1, Math.floor(window / 2));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half); const b = Math.min(n, i + half + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/** Body frame (unit vectors up / forward / right in camera coordinates) from a gravity estimate, or null. */
function bodyFrame(gravity) {
  const gm = norm(gravity);
  if (gm < MIN_GRAVITY) return null;
  const up = scale(gravity, 1 / gm);
  const projected = sub(F_CAM, scale(up, dot(F_CAM, up))); // camera axis projected on the horizontal plane
  const fm = norm(projected);
  if (fm < MIN_FORWARD) return null;
  const forward = scale(projected, 1 / fm);
  return { up, forward, right: cross(forward, up) };
}

/** Gyro sample vector nearest to time t, or null when the gyro has no bin close enough. */
function gyroAt(gyro, t) {
  if (!gyro?.n) return null;
  const k = Math.max(0, lowerIndex(gyro.t, t));
  if (Math.abs(gyro.t[k] - t) >= GYRO_MATCH_SEC) return null;
  return [gyro.x[k] ?? 0, gyro.y[k] ?? 0, gyro.z[k] ?? 0];
}

export class MotionModel {
  /**
   * @param {object} tel merged telemetry (accl / gyro in the camera frame)
   * @param {{ gravityWindowSec?: number }} opts
   */
  constructor(tel, { gravityWindowSec = 12 } = {}) {
    this.accl = tel.accl;
    this.gyro = tel.gyro;
    this.n = this.accl?.n ?? 0;
    this.valid = this.n > 0 && this.accl.frame === 'camera';
    this.hasGyro = !!this.gyro?.n;
    if (!this.valid) return;
    this.t = this.accl.t;
    this.#allocate(this.n);
    const window = Math.max(5, Math.round(gravityWindowSec * (this.accl.hz || 25)));
    const gx = movingAverage(this.accl.x, window); const gy = movingAverage(this.accl.y, window); const gz = movingAverage(this.accl.z, window);
    for (let i = 0; i < this.n; i++) this.#computeSample(i, [gx[i], gy[i], gz[i]]);
  }

  #allocate(n) {
    for (const key of ['lonG', 'latG', 'vertG', 'pitchDeg', 'rollDeg', 'bubbleX', 'bubbleY', 'yawDps', 'pitchDps', 'rollDps']) this[key] = new Float32Array(n);
    this.ok = new Uint8Array(n);
  }

  /** Driver-frame quantities of accelerometer bin i given its gravity estimate; leaves ok[i] = 0 on gaps. */
  #computeSample(i, gravity) {
    const frame = bodyFrame(gravity);
    if (!frame) return;
    const { up, forward, right } = frame;
    const a = this.accl;
    const dynamic = sub([a.x[i] ?? 0, a.y[i] ?? 0, a.z[i] ?? 0], gravity);
    this.lonG[i] = dot(dynamic, forward) / G;
    this.latG[i] = dot(dynamic, right) / G;
    this.vertG[i] = dot(dynamic, up) / G;
    const uf = clamp(dot(up, F_CAM), -1, 1); const ur = clamp(dot(up, R_CAM), -1, 1);
    this.pitchDeg[i] = Math.asin(uf) * RAD2DEG;    // + nose up
    this.rollDeg[i] = -Math.asin(ur) * RAD2DEG;    // + rolled right
    this.bubbleX[i] = ur; this.bubbleY[i] = uf;     // bubble moves to the high side
    const w = gyroAt(this.gyro, a.t[i]);
    if (w) {
      this.yawDps[i] = dot(w, up) * RAD2DEG;        // + turning left (CCW seen from above)
      this.pitchDps[i] = dot(w, right) * RAD2DEG;   // + nose rising
      this.rollDps[i] = dot(w, forward) * RAD2DEG;  // + rolling right
    }
    this.ok[i] = 1;
  }

  /** Interpolated motion state at global time t (null when no data around t). */
  at(t) {
    if (!this.valid) return null;
    let i0 = lowerIndex(this.t, t);
    if (i0 < 0) { if (this.t[0] - t < 1) i0 = 0; else return null; }
    const i1 = Math.min(i0 + 1, this.n - 1);
    if (Math.abs(this.t[i0] - t) > 1) return null;
    const span = this.t[i1] - this.t[i0];
    const k = span > 0 && span < 1 ? clamp((t - this.t[i0]) / span, 0, 1) : 0;
    if (!this.ok[i0] || !this.ok[i1]) return null;
    const lerp = (arr) => arr[i0] + (arr[i1] - arr[i0]) * k;
    const lonG = lerp(this.lonG); const latG = lerp(this.latG);
    return {
      lonG, latG, vertG: lerp(this.vertG), gTotal: Math.hypot(lonG, latG),
      yawDps: lerp(this.yawDps), pitchDps: lerp(this.pitchDps), rollDps: lerp(this.rollDps),
      pitchDeg: lerp(this.pitchDeg), rollDeg: lerp(this.rollDeg),
      bubbleX: lerp(this.bubbleX), bubbleY: lerp(this.bubbleY),
    };
  }

  /** Column arrays for charts (plain arrays with nulls where the model is undefined). */
  columns() {
    const pick = (arr) => Array.from(arr, (v, i) => (this.ok[i] ? v : null));
    return {
      t: this.t,
      lonG: pick(this.lonG), latG: pick(this.latG), vertG: pick(this.vertG),
      yawDps: pick(this.yawDps), pitchDps: pick(this.pitchDps), rollDps: pick(this.rollDps),
      pitchDeg: pick(this.pitchDeg), rollDeg: pick(this.rollDeg),
    };
  }
}
