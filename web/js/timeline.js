/**
 * Canvas timeline: chapter blocks, GPS-quality strip, playhead; click/drag to seek.
 * Its horizontal extent is aligned with the plot area of the charts below (setInsets),
 * so the playhead and the chart playheads line up and times can be read straight down.
 */

import { fmtTime } from './util.js';

const QUALITY_BUCKETS = 600;
const QUALITY = { none: 0, noFix: 1, fix2d: 2, fix3d: 3 };
const QUALITY_STATES = 4;
const FONT = '10px -apple-system, sans-serif';
const EMPTY_FONT = '11px -apple-system, sans-serif';
const MONO = '10px ui-monospace, monospace';
const COLORS = {
  panel: '#1d2129', chapterA: '#1f2430', chapterB: '#232833', border: '#262b36', muted: '#8b93a7', text: '#e6e9ef',
  playhead: '#ffb020', labelBg: 'rgba(15,17,21,.85)',
  // one colour per QUALITY state, matching the HUD's fix classes: bad / warn / ok
  quality: [null, 'rgba(255,92,92,.7)', 'rgba(255,176,32,.8)', 'rgba(53,208,127,.7)'],
};

export class Timeline {
  constructor(canvas, { onSeek } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.recording = null;
    this.quality = null;
    this.time = 0;
    this.dragging = false;
    this.insetLeft = 0;   // CSS px, matches the charts' y-axis width
    this.insetRight = 0;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => { this.dragging = true; canvas.setPointerCapture(e.pointerId); this.#seekFromEvent(e); });
    canvas.addEventListener('pointermove', (e) => { if (this.dragging) this.#seekFromEvent(e); });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('pointercancel', () => { this.dragging = false; });
  }

  #seekFromEvent(e) {
    if (!this.recording || !this.onSeek) return;
    const rect = this.canvas.getBoundingClientRect();
    const span = Math.max(1, rect.width - this.insetLeft - this.insetRight);
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - this.insetLeft) / span));
    this.onSeek(frac * this.recording.durationSec);
  }

  /** Align the drawn extent with the charts' plot area (CSS px from the canvas edges). */
  setInsets(left, right) {
    const l = Math.max(0, Math.round(left)); const r = Math.max(0, Math.round(right));
    if (l === this.insetLeft && r === this.insetRight) return;
    this.insetLeft = l; this.insetRight = r;
    this.draw();
  }

  set(recording, track) {
    this.recording = recording;
    this.time = 0;
    this.quality = recording && track?.gps?.n ? buildQuality(track, recording.durationSec || 1) : null;
    this.draw();
  }

  setTime(t) { this.time = t; this.draw(); }

  /** Size the backing store to the parent (minus padding) at device resolution; returns CSS size. */
  #fit() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth - 20; const h = c.parentElement.clientHeight - 8;
    if (w <= 0 || h <= 0) return null;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  draw() {
    const size = this.#fit();
    if (!size) return;
    const { ctx } = this;
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);
    const x0 = this.insetLeft; const pw = Math.max(1, w - this.insetLeft - this.insetRight);
    ctx.fillStyle = COLORS.panel; ctx.fillRect(x0, 0, pw, h);
    const rec = this.recording;
    if (!rec || !rec.durationSec) {
      ctx.fillStyle = COLORS.muted; ctx.font = EMPTY_FONT; ctx.fillText('No recording loaded', x0 + 8, h / 2 + 4);
      return;
    }
    const X = (t) => x0 + (t / rec.durationSec) * pw;
    this.#drawChapters(rec, X, h);
    if (this.quality) this.#drawQuality(x0, pw, h);
    this.#drawPlayhead(X, x0, pw, h);
  }

  #drawChapters(rec, X, h) {
    const { ctx } = this;
    rec.chapters.forEach((ch, i) => {
      const a = X(ch.offsetSec); const b = X(ch.offsetSec + ch.durationSec);
      ctx.fillStyle = i % 2 ? COLORS.chapterB : COLORS.chapterA; ctx.fillRect(a, 0, b - a, h);
      ctx.strokeStyle = COLORS.border; ctx.beginPath(); ctx.moveTo(b, 0); ctx.lineTo(b, h); ctx.stroke();
      if (b - a > 60) { ctx.fillStyle = COLORS.muted; ctx.font = FONT; ctx.fillText(`${i + 1} · ${ch.file}`, a + 6, 12); }
    });
  }

  /**
   * GPS status strip along the bottom, labelled in the left gutter (under the charts'
   * y-axis labels): red where the receiver had no fix, amber for a 2D fix, green for 3D.
   */
  #drawQuality(x0, pw, h) {
    const { ctx } = this;
    const bw = pw / this.quality.length;
    this.quality.forEach((q, b) => {
      if (q === QUALITY.none) return;
      ctx.fillStyle = COLORS.quality[q];
      ctx.fillRect(x0 + b * bw, h - 5, Math.ceil(bw), 4);
    });
    if (x0 >= 30) {
      ctx.fillStyle = COLORS.muted; ctx.font = FONT; ctx.textAlign = 'right';
      ctx.fillText('GPS', x0 - 6, h - 6);
      ctx.textAlign = 'left';
    }
  }

  #drawPlayhead(X, x0, pw, h) {
    const { ctx } = this;
    const px = X(this.time);
    ctx.fillStyle = COLORS.playhead; ctx.fillRect(px - 1, 0, 2, h);
    const label = fmtTime(this.time);
    ctx.font = MONO;
    const tw = ctx.measureText(label).width + 8;
    const lx = Math.min(x0 + pw - tw, Math.max(x0, px + 4));
    ctx.fillStyle = COLORS.labelBg; ctx.fillRect(lx, h - 18, tw, 13);
    ctx.fillStyle = COLORS.text; ctx.fillText(label, lx + 4, h - 8);
  }
}

/**
 * GPS status of sample i. Only samples the map actually draws count as a fix, so the
 * strip and the route always agree; the reported fix then tells 2D from 3D.
 */
function statusOf(track, i) {
  if (!track.valid[i]) return QUALITY.noFix;
  return track.gps.fix[i] >= 3 ? QUALITY.fix3d : QUALITY.fix2d;
}

/**
 * Per-bucket GPS status over the recording: the status most of the bucket's samples
 * reported, so a single flapping sample cannot repaint a whole bar. Ties go to the
 * worse status, and a bucket without samples stays `none` and is left unpainted.
 */
function buildQuality(track, durationSec) {
  const g = track.gps;
  const counts = new Uint32Array(QUALITY_BUCKETS * QUALITY_STATES);
  for (let i = 0; i < g.n; i++) {
    const b = Math.min(QUALITY_BUCKETS - 1, Math.floor((g.t[i] / durationSec) * QUALITY_BUCKETS));
    counts[b * QUALITY_STATES + statusOf(track, i)]++;
  }
  const q = new Uint8Array(QUALITY_BUCKETS);
  for (let b = 0; b < QUALITY_BUCKETS; b++) {
    let top = QUALITY.none; let topCount = 0;
    for (let s = QUALITY.noFix; s < QUALITY_STATES; s++) {
      const n = counts[b * QUALITY_STATES + s];
      if (n > topCount) { topCount = n; top = s; }
    }
    q[b] = top;
  }
  return q;
}
