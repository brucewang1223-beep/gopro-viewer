/**
 * Time-series charts (uPlot). The set of charts adapts to the data:
 *   speed & altitude (GPS), G-force (lon/lat/vert g) and gyro rates (IMU),
 *   or a plain |a| chart when the motion model is unavailable.
 * All charts share the x axis (global time in seconds), cursor and zoom.
 * A lightweight DOM playhead follows playback without redrawing the plots.
 */

import { fmtTime, fmtSigned, padL, MS_TO_KMH, G } from './util.js';

const SYNC_KEY = 'gopro-viewer';
const C = {
  speed: '#4cc2ff', alt: '#35d07f', lon: '#ffb020', lat: '#4cc2ff', vert: 'rgba(139,147,167,.6)',
  yaw: '#4cc2ff', pitch: '#ffb020', roll: 'rgba(53,208,127,.8)', mag: '#ffb020',
};
const AXIS_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif';
const AXIS = { stroke: '#8b93a7', grid: { stroke: '#262b36', width: 1 }, ticks: { stroke: '#262b36' }, font: AXIS_FONT };
const CLICK_TOLERANCE_PX = 4; // pointer travel beyond this is a zoom drag, not a seek

/* ---------- chart specifications ---------- */

/** Speed is charted only where the fix geometry is good enough to trust it; the rest is a gap. */
function gpsSpecs(track) {
  const g = track.gps;
  return [
    {
      key: 'speed', title: 'Speed', unit: `km/h · only where DOP ≤ ${track.maxDop}`, yMode: 'zero',
      data: [g.t, g.speed2d.map((v, i) => (v == null || !track.precise[i] ? null : v * MS_TO_KMH))],
      series: [{ label: 'Speed', stroke: C.speed, fill: 'rgba(76,194,255,.10)', width: 1.5 }],
      fmt: (u, i) => `${padL((u.data[1][i] ?? 0).toFixed(1), 5)} km/h`,
    },
    {
      key: 'alt', title: 'Altitude', unit: 'm', yMode: 'auto',
      data: [g.t, g.alt],
      series: [{ label: 'Altitude', stroke: C.alt, fill: 'rgba(53,208,127,.10)', width: 1.5 }],
      fmt: (u, i) => `${padL((u.data[1][i] ?? 0).toFixed(1), 7)} m`,
    },
  ];
}

function motionSpecs(motion) {
  const m = motion.columns();
  const specs = [{
    key: 'gforce', title: 'G-force', unit: 'g · lon (↑ acc / ↓ brake) · lat (+ right) · vert', yMode: 'sym',
    data: [m.t, m.lonG, m.latG, m.vertG],
    series: [{ label: 'lon', stroke: C.lon, width: 1.5 }, { label: 'lat', stroke: C.lat, width: 1.5 }, { label: 'vert', stroke: C.vert, width: 1 }],
    fmt: (u, i) => `lon ${fmtSigned(u.data[1][i], 2, 5)} g · lat ${fmtSigned(u.data[2][i], 2, 5)} g · vert ${fmtSigned(u.data[3][i], 2, 5)} g`,
  }];
  if (motion.hasGyro) {
    specs.push({
      key: 'gyro', title: 'Gyro', unit: '°/s · yaw (+ left turn) · pitch (+ nose up) · roll (+ right)', yMode: 'sym',
      data: [m.t, m.yawDps, m.pitchDps, m.rollDps],
      series: [{ label: 'yaw', stroke: C.yaw, width: 1.5 }, { label: 'pitch', stroke: C.pitch, width: 1 }, { label: 'roll', stroke: C.roll, width: 1 }],
      fmt: (u, i) => `yaw ${fmtSigned(u.data[1][i], 0, 3)} · pitch ${fmtSigned(u.data[2][i], 0, 3)} · roll ${fmtSigned(u.data[3][i], 0, 3)} °/s`,
    });
  }
  return specs;
}

