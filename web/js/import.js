/**
 * Import dialog: copy clips from the GoPro on USB into <destination>/<YYYY-MM-DD>/, the destination
 * picked in the Mac's own folder panel (served by the local server, never typed).
 * Clips the ledger already knows are listed unticked ("imported …"); ticking one imports it again.
 * A running job is polled once a second — also after the dialog is closed — so the status bar
 * and the library follow it.
 */

import { api } from './api.js';
import { el, fmtBytes, fmtTime } from './util.js';

const POLL_MS = 1000;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isMp4 = (name) => /\.mp4$/i.test(name);
const eligible = (item, mode) => mode === 'all' || isMp4(item.name);
const hasSidecars = (item, mode) => mode === 'all' && isMp4(item.name);
const itemBytes = (item, mode) => item.size + (hasSidecars(item, mode) ? item.lrvSize : 0);
const sum = (items, f) => items.reduce((n, it) => n + f(it), 0);
/** Camera clock (local time stored as UTC) → "2026-09-05 08:48". */
const fmtRecorded = (creEpochSec) => new Date(creEpochSec * 1000).toISOString().replace('T', ' ').slice(0, 16);
const shortDir = (p) => { const parts = p.split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; };
const chip = (text) => el('span', { class: 'badge', text });
const NO_CAMERA_HINT = 'Connect the GoPro by USB with its USB connection set to GoPro Connect (Preferences › Connections), wake it up, then choose “Look again”.';

/** Status cell of a clip that is part of a job. */
function jobStatus(it) {
  if (it.status === 'downloading') return { text: `${fmtBytes(it.bytes)} / ${fmtBytes(it.total)}`, cls: 'busy', frac: it.total ? it.bytes / it.total : 0 };
  if (it.status === 'done') return it.files.every((f) => f.status === 'present' || f.status === 'absent') ? { text: 'already on disk ✓', cls: 'ok' } : { text: 'done ✓', cls: 'ok' };
  if (it.status === 'failed') return { text: `failed: ${it.error}`, cls: 'bad', title: it.error };
  if (it.status === 'cancelled') return { text: 'cancelled', cls: 'muted' };
  return { text: 'queued', cls: 'muted' };
}

/** Status cell of a clip as listed on the card. */
function cardStatus(it) {
  if (!it.imported) return { text: 'new', cls: 'new' };
  const when = it.imported.at.slice(0, 16).replace('T', ' ');
  return { text: `imported ${when.slice(0, 10)} → ${shortDir(it.imported.dest)}`, cls: 'muted', title: `Imported ${when} into ${it.imported.dest}\nTick to import it again.` };
}

/** One line for the footer / status bar: "Importing 2/5 · 34% · 43.1 MB/s · 7:24 left". */
export function jobSummary(job) {
  const n = job.items.length;
  const pct = job.totalBytes ? Math.round(100 * job.doneBytes / job.totalBytes) : 0;
  if (job.state === 'running') {
    const settled = job.items.filter((it) => it.status !== 'pending' && it.status !== 'downloading').length;
    const rate = job.rateBps ? ` · ${fmtBytes(job.rateBps)}/s · ${fmtTime((job.totalBytes - job.doneBytes) / job.rateBps, 0)} left` : '';
    return `Importing ${Math.min(settled + 1, n)}/${n} · ${pct}%${rate}`;
  }
  const done = job.items.filter((it) => it.status === 'done').length;
  const failed = job.items.filter((it) => it.status === 'failed').length;
  const took = fmtTime((new Date(job.finishedAt) - new Date(job.startedAt)) / 1000, 0);
  const head = job.state === 'cancelled' ? 'Import stopped' : 'Import finished';
  return `${head}: ${done} of ${n} clip${n > 1 ? 's' : ''} (${fmtBytes(job.doneBytes)}) in ${took}${failed ? ` · ${failed} failed` : ''} → ${job.dest}`;
}

