/**
 * Bottom-left HUD over the video. Every field is written at a constant character width
 * (monospace + white-space: pre) so values never shift the layout while playing.
 * Column 1 = 12 characters, column 2 = 18 characters.
 */

import { $, fmtClock, fmtKmh, fmtNum, padL, padR } from './util.js';

const COL1 = 12;
const COL2 = 18;

export function setHudChapter(index, count) {
  $('hud-chapter').textContent = padR(`${index}/${count}`, COL2);
}

/** Fix label and colour class for a GPS sample (null sample = no data at all). */
function fixStatus(s) {
  if (!s) return { label: 'no data', cls: 'bad' };
  const dop = s.dop != null ? ` · DOP ${padL(s.dop.toFixed(1), 4)}` : '';
  if (s.fix >= 3) return { label: `3D fix${dop}`, cls: 'ok' };
  if (s.fix === 2) return { label: `2D fix${dop}`, cls: 'warn' };
  return { label: `no fix${dop}`, cls: 'bad' };   // 0, an odd value, or no fix reported at all
}

/** Dominant direction of the horizontal (gravity-free) acceleration; empty when idle. */
function gDirection(m) {
  if (m.gTotal < 0.05) return '';
  if (Math.abs(m.lonG) >= Math.abs(m.latG)) return m.lonG >= 0 ? 'acc' : 'brake';
  return m.latG >= 0 ? 'right' : 'left';
}

function writePosition(s) {
  $('hud-speed').textContent = padL(fmtKmh(s?.speed2d), 5);
  $('hud-alt').textContent = padR(`${fmtNum(s?.alt, 1, 7)} m`, COL1);
  $('hud-lat').textContent = fmtNum(s?.lat, 6, 11);
  $('hud-lon').textContent = fmtNum(s?.lon, 6, 11);
  const { label, cls } = fixStatus(s);
  const fixEl = $('hud-fix');
  fixEl.textContent = padR(label, COL2);
  fixEl.className = `v2 fix ${cls}`;
}

/**
 * @param {number} t global time (s)
 * @param {object|null} sample Track.sampleAt(t)
 * @param {object|null} motion MotionModel.at(t)
 * @param {number|null} utcOffsetMs wall-clock anchor of the recording (utc = t*1000 + offset)
 */
export function updateHud(t, sample, motion, utcOffsetMs) {
  writePosition(sample);
  const utc = utcOffsetMs != null ? utcOffsetMs + t * 1000 : sample?.utc;
  $('hud-utc').textContent = padR(fmtClock(utc, { utc: true }), COL1);
  $('hud-local').textContent = padR(fmtClock(utc, { utc: false }), COL2);
  $('hud-acc').textContent = padR(motion ? `${motion.gTotal.toFixed(2)} g ${gDirection(motion)}` : '--', COL1);
}