function accelSpec(a) {
  return {
    key: 'accl', title: 'Accelerometer', unit: '|a| g', yMode: 'zero',
    data: [a.t, a.mag.map((v) => (v == null ? null : v / G))],
    series: [{ label: '|a|', stroke: C.mag, width: 1.5 }],
    fmt: (u, i) => `|a| ${padL((u.data[1][i] ?? 0).toFixed(2), 5)} g`,
  };
}

/** Charts to draw for a track: GPS charts when there is a fix, motion or raw |a| charts when there is IMU data. */
function chartSpecs(track, motion) {
  const specs = [];
  if (track.gps?.n && track.hasGps) specs.push(...gpsSpecs(track));
  if (motion?.valid) specs.push(...motionSpecs(motion));
  else if (track.accl?.n) specs.push(accelSpec(track.accl));
  return specs;
}

/** y range per chart kind: symmetric around 0, anchored at 0, or padded auto-range. */
function yRange(mode, min, max) {
  if (min == null || max == null) return [0, 1];
  if (mode === 'sym') { const m = Math.max(Math.abs(min), Math.abs(max), 1e-3) * 1.1; return [-m, m]; }
  const pad = max === min ? 1 : (max - min) * 0.08;
  return mode === 'zero' ? [Math.min(0, min), max + pad] : [min - pad, max + pad];
}

/* ---------- component ---------- */

export class Charts {
  /**
   * @param {HTMLElement} container
   * @param {{ onSeek?: (t:number)=>void, onLayout?: (insetLeft:number, insetRight:number)=>void }} opts
   *   onLayout reports the plot-area insets (CSS px) so the timeline can align with the plots.
   */
  constructor(container, { onSeek, onLayout } = {}) {
    this.container = container;
    this.onSeek = onSeek;
    this.onLayout = onLayout;
    this.plots = {};
    this.playheads = {};
    this.chapterOffsets = [];
    this.syncing = false;
    this.ro = new ResizeObserver(() => this.#resizeAll());
    this.ro.observe(container);
  }

  clear() {
    for (const u of Object.values(this.plots)) u.destroy();
    this.plots = {};
    this.playheads = {};
    this.container.innerHTML = '';
  }

  /**
   * @param {import('./track.js').Track|null} track
   * @param {import('./motion.js').MotionModel|null} motion
   */
  setTrack(track, motion) {
    this.clear();
    if (!track) return;
    this.chapterOffsets = (track.tel.chapters || []).map((c) => c.offsetSec).filter((o) => o > 0);
    const specs = chartSpecs(track, motion);
    if (!specs.length) {
      this.container.innerHTML = '<div class="chart-empty">No telemetry to chart for this recording.</div>';
      this.container.style.gridTemplateRows = '1fr';
      return;
    }
    this.container.style.gridTemplateRows = `repeat(${specs.length}, minmax(110px, 1fr))`;
    const duration = Math.max(track.duration, 1);
    for (const spec of specs) this.#make(spec, duration);
  }

  /**
   * Plot-area insets of the first chart relative to the chart body (CSS px). uPlot applies
   * sizes in its own (microtask) commit, so this runs from the setSize hook — which also
   * fires for the initial layout — rather than right after construction.
   */
  #reportLayout() {
    const u = Object.values(this.plots)[0];
    if (!this.onLayout || !u?.over.isConnected) return;
    const body = u.root.parentElement.getBoundingClientRect();
    const over = u.over.getBoundingClientRect();
    if (over.width <= 0 || body.width <= 0) return;
    this.onLayout(Math.max(0, over.left - body.left), Math.max(0, body.right - over.right));
  }

