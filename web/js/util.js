/** Shared helpers: formatting, DOM, search, interpolation. */

export const MS_TO_KMH = 3.6;
export const G = 9.80665;

export const $ = (id) => document.getElementById(id);

/** Format seconds as m:ss.s or h:mm:ss.s (rounded first, so 59.96 s reads 1:00.0, never 0:60.0). */
export function fmtTime(sec, decimals = 1) {
  if (sec == null || !Number.isFinite(sec)) return '--';
  const neg = sec < 0;
  const q = 10 ** decimals;
  sec = Math.round(Math.abs(sec) * q) / q;
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  const sStr = decimals ? s.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(s)).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`;
  return (neg ? '-' : '') + body;
}

export function fmtClock(ms, { utc = true, withDate = false } = {}) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const get = utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  const t = `${p(get.h)}:${p(get.mi)}:${p(get.s)}`;
  return withDate ? `${get.y}-${p(get.mo)}-${p(get.da)} ${t}` : t;
}

/** "Camera time" ISO strings are local wall-clock stored as UTC: show them verbatim ("YYYY-MM-DD HH:MM:SS"). */
export function fmtCameraTime(iso) {
  if (!iso) return '--';
  return iso.replace('T', ' ').slice(0, 19);
}

/** A camera-clock epoch (seconds, local time stored as UTC) as "YYYY-MM-DD HH:MM". */
export const fmtCameraEpoch = (epochSec) => fmtCameraTime(new Date(epochSec * 1000).toISOString()).slice(0, 16);

/** Right-align a string in a fixed field (for monospace, white-space: pre contexts). */
export function padL(s, width) { s = String(s); return s.length >= width ? s : ' '.repeat(width - s.length) + s; }
export function padR(s, width) { s = String(s); return s.length >= width ? s : s + ' '.repeat(width - s.length); }

/** Fixed-decimals number right-aligned in `width` characters; `--` when there is no value. */
export function fmtNum(v, decimals, width = 0) {
  return v == null || !Number.isFinite(v) ? padL('--', width) : padL(v.toFixed(decimals), width);
}

/** m/s → "km/h" figure with one decimal. */
export const fmtKmh = (ms, decimals = 1) => (ms == null || !Number.isFinite(ms) ? '--' : (ms * MS_TO_KMH).toFixed(decimals));

/** Signed number with a constant width: always a sign, fixed decimals, right-aligned. */
export function fmtSigned(v, decimals = 2, width = 0) {
  if (v == null || !Number.isFinite(v)) return padL('--', width);
  const sign = v < 0 ? '−' : '+';
  return padL(`${sign}${Math.abs(v).toFixed(decimals)}`, width);
}

/** "UTC+4" / "UTC−3:30" from minutes east of UTC. */
function utcOffsetLabel(minutes) {
  const abs = Math.abs(minutes);
  const mm = abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : '';
  return `UTC${minutes >= 0 ? '+' : '−'}${Math.floor(abs / 60)}${mm}`;
}

const protuneLabel = (s) => [s.color, s.sharpness && `sharp ${s.sharpness}`, s.whiteBalance && `WB ${s.whiteBalance}`].filter(Boolean).join(' · ') || 'On';

/** Digital zoom: a factor ("1.4×") when the camera wrote one, "On" when it only said it was on. */
const zoomLabel = (zoom) => (zoom === true ? 'On' : zoom > 1 ? `${Math.round(zoom * 100) / 100}×` : null);

/** Settings worth showing, as [label, value(settings)] — a falsy value hides the row. */
const SETTING_ROWS = [
  ['HyperSmooth', (s) => s.stabilization && (s.stabilization.enabled ? (s.stabilization.mode || 'On') : 'Off')],
  ['Horizon', (s) => s.horizonControl !== 'Off' && s.horizonControl],
  ['FOV', (s) => s.fov && `${s.fov.name}${s.fov.diagonalDeg ? ` ${Math.round(s.fov.diagonalDeg)}°` : ''}`],
  ['HDR', (s) => s.hdr && 'On'],
  ['Protune', (s) => s.protune != null && (s.protune ? protuneLabel(s) : 'Off')],
  ['Shutter', (s) => s.exposure !== 'AUTO' && s.exposure],
  ['ISO', (s) => s.isoMin != null && s.isoMax != null && `${s.isoMin}–${s.isoMax}`],
  ['EV', (s) => s.ev && (s.ev > 0 ? `+${s.ev}` : String(s.ev))],
  ['Bitrate', (s) => s.bitrate !== 'STANDARD' && s.bitrate],
  ['Zoom', (s) => zoomLabel(s.digitalZoom)],
  ['Lens mod', (s) => s.lensMod],
  ['HindSight', (s) => s.hindsight],
  ['Audio', (s) => s.audio !== 'AUTO' && s.audio],
  ['Camera TZ', (s) => s.tzMinutes != null && utcOffsetLabel(s.tzMinutes)],
];

/** Human-readable camera settings (from the MP4 header GPMF) as [label, value] pairs. */
export function describeSettings(s) {
  if (!s) return [];
  return SETTING_ROWS.map(([label, value]) => [label, value(s)]).filter(([, value]) => value);
}

export function fmtBytes(b) {
  if (b == null) return '--';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDistance(m) {
  if (m == null) return '--';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** "…/last/two" of a path, or the path itself when it is that short. */
export function shortPath(p) {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

/** Index of the last element ≤ v in a sorted array (or -1). */
export function lowerIndex(arr, v) {
  let lo = 0; let hi = arr.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/** Bearing in degrees (0 = north, clockwise) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Speed → colour ramp (blue → cyan → green → yellow → red). */
export function speedColor(frac) {
  const stops = [[0, [58, 123, 255]], [0.35, [76, 194, 255]], [0.55, [53, 208, 127]], [0.78, [255, 176, 32]], [1, [255, 92, 92]]];
  frac = clamp(frac, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (frac <= stops[i][0]) {
      const [f0, c0] = stops[i - 1]; const [f1, c1] = stops[i];
      const k = (frac - f0) / (f1 - f0);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(255,92,92)';
}

export function percentile(values, p) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
}

/**
 * Size a canvas to `w × h` CSS pixels at device resolution and return a context whose
 * coordinates are CSS pixels. Only touches the backing store when the size changed.
 */
export function sizeCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr); const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}
