/**
 * Application bootstrap: wires library, player, map, charts, timeline, HUD, gauges and keyboard.
 */

import { api } from './api.js';
import { Player } from './player.js';
import { TrackMap } from './map.js';
import { Charts } from './charts.js';
import { Timeline } from './timeline.js';
import { LibraryView } from './library.js';
import { ImportDialog, jobSummary } from './import.js';
import { Track } from './track.js';
import { MotionModel } from './motion.js';
import { Gauges } from './gauges.js';
import { updateHud, setHudChapter } from './hud.js';
import { renderSettings, renderStats } from './stats.js';
import { fmtTime, padL, el } from './util.js';

const $ = (id) => document.getElementById(id);
const HUD_INTERVAL_MS = 80; // ~12 Hz is plenty for text
const SKIP_STORAGE_KEY = 'gopro-viewer.skipStep';
const MAP_STORAGE_KEY = 'gopro-viewer.map';
const EXPORTS = [['export-gpx', 'gpx'], ['export-geojson', 'geojson'], ['export-csv', 'csv', 'gps'], ['export-accl', 'csv', 'accl']];

const state = { recording: null, track: null, motion: null };
/** Step taken by ← / → and the −/+ buttons: `unit` 's' = seconds, 'f' = whole video frames. */
let skipStep = { n: 5, unit: 's' };
let timeWidth = 7;
let lastHudUpdate = 0;

/* ---------- status ---------- */

