/** Sidebar: media roots + recordings grouped by date. */

import { api } from './api.js';
import { el, fmtTime, fmtCameraTime, fmtBytes, describeSettings, shortPath } from './util.js';

const badge = (text, cls = '', title = null) => el('span', { class: `badge ${cls}`.trim(), text, title });
const call = (v, r) => (typeof v === 'function' ? v(r) : v);

/**
 * Badges of a recording: [applies(r), text, class, title]. The GPS badge only when the receiver
 * actually had a fix; a GPS stream without lock is labelled NO FIX.
 */
const BADGE_RULES = [
  [(r) => r.hasGps && r.hasGpsFix, 'GPS', 'gps'],
  [(r) => r.hasGps && !r.hasGpsFix, 'NO FIX', 'nofix', 'GPS was on but never locked'],
  [(r) => r.hasImu, 'IMU', 'imu'],
  [(r) => !r.hasGps && !r.hasImu && r.hasGpmd, 'TELEMETRY'],
  [(r) => r.settings?.stabilization?.enabled, 'HS', 'hs', (r) => `HyperSmooth on (${r.settings.stabilization.mode || 'EIS'})`],
  [(r) => r.settings?.stabilization && !r.settings.stabilization.enabled, 'HS OFF', 'hsoff', 'HyperSmooth (stabilisation) was off'],
  [(r) => r.hasProxy, 'LRV', 'proxy'],
  [(r) => r.chapters.length > 1, (r) => `${r.chapters.length} ch`],
];

const badgesFor = (r) => BADGE_RULES.filter(([applies]) => applies(r)).map(([, text, cls, title]) => badge(call(text, r), cls, call(title, r)));

function thumbnail(r) {
  if (r.thumbId) return el('img', { class: 'rec-thumb', src: api.thumbUrl(r.thumbId), alt: '', loading: 'lazy' });
  return el('div', { class: 'rec-thumb empty', text: r.codec ? r.codec.toUpperCase() : 'MP4' });
}

function tooltip(r) {
  const settings = describeSettings(r.settings).map(([k, v]) => `${k}: ${v}`).join('\n');
  const start = r.startTimeUtc ? `\nStart: ${fmtCameraTime(r.startTime)} camera time · ${fmtCameraTime(r.startTimeUtc)} UTC` : '';
  return `${r.dir}\n${r.chapters.map((c) => c.file).join(', ')}${start}${settings ? `\n\n${settings}` : ''}`;
}

const searchText = (r) => `${r.name} ${r.dir} ${r.startTime || ''} ${r.chapters.map((c) => c.file).join(' ')}`.toLowerCase();

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

  /** A configured folder; one the last scan could not find on disk is struck through. */
  #rootRow(r) {
    const missing = r.exists === false;
    return el('div', { class: `root${missing ? ' missing' : ''}`, title: missing ? `${r.path} — folder not found on disk` : r.path }, [
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
