/**
 * Instrument cluster drawn on the video: three round gauges fed by MotionModel.at(t).
 *
 *   G-FORCE   ball = horizontal acceleration (lateral →, longitudinal ↑), rings at 0.5 g / 1 g, short trail
 *   GYRO      ball = turn rate (yaw ←→) and pitch rate (↑↓); arc at the rim = roll rate
 *   ATTITUDE  bubble level: pitch / roll angles from the measured gravity direction
 */

import { fmtSigned, padL, clamp, sizeCanvas } from './util.js';

const CSS = {
  ring: 'rgba(230,233,239,.35)', ringStrong: 'rgba(230,233,239,.6)', cross: 'rgba(230,233,239,.18)',
  muted: 'rgba(139,147,167,.9)', bg: 'rgba(10,12,16,.55)',
  ballG: '#ffb020', ballGyro: '#4cc2ff', ballAtt: '#35d07f', trail: 'rgba(255,176,32,.35)', warn: '#ff5c5c',
};
const LABEL_FONT = '9px -apple-system, BlinkMacSystemFont, sans-serif';
const EMPTY = '--'; // captions keep a constant width (fixed-width caption box) so the cluster never reflows
const TRAIL_LENGTH = 14;

/** Rim labels per gauge: top / bottom / left / right, plus the full-scale legend. */
const LABELS = {
  g: { top: 'ACC', bottom: 'BRK', left: 'L', right: 'R', scale: (self) => `${self.gFull.toFixed(1)}g` },
  gyro: { top: 'UP', bottom: 'DN', left: 'L', right: 'R', scale: (self) => `${self.rateFull}°/s` },
  att: { top: 'NOSE ↑', bottom: 'NOSE ↓', scale: (self) => `${self.angleFull}°` },
};
const TITLES = { g: 'G-FORCE', gyro: 'GYRO °/s', att: 'ATTITUDE' };

export class Gauges {
  /**
   * @param {HTMLElement} container
   * @param {{ size?: number, gFullScale?: number, rateFullScale?: number, angleFullScale?: number }} opts
   */
  constructor(container, { size = 118, gFullScale = 1.0, rateFullScale = 45, angleFullScale = 20 } = {}) {
    this.container = container;
    this.size = size;
    this.gFull = gFullScale; this.rateFull = rateFullScale; this.angleFull = angleFullScale;
    this.trail = [];
    this.enabled = true;
    this.blank = false;   // drawn without data: nothing to redraw until data comes back
    this.gauges = Object.fromEntries(Object.keys(TITLES).map((key) => [key, this.#createGauge(key)]));
    this.clear();
  }

  #createGauge(key) {
    const wrap = document.createElement('div'); wrap.className = 'gauge';
    const title = document.createElement('div'); title.className = 'gauge-title'; title.textContent = TITLES[key];
    const canvas = document.createElement('canvas');
    const cap = document.createElement('div'); cap.className = 'gauge-cap';
    wrap.append(title, canvas, cap);
    this.container.append(wrap);
    canvas.style.width = `${this.size}px`; canvas.style.height = `${this.size}px`;
    return { wrap, ctx: sizeCanvas(canvas, this.size, this.size), cap };
  }

  setEnabled(on) {
    this.enabled = on;
    this.container.classList.toggle('hidden', !on);
  }

  setAvailable(hasImu, hasGyro) {
    this.container.classList.toggle('hidden', !this.enabled || !hasImu);
    this.gauges.gyro.wrap.classList.toggle('hidden', !hasGyro);
  }

  clear() {
    this.trail = [];
    this.blank = true;
    for (const [key, gauge] of Object.entries(this.gauges)) {
      this.#drawBase(key);
      gauge.cap.textContent = EMPTY;
    }
  }

  /** @param {object|null} m MotionModel.at(t) result — null (no data around t) blanks the gauges once, then costs nothing per frame */
  update(m) {
    if (!this.enabled) return;
    if (!m) { if (!this.blank) this.clear(); return; }
    this.blank = false;
    this.#drawG(m);
    this.#drawGyro(m);
    this.#drawAttitude(m);
  }

  /** Background, rings, cross-hair and rim labels; returns the centre and ring radius. */
  #drawBase(key) {
    const { ctx } = this.gauges[key];
    const s = this.size; const c = s / 2; const R = s * 0.44;
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath(); ctx.arc(c, c, s / 2 - 1, 0, Math.PI * 2); ctx.fillStyle = CSS.bg; ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = CSS.ring;
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = CSS.cross;
    ctx.beginPath(); ctx.arc(c, c, R / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
    const labels = LABELS[key];
    ctx.fillStyle = CSS.muted; ctx.font = LABEL_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(labels.top, c, c - R + 7); ctx.fillText(labels.bottom, c, c + R - 7);
    if (labels.left) { ctx.fillText(labels.left, c - R + 7, c); ctx.fillText(labels.right, c + R - 7, c); }
    ctx.fillStyle = CSS.cross; ctx.fillText(labels.scale(this), c + R * 0.72, c - R * 0.72);
    return { c, R };
  }

  #ball(ctx, x, y, color, r) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
  }

  #drawTrail(ctx, x, y) {
    this.trail.push([x, y]);
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
    for (let i = 0; i < this.trail.length - 1; i++) {
      const [tx, ty] = this.trail[i];
      ctx.beginPath(); ctx.arc(tx, ty, 2 + (i / this.trail.length) * 2, 0, Math.PI * 2);
      ctx.fillStyle = CSS.trail; ctx.fill();
    }
  }