function toast(msg, kind = 'info', ms = 5000) {
  const t = el('div', { class: `toast ${kind}`, text: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function setStatus(text, busy = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('busy', busy);
}

function showVideoOverlay(text) {
  const o = $('video-overlay');
  o.textContent = text;
  o.classList.remove('hidden');
}

const hideVideoOverlay = () => $('video-overlay').classList.add('hidden');

/* ---------- components ---------- */

const video = $('video');
const player = new Player(video, { onTime, onChapter: (i) => setHudChapter(i + 1, player.chapters.length), onState: onPlayerState, onError: onVideoError });
const map = new TrackMap($('map'), {
  ...savedMapPrefs(),
  onSeek: (t) => player.seek(t),
  onPrefs: (prefs) => { try { localStorage.setItem(MAP_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } },
});
const timeline = new Timeline($('timeline'), { onSeek: (t) => player.seek(t) });
const charts = new Charts($('charts'), { onSeek: (t) => player.seek(t), onLayout: (left, right) => timeline.setInsets(left, right) });
const gauges = new Gauges($('gauges'));
const libraryView = new LibraryView({ list: $('library'), roots: $('roots'), search: $('search') }, { onSelect: selectRecording, onRemoveRoot: removeRoot });
const importDialog = new ImportDialog($('import-dialog'), {
  toast,
  onProgress: (job) => setStatus(jobSummary(job), true),
  onFinished: (job) => {
    toast(jobSummary(job), job.state === 'done' ? 'info' : 'warn', 9000);
    loadLibrary(api.rescan()); // the server rescans as the job ends; this shares that scan and shows the result
  },
});

function onPlayerState(s) {
  $('btn-play').textContent = s.playing ? '❚❚' : '▶';
  const total = fmtTime(s.duration);
  $('time-total').textContent = total;
  timeWidth = total.length;
}

function onVideoError(msg, ctx) {
  if (ctx?.code === 4 && state.recording?.hasProxy && !player.useProxy) {
    toast(`${msg}. Switching to the LRV proxy.`, 'warn', 7000);
    $('proxy').checked = true;
    player.setProxy(true);
    return;
  }
  showVideoOverlay(`${msg}\n\nThis browser may not decode this codec (HEVC/H.265 needs Safari or Chrome on Apple Silicon). `
    + 'If the camera also saved .LRV proxy files, enable “Proxy (LRV)”.');
}

/* ---------- time tick ---------- */

function onTime(t) {
  $('time-cur').textContent = padL(fmtTime(t), timeWidth);
  timeline.setTime(t);
  charts.setTime(t);
  if (!state.track) return;
  const sample = state.track.sampleAt(t);
  if (sample) map.update(sample);
  const motion = state.motion ? state.motion.at(t) : null;
  gauges.update(motion);
  const now = performance.now();
  if (now - lastHudUpdate < HUD_INTERVAL_MS) return;
  lastHudUpdate = now;
  updateHud(t, sample, motion, state.track.utcOffsetMs);
}

/* ---------- recording selection ---------- */

function setExportLinks(recordingId) {
  for (const [id, kind, stream] of EXPORTS) {
    const link = $(id);
    link.classList.toggle('disabled', !recordingId);
    if (recordingId) link.href = api.exportUrl(recordingId, kind, stream);
  }
}

/** Reset every view for a newly selected recording (before its telemetry arrives). */
function resetViews(rec) {
  Object.assign(state, { recording: rec, track: null, motion: null });
  libraryView.setActive(rec.id);
  gauges.clear();
  gauges.setAvailable(false, false);
  hideVideoOverlay();
  $('proxy').disabled = !rec.hasProxy;
  if (!rec.hasProxy) $('proxy').checked = false;
  player.load(rec, { useProxy: $('proxy').checked, autoplay: false });
  timeline.set(rec, null);
  map.setTrack(null);
  charts.setTrack(null, null);
  renderSettings(rec);
  setHudChapter(1, rec.chapters.length);
  updateHud(0, null, null, null);
  setExportLinks(null);
}

function telemetrySummary(rec, tel) {
  const gps = tel.gps ? `${tel.gps.source} ${tel.gps.n} pts @ ${tel.gps.hz} Hz` : 'no GPS stream';
  const imu = tel.accl ? ` · IMU ${tel.accl.hz} Hz` : '';
  const warn = tel.warnings?.length ? ` · ${tel.warnings.length} warning(s)` : '';
  return `${rec.name}: ${tel.camera?.model ?? 'GoPro'} · ${gps}${imu}${warn}`;
}

function warnAboutGps(tel, track) {
  if (!tel.gps) {
    toast('No GPS stream in this recording: the camera\'s GPS was off (HERO13: Preferences › Regional › GPS). '
      + 'Map, speed and altitude are unavailable; IMU data is shown.', 'warn', 9000);
  } else if (!track.hasGps) {
    toast('GPS never acquired a fix in this recording — map, speed and altitude are empty.', 'warn', 7000);
  }
}

function showTelemetry(rec, tel) {
  const track = new Track(tel);
  const motion = tel.accl ? new MotionModel(tel) : null;
  state.track = track;
  state.motion = motion?.valid ? motion : null;
  gauges.setAvailable(!!state.motion, !!state.motion?.hasGyro);
  map.setTrack(track);
  charts.setTrack(track, state.motion);
  timeline.set(rec, track);
  if (!!rec.hasGpsFix !== track.hasGps) { rec.hasGpsFix = track.hasGps; libraryView.render(); } // the scan-time probe was wrong: fix the badge
  renderStats(tel, track);
  setExportLinks(rec.id);
  setStatus(telemetrySummary(rec, tel));
  warnAboutGps(tel, track);
  for (const w of tel.warnings || []) console.warn('[telemetry]', w);
  onTime(player.time);
}

async function selectRecording(rec) {
  if (state.recording?.id === rec.id) return;
  resetViews(rec);
  if (!rec.hasGpmd) { setStatus(`${rec.name}: no telemetry track in this file`); return; }
  setStatus(`Loading telemetry for ${rec.name}…`, true);
  try {
    const tel = await api.telemetry(rec.id);
    if (state.recording?.id === rec.id) showTelemetry(rec, tel); // else the user moved on
  } catch (e) {
    toast(`Telemetry failed: ${e.message}`, 'error', 8000);
    setStatus(`${rec.name}: telemetry unavailable`);
  }
}

/* ---------- library ---------- */

async function loadLibrary(promise = api.library()) {
  try {
    setStatus('Scanning library…', true);
    const data = await promise;
    libraryView.set(data);
    setStatus(`${data.recordings.length} recording(s) in ${data.roots.length} folder(s)`);
    return data;
  } catch (e) {
    toast(`Library error: ${e.message}`, 'error');
    setStatus('Library error');
    return null;
  }
}

async function removeRoot(id) {
  try {
    setStatus('Rescanning…', true);
    libraryView.set(await api.removeRoot(id));
    setStatus('Library updated');
  } catch (e) {
    toast(e.message, 'error');
    setStatus('');
  }
}

/* ---------- controls ---------- */

/** `'5s'` / `'2f'` → step. A bare number is seconds — that is what was stored before frames existed. */
function parseSkipStep(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([sf])?\s*$/.exec(String(value ?? ''));
  const n = m ? Number(m[1]) : 0;
  if (!(n > 0)) return { n: 5, unit: 's' };
  return m[2] === 'f' ? { n: Math.round(n) || 1, unit: 'f' } : { n: Math.max(0.5, n), unit: 's' };
}

const stepLabel = (s) => `${s.n}${s.unit}`;
const stepWords = (s) => (s.unit === 'f' ? `${s.n} frame${s.n > 1 ? 's' : ''}` : `${s.n} s`);
const stepHint = (s) => (s.unit === 'f' ? ' — pauses playback' : '');

/** Step used by ← / → and the −/+ buttons (Shift = ×6), remembered per browser. */
function applySkipStep(value) {
  skipStep = parseSkipStep(value);
  $('skip-step').value = stepLabel(skipStep);
  $('btn-back').textContent = `−${stepLabel(skipStep)}`;
  $('btn-fwd').textContent = `+${stepLabel(skipStep)}`;
  $('btn-back').title = `Back ${stepWords(skipStep)} (←, Shift ×6)${stepHint(skipStep)}`;
  $('btn-fwd').title = `Forward ${stepWords(skipStep)} (→, Shift ×6)${stepHint(skipStep)}`;
  try { localStorage.setItem(SKIP_STORAGE_KEY, stepLabel(skipStep)); } catch { /* private mode */ }
}

function savedSkipStep() {
  try { return localStorage.getItem(SKIP_STORAGE_KEY); } catch { return null; }
}

/** Basemap / labels last chosen in this browser; config.json supplies the first-run default. */
function savedMapPrefs() {
  try { return JSON.parse(localStorage.getItem(MAP_STORAGE_KEY)) ?? {}; } catch { return {}; }
}

/** One skip in `dir` (−1 back, +1 forward); Shift multiplies the step by 6. */
function skipBy(dir, e) {
  const n = dir * skipStep.n * (e?.shiftKey ? 6 : 1);
  if (skipStep.unit === 'f') player.frameStep(n);
  else player.step(n);
}

/** Flip a checkbox and run its change handler, exactly as a click would. */
function toggle(id) {
  const box = $(id);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
}

const KEYS = new Map([
  [' ', () => player.toggle()],
  ['ArrowLeft', (e) => skipBy(-1, e)],
  ['ArrowRight', (e) => skipBy(1, e)],
  [',', () => player.frameStep(-1)],
  ['.', () => player.frameStep(1)],
  ['[', () => player.prevChapter()],
  [']', () => player.nextChapter()],
  ['m', () => toggle('follow')],
  ['l', () => toggle('follow')],
  ['h', () => toggle('hud-toggle')],
  ['g', () => toggle('gauges-toggle')],
  ['f', () => map.fitTrack()],
  ['b', () => map.toggleBasemap()],
  ['Home', () => player.seek(0)],
  ['End', () => player.seek(player.duration - 0.1)],
]);

function onKeyDown(e) {
  if (['input', 'select', 'textarea'].includes((e.target.tagName || '').toLowerCase())) return;
  if (document.querySelector('dialog[open]')) return; // a dialog owns the keyboard (Space must tick a box, not play)
  const action = KEYS.get(e.key) ?? KEYS.get(e.key.toLowerCase());
  if (!action) return;
  if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
  action(e);
}

function bindControls() {
  applySkipStep(savedSkipStep() ?? '5s');
  $('skip-step').addEventListener('change', (e) => applySkipStep(e.target.value));
  $('btn-play').addEventListener('click', () => player.toggle());
  $('btn-back').addEventListener('click', (e) => skipBy(-1, e));
  $('btn-fwd').addEventListener('click', (e) => skipBy(1, e));
  $('btn-prev').addEventListener('click', () => player.prevChapter());
  $('btn-next').addEventListener('click', () => player.nextChapter());
  $('rate').addEventListener('change', (e) => player.setRate(Number(e.target.value)));
  $('proxy').addEventListener('change', (e) => player.setProxy(e.target.checked));
  $('follow').addEventListener('change', (e) => map.setFollow(e.target.checked));
  $('color-speed').addEventListener('change', (e) => map.setColorBySpeed(e.target.checked));
  $('hud-toggle').addEventListener('change', (e) => $('hud').classList.toggle('hidden', !e.target.checked));
  $('gauges-toggle').addEventListener('change', (e) => {
    gauges.setEnabled(e.target.checked);
    gauges.setAvailable(!!state.motion, !!state.motion?.hasGyro);
  });
  $('rescan-btn').addEventListener('click', () => loadLibrary(api.rescan()));
  $('import-btn').addEventListener('click', () => importDialog.open());
  $('root-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = $('root-input').value.trim();
    if (!p) return;
    if (await loadLibrary(api.addRoot(p))) $('root-input').value = '';
  });
  video.addEventListener('click', () => player.toggle());
  video.addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen(); else $('video-wrap').requestFullscreen?.(); });
  video.addEventListener('loadeddata', hideVideoOverlay);
  document.addEventListener('keydown', onKeyDown);
}

/** Basemap defaults from config.json, plus a warning when the K2 token is missing. */
async function applyMapConfig() {
  let cfg;
  try { cfg = (await api.config()).map; } catch { return; }
  if (!cfg) return;
  const saved = savedMapPrefs();
  if (saved.basemap == null && cfg.basemap) map.setBasemap(cfg.basemap, { user: false });
  if (saved.labels == null) map.setLabels(cfg.labels !== false, { user: false });
  if (!cfg.configured) toast('No map token configured — add map.token to config.json to load the K2 basemap.', 'warn', 12000);
}

/* ---------- boot ---------- */

async function boot() {
  // the viewer is always muted by design
  video.muted = true;
  video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; });
  bindControls();
  await applyMapConfig();
  const data = await loadLibrary();
  if (data && !data.recordings.length && !data.roots.length) $('root-input').focus();
  importDialog.watch(); // an import started before a reload keeps reporting in the status bar
  window.addEventListener('resize', () => map.invalidate());
  setTimeout(() => map.invalidate(), 50);
}

boot();