  #shell(spec) {
    const wrap = document.createElement('div'); wrap.className = 'chart';
    const title = document.createElement('div'); title.className = 'chart-title';
    title.innerHTML = `${spec.title} <small>${spec.unit}</small>`;
    const body = document.createElement('div'); body.className = 'chart-body';
    const readout = document.createElement('div'); readout.className = 'chart-readout';
    body.appendChild(readout);
    wrap.append(title, body);
    this.container.appendChild(wrap);
    return { body, readout };
  }

  #options(spec, duration, body, readout) {
    const showReadout = (u) => {
      const idx = u.cursor.idx;
      const empty = idx == null || idx < 0 || u.data[1][idx] == null;
      readout.textContent = empty ? '' : `${padL(fmtTime(u.data[0][idx]), 9)}  ${spec.fmt(u, idx)}`;
    };
    return {
      width: Math.max(100, body.clientWidth), height: Math.max(60, body.clientHeight),
      scales: { x: { time: false, min: 0, max: duration }, y: { range: (u, min, max) => yRange(spec.yMode, min, max) } },
      axes: [
        { ...AXIS, values: (u, splits) => splits.map((s) => fmtTime(s, 0)), size: 22 },
        { ...AXIS, size: 46 },
      ],
      series: [{}, ...spec.series.map((s) => ({ ...s, points: { show: false }, spanGaps: false }))],
      legend: { show: false },
      cursor: { sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] }, drag: { x: true, y: false, setScale: true }, y: false, points: { size: 6, width: 2 } },
      hooks: {
        setScale: [(u, scaleKey) => { if (scaleKey === 'x') this.#propagateZoom(u); }],
        setCursor: [showReadout],
        draw: [(u) => this.#drawGuides(u, spec)],
        setSize: [() => this.#reportLayout()],
      },
    };
  }

  /** A click (as opposed to a zoom drag) on the plot seeks to that time. */
  #bindSeek(u) {
    let down = null;
    u.over.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    u.over.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > CLICK_TOLERANCE_PX || !this.onSeek) return;
      const t = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, 'x');
      if (Number.isFinite(t)) this.onSeek(t);
    });
  }

  #make(spec, duration) {
    const { body, readout } = this.#shell(spec);
    const u = new uPlot(this.#options(spec, duration, body, readout), spec.data, body);
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    playhead.style.display = 'none';
    u.over.appendChild(playhead);
    this.#bindSeek(u);
    this.plots[spec.key] = u;
    this.playheads[spec.key] = playhead;
  }

  /** Zero line for symmetric charts and dashed chapter boundaries. */
  #drawGuides(u, spec) {
    const { ctx, bbox } = u;
    ctx.save();
    if (spec.yMode === 'sym') {
      const y0 = Math.round(u.valToPos(0, 'y', true));
      ctx.strokeStyle = 'rgba(230,233,239,.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bbox.left, y0); ctx.lineTo(bbox.left + bbox.width, y0); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(139,147,167,.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    for (const off of this.chapterOffsets) {
      const x = Math.round(u.valToPos(off, 'x', true));
      if (x < bbox.left || x > bbox.left + bbox.width) continue;
      ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke();
    }
    ctx.restore();
  }

  #propagateZoom(src) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const { min, max } = src.scales.x;
      for (const u of Object.values(this.plots)) {
        if (u !== src && (u.scales.x.min !== min || u.scales.x.max !== max)) u.setScale('x', { min, max });
      }
    } finally {
      this.syncing = false;
    }
  }

  #resizeAll() {
    for (const u of Object.values(this.plots)) {
      const el = u.root.parentElement;
      const w = el.clientWidth; const h = el.clientHeight;
      if (w > 0 && h > 0 && (u.width !== w || u.height !== h)) u.setSize({ width: w, height: h }); // → setSize hook → #reportLayout
    }
  }

  /** Move playheads to global time t (cheap: no redraw). */
  setTime(t) {
    for (const [key, u] of Object.entries(this.plots)) {
      const ph = this.playheads[key];
      const { min, max } = u.scales.x;
      if (t < min || t > max) { ph.style.display = 'none'; continue; }
      ph.style.display = '';
      ph.style.left = `${u.valToPos(t, 'x')}px`;
    }
  }
}
