/** Sidebar: media roots + recordings grouped by date. */

import { api } from './api.js';
import { el, fmtTime, fmtCameraTime, fmtBytes, describeSettings } from './util.js';

const badge = (text, cls = '', title = null) => el('span', { class: `badge ${cls}`.trim(), text, title });

/** Telemetry / stabilisation / proxy / chapter badges of a recording. */
function badgesFor(r) {
  const badges = [];
  // GPS badge only when the receiver actually had a fix; a GPS stream without lock is labelled NO FIX
  if (r.hasGps && r.hasGpsFix) badges.push(badge('GPS', 'gps'));
  else if (r.hasGps) badges.push(badge('NO FIX', 'nofix', 'GPS was on but never locked'));
  if (r.hasImu) badges.push(badge('IMU', 'imu'));
  if (!r.hasGps && !r.hasImu && r.hasGpmd) badges.push(badge('TELEMETRY'));
  const stab = r.settings?.stabilization;
  if (stab?.enabled) badges.push(badge('HS', 'hs', `HyperSmooth on (${stab.mode || 'EIS'})`));
  else if (stab) badges.push(badge('HS OFF', 'hsoff', 'HyperSmooth (stabilisation) was off'));
  if (r.hasProxy) badges.push(badge('LRV', 'proxy'));
  if (r.chapters.length > 1) badges.push(badge(`${r.chapters.length} ch`));
  return badges;
}

function thumbnail(r) {
  if (r.thumbId) return el('img', { class: 'rec-thumb', src: api.thumbUrl(r.thumbId), alt: '', loading: 'lazy' });
  return el('div', { class: 'rec-thumb empty', text: r.codec ? r.codec.toUpperCase() : 'MP4' });
}

function tooltip(r) {
  const settings = describeSettings(r.settings).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${r.dir}\n${r.chapters.map((c) => c.file).join(', ')}${settings ? `\n\n${settings}` : ''}`;
}

const searchText = (r) => `${r.name} ${r.dir} ${r.startTime || ''} ${r.chapters.map((c) => c.file).join(' ')}`.toLowerCase();

const shortPath = (p) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

export class LibraryView {
  /**
   * @param {{ list: HTMLElement, roots: HTMLElement, search: HTMLInputElement }} els
   * @param {{ onSelect: (rec:object)=>void, onRemoveRoot: (id:string)=>void }} handlers
   */
  constructor(els, handlers) {
    this.els = els;
    this.h = handlers;
    this.data = null;
    this.activeId = null;
    this.filter = '';
    els.search.addEventListener('input', () => { this.filter = els.search.value.trim().toLowerCase(); this.render(); });
  }

  set(data) {
    this.data = data;
    this.render();
  }

  setActive(id) {
    this.activeId = id;
    for (const n of this.els.list.querySelectorAll('.rec')) n.classList.toggle('active', n.dataset.id === id);
  }

  render() {
    const { list, roots } = this.els;
    roots.innerHTML = '';
    list.innerHTML = '';
    if (!this.data) return;
    roots.append(...this.data.roots.map((r) => this.#rootRow(r)));
    const recs = this.data.recordings.filter((r) => !this.filter || searchText(r).includes(this.filter));
    if (!recs.length) { list.append(el('div', { class: 'lib-empty', text: this.#emptyMessage() })); return; }
    let lastDate = null;
    for (const r of recs) {
      const date = (r.startTime || '').slice(0, 10) || 'unknown date';
      if (date !== lastDate) { list.append(el('div', { class: 'lib-date', text: date })); lastDate = date; }
      list.append(this.#recordingRow(r));
    }
  }

  #emptyMessage() {
    if (!this.data.roots.length) return 'Add a media folder above to get started — e.g. the DCIM folder of a GoPro SD card.';
    return this.filter ? 'No recordings match the filter.' : 'No GoPro videos found in the configured folders.';
  }

  #rootRow(r) {
    return el('div', { class: 'root', title: r.path }, [
      el('span', { text: shortPath(r.path) }),
      el('button', { type: 'button', title: 'Remove this folder from the library', onclick: () => this.h.onRemoveRoot(r.id) }, '✕'),
    ]);
  }

  #recordingRow(r) {
    const meta = [
      el('span', { text: fmtCameraTime(r.startTime).slice(11) }),
      el('span', { text: r.width ? `${r.width}×${r.height}` : '' }),
      el('span', { text: r.fps ? `${Math.round(r.fps)}fps` : '' }),
      el('span', { text: fmtBytes(r.sizeBytes) }),
      r.settings?.fov ? el('span', { text: r.settings.fov.name }) : null,
    ];
    const attrs = { class: 'rec' + (r.id === this.activeId ? ' active' : ''), role: 'listitem', 'data-id': r.id, title: tooltip(r), onclick: () => this.h.onSelect(r) };
    return el('div', attrs, [
      thumbnail(r),
      el('div', {}, [
        el('div', { class: 'rec-name' }, [el('span', { text: r.name }), el('span', { text: fmtTime(r.durationSec, 0) })]),
        el('div', { class: 'rec-meta' }, meta),
        el('div', { class: 'rec-meta' }, badgesFor(r)),
      ]),
    ]);
  }
}