export class ImportDialog {
  /**
   * @param {HTMLDialogElement} dialog
   * @param {{ toast: (msg:string, kind?:string, ms?:number)=>void, onProgress: (job:object)=>void, onFinished: (job:object)=>void }} handlers
   */
  constructor(dialog, handlers) {
    this.dialog = dialog;
    this.h = handlers;
    this.snap = null;       // last GET /api/import
    this.job = null;        // job being watched (running) or whose result the list shows
    this.selected = new Set();
    this.dest = '';         // destination folder, chosen in the native panel
    this.polling = false;
    $('import-close').addEventListener('click', () => dialog.close());
    $('import-retry').addEventListener('click', () => this.#refresh());
    $('import-choose').addEventListener('click', () => this.#chooseFolder());
    $('import-start').addEventListener('click', () => this.#start());
    $('import-stop').addEventListener('click', () => api.cancelImport().catch((e) => this.h.toast(e.message, 'error')));
    for (const r of dialog.querySelectorAll('input[name="import-mode"]')) r.addEventListener('change', () => this.#render());
  }

  get mode() { return this.dialog.querySelector('input[name="import-mode"]:checked').value; }
  get busy() { return this.job?.state === 'running'; }
  /** Inputs are frozen while a job runs and while its result is on screen — "Look again" starts afresh. */
  get locked() { return !!this.job; }

  async open() {
    this.dialog.showModal();
    if (this.busy) { this.#showJob(); return; }   // opened while an import runs: no card probe, just the job
    await this.#refresh();
  }

  /** Picks up a job that was already running (page reload) so the status bar keeps following it. */
  async watch() {
    const job = await api.importJob().catch(() => null);
    if (job?.state === 'running') { this.job = job; this.#poll(); }
  }

  async #refresh() {
    if (this.busy) return;
    this.job = null;
    this.snap = null;
    this.#render();
    try {
      this.snap = await api.importSource();
    } catch (e) {
      this.snap = { camera: null, reason: e.message, items: [], defaults: {} };
    }
    this.#applyDefaults(this.snap.defaults ?? {});
    this.selected = new Set(this.snap.items.filter((it) => !it.imported).map((it) => it.key));
    if (this.snap.job?.state === 'running') { this.job = this.snap.job; this.#poll(); }
    this.#render();
  }

  #showJob() {
    this.dest = this.job.dest;
    this.#applyDefaults({ mode: this.job.mode });
    this.#render();
  }

  #applyDefaults({ dest, mode }) {
    if (dest && !this.dest) this.dest = dest;
    const radio = this.dialog.querySelector(`input[name="import-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
  }

  /** The native folder panel opens on the Mac's screen; the server answers when it is closed. */
  async #chooseFolder() {
    const button = $('import-choose');
    button.disabled = true;
    try {
      const { path } = await api.chooseImportFolder(this.dest);
      if (path) { this.dest = path; this.#renderFooter(); }
    } catch (e) {
      this.h.toast(`Could not open the folder panel: ${e.message}`, 'error', 8000);
    } finally {
      button.disabled = this.locked;
    }
  }

  /* ---------- rendering ---------- */

  /** Rows to show: the card (filtered by mode) when we have it, else the job's own clips, else nothing. */
  #items() {
    if (this.snap?.camera) return this.snap.items.filter((it) => eligible(it, this.mode));
    return this.job ? this.job.items : null;
  }

  #cameraLabel() {
    const snap = this.snap;
    if (snap?.camera) return `${snap.camera.model} · ${snap.items.length} file(s) on the card · ${fmtBytes(sum(snap.items, (it) => itemBytes(it, 'all')))}`;
    if (this.job) return `${this.job.camera} · ${this.busy ? 'importing…' : 'import finished'}`;
    return snap ? 'No camera' : 'Looking for a camera on USB…';
  }

  #render() {
    const list = $('import-list');
    list.innerHTML = '';
    const items = this.#items();
    if (items) {
      const jobItems = new Map((this.job?.items ?? []).map((it) => [it.key, it]));
      list.append(this.#headerRow(items), ...items.map((it) => this.#row(it, jobItems.get(it.key))));
    } else if (this.snap) {
      list.append(el('div', { class: 'import-empty', text: `${this.snap.reason}.\n${NO_CAMERA_HINT}` }));
    }
    const label = $('import-camera');
    label.textContent = this.#cameraLabel();
    label.classList.toggle('busy', !this.snap || this.busy);
    for (const box of this.dialog.querySelectorAll('#import-choose, input[name="import-mode"]')) box.disabled = this.locked;
    this.#renderFooter();
  }

  #headerRow(items) {
    const all = el('input', { type: 'checkbox', title: 'Select all / none' });
    all.checked = items.length > 0 && items.every((it) => this.selected.has(it.key));
    all.disabled = this.locked || !items.length;
    all.addEventListener('change', () => {
      for (const it of items) {
        if (all.checked) this.selected.add(it.key); else this.selected.delete(it.key);
      }
      this.#render();
    });
    return el('div', { class: 'import-row head' }, [all, el('span', { text: 'File' }), el('span', { text: 'Recorded' }), el('span', { class: 'import-size', text: 'Size' }), el('span', { text: 'Status' })]);
  }

  #row(it, jobItem) {
    const box = el('input', { type: 'checkbox', onchange: () => { if (box.checked) this.selected.add(it.key); else this.selected.delete(it.key); this.#render(); } }); // re-render: the header box mirrors the selection
    box.checked = this.selected.has(it.key);
    box.disabled = this.locked;
    const chips = hasSidecars(it, this.mode) && it.lrvSize > 0 ? [chip('LRV')] : [];
    const status = jobItem ? jobStatus(jobItem) : cardStatus(it);
    const cell = el('span', { class: `import-status ${status.cls}` }, [el('span', { text: status.text, title: status.title ?? null })]);
    if (status.frac != null) cell.append(el('div', { class: 'bar' }, el('div', { style: `width:${Math.round(100 * status.frac)}%` })));
    return el('label', { class: `import-row${it.imported ? ' imported' : ''}` }, [
      box,
      el('span', { class: 'import-name' }, [el('b', { text: it.name }), ...chips]),
      el('span', { class: 'import-when', text: fmtRecorded(it.cre) }),
      el('span', { class: 'import-size', text: fmtBytes(itemBytes(it, this.mode)) }),
      cell,
    ]);
  }

  #renderFooter() {
    const job = this.job;
    const dest = $('import-dest');
    dest.textContent = this.dest || 'No folder chosen yet';
    dest.classList.toggle('empty', !this.dest);
    $('import-progress').classList.toggle('hidden', !job);
    if (job) $('import-bar').style.width = `${job.totalBytes ? Math.min(100, 100 * job.doneBytes / job.totalBytes) : 0}%`;
    $('import-stop').classList.toggle('hidden', !this.busy);
    $('import-retry').disabled = this.busy;
    const start = $('import-start');
    start.classList.toggle('hidden', this.locked);
    if (job) { $('import-summary').textContent = jobSummary(job); return; }
    const shown = this.#items() ?? [];
    const picked = shown.filter((it) => this.selected.has(it.key));
    const bytes = sum(picked, (it) => itemBytes(it, this.mode));
    start.disabled = !picked.length || !this.dest;
    start.textContent = picked.length ? `Import ${picked.length} clip${picked.length > 1 ? 's' : ''} (${fmtBytes(bytes)})` : 'Import';
    $('import-summary').textContent = this.snap?.camera ? `${picked.length} of ${shown.length} selected — new clips are ticked, imported ones are not` : '';
  }

  /* ---------- job ---------- */

  async #start() {
    const keys = (this.#items() ?? []).filter((it) => this.selected.has(it.key)).map((it) => it.key);
    try {
      this.job = await api.startImport({ dest: this.dest, mode: this.mode, keys });
      this.dest = this.job.dest;
      this.#render();
      this.#poll();
    } catch (e) {
      this.h.toast(`Import not started: ${e.message}`, 'error', 8000);
    }
  }

  async #poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      while (this.job?.state === 'running') {
        await sleep(POLL_MS);
        this.job = (await api.importJob()) ?? this.job;
        if (this.dialog.open) this.#render();
        this.h.onProgress(this.job);
      }
      if (this.job) this.h.onFinished(this.job);
    } catch (e) {
      this.h.toast(`Lost track of the import: ${e.message}`, 'error', 8000);
    } finally {
      this.polling = false;
    }
  }
}
