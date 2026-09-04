/**
 * Stats bar under the map: camera settings as soon as a recording is selected,
 * ride statistics once its telemetry has loaded.
 */

import { fmtTime, fmtClock, fmtDistance, describeSettings, MS_TO_KMH, el } from './util.js';

const chip = (label, value) => el('span', {}, [`${label} `, el('b', { text: value })]);
const count = (cls, text) => el('b', { class: `fix ${cls}`, text });
const cameraChip = (model, firmware) => chip('Camera', `${model ?? '?'}${firmware ? ` · ${firmware}` : ''}`);
const settingChips = (settings) => describeSettings(settings).map(([label, value]) => chip(label, value));
const show = (chips) => document.getElementById('stats').replaceChildren(...chips);

/** Before telemetry: what the MP4 header says about the camera and its settings. */
export function renderSettings(rec) {
  const s = rec.settings;
  const chips = [cameraChip(s?.model ?? rec.firmware, s?.firmware), ...settingChips(s)];
  if (!s) chips.push(chip('Settings', 'not in file'));
  show(chips);
}

/** Sample counts per fix quality, in the colours the GPS status strip uses. */
function fixChip(c = {}) {
  return el('span', {}, ['Fix ',
    count('ok', `3D ${c.fix3d ?? 0}`), ' / ',
    count('warn', `2D ${c.fix2d ?? 0}`), ' / ',
    count('bad', `none ${c.none ?? 0}`),
  ]);
}

function rideChips(s) {
  return [
    chip('Distance', fmtDistance(s.distanceM)),
    chip('Max', `${(s.maxSpeedMs * MS_TO_KMH).toFixed(1)} km/h`),
    chip('Avg', `${(s.avgSpeedMs * MS_TO_KMH).toFixed(1)} km/h`),
    chip('Moving', fmtTime(s.movingTimeSec, 0)),
    chip('Elev +/−', `${Math.round(s.elevGainM)} / ${Math.round(s.elevLossM)} m`),
    fixChip(s.fixCounts),
  ];
}

/** After telemetry: ride statistics (or why there are none), camera, settings, UTC start. */
export function renderStats(tel, track) {
  const chips = track.hasGps ? rideChips(tel.stats || {}) : [chip('GPS', tel.gps ? 'no fix' : 'not recorded')];
  chips.push(cameraChip(tel.camera?.model ?? tel.settings?.model, tel.camera?.firmware), ...settingChips(tel.settings));
  if (tel.utcOffsetMs != null) {
    const label = tel.utcSource === 'camera-clock' ? 'Start (UTC, camera clock)' : 'Start (UTC)';
    chips.push(chip(label, fmtClock(tel.utcOffsetMs, { utc: true, withDate: true })));
  }
  show(chips);
}