  #drawG(m) {
    const { ctx, cap } = this.gauges.g;
    const { c, R } = this.#drawBase('g');
    const k = R / this.gFull;
    const x = c + clamp(m.latG * k, -R, R);
    const y = c - clamp(m.lonG * k, -R, R);
    this.#drawTrail(ctx, x, y);
    this.#ball(ctx, x, y, m.gTotal > this.gFull ? CSS.warn : CSS.ballG, 6.5);
    cap.innerHTML = `<b>${padL(m.gTotal.toFixed(2), 4)} g</b> · lon ${fmtSigned(m.lonG, 2, 5)} · lat ${fmtSigned(m.latG, 2, 5)}`;
  }

  #drawGyro(m) {
    const { ctx, cap } = this.gauges.gyro;
    const { c, R } = this.#drawBase('gyro');
    const k = R / this.rateFull;
    const x = c - clamp(m.yawDps * k, -R, R);   // + yaw = left turn → ball left
    const y = c - clamp(m.pitchDps * k, -R, R); // + pitch rate = nose rising → ball up
    const rollFrac = clamp(m.rollDps / this.rateFull, -1, 1); // roll rate arc at the rim: clockwise for rolling right
    if (Math.abs(rollFrac) > 0.02) {
      const start = -Math.PI / 2; const end = start + rollFrac * (Math.PI / 2);
      ctx.beginPath(); ctx.arc(c, c, R + 4, Math.min(start, end), Math.max(start, end));
      ctx.lineWidth = 3; ctx.strokeStyle = CSS.ballGyro; ctx.stroke();
    }
    this.#ball(ctx, x, y, CSS.ballGyro, 6.5);
    cap.innerHTML = `yaw <b>${fmtSigned(m.yawDps, 0, 3)}</b> · pitch ${fmtSigned(m.pitchDps, 0, 3)} · roll ${fmtSigned(m.rollDps, 0, 3)}`;
  }

  #drawAttitude(m) {
    const { ctx, cap } = this.gauges.att;
    const { c, R } = this.#drawBase('att');
    const full = Math.sin(this.angleFull * Math.PI / 180);
    const x = c + clamp((m.bubbleX / full) * R, -R, R);
    const y = c - clamp((m.bubbleY / full) * R, -R, R);
    ctx.save(); ctx.translate(c, c); ctx.rotate(-m.rollDeg * Math.PI / 180); // horizon line rotated by the roll angle
    ctx.beginPath(); ctx.moveTo(-R * 0.9, 0); ctx.lineTo(R * 0.9, 0);
    ctx.lineWidth = 1.5; ctx.strokeStyle = CSS.ringStrong; ctx.stroke();
    ctx.restore();
    this.#ball(ctx, x, y, CSS.ballAtt, 7);
    cap.innerHTML = `pitch <b>${fmtSigned(m.pitchDeg, 1, 5)}°</b> · roll <b>${fmtSigned(m.rollDeg, 1, 5)}°</b>`;
  }
}
