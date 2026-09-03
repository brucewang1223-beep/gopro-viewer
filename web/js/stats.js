/**
 * Stats bar under the map: camera settings as soon as a recording is selected,
 * ride statistics once its telemetry has loaded.
 */

import { fmtTime, fmtClock, fmtDistance, describeSettings, MS_TO_KMH, el } from './util.js';

const chip = (label, value) => el('span', {}, [`${label} `, el('b', { text: value })]);
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

function rideChips(s) {
  return [
    chip('Distance', fmtDistance(s.distanceM)),
    chip('Max', `${(s.maxSpeedMs * MS_TO_KMH).toFixed(1)} km/h`),
    chip('Avg', `${(s.avgSpeedMs * MS_TO_KMH).toFixed(1)} km/h`),
    chip('Moving', fmtTime(s.movingTimeSec, 0)),
    chip('Elev +/−', `${Math.round(s.elevGainM)} / ${Math.round(s.elevLossM)} m`),
    chip('Fix 3D/2D/none', `${s.fixCounts?.fix3d ?? 0}/${s.fixCounts?.fix2d ?? 0}/${s.fixCounts?.none ?? 0}`),
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
