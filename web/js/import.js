/**
 * Import dialog: copy clips from the GoPro on USB into <destination>/<YYYY-MM-DD>/, the destination
 * picked in the Mac's own folder panel (served by the local server, never typed), each clip with
 * its LRV proxy (ticked by default) and THM thumbnail (unticked by default) as chosen.
 * Clips the ledger already knows are listed unticked ("imported …"); ticking one imports it again.
 * A running job is polled once a second — also after the dialog is closed — so the status bar
 * and the library follow it; when it ends the dialog comes back to ask whether the clips it
 * brought in should be deleted from the camera.
 */

import { api } from './api.js';
import { el, fmtBytes, fmtTime } from './util.js';

const POLL_MS = 1000;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isMp4 = (name) => /\.mp4$/i.test(name);
const itemBytes = (item, { lrv }) => item.size + (lrv && isMp4(item.name) ? item.lrvSize : 0);
const sum = (items, f) => items.reduce((n, it) => n + f(it), 0);
const clips = (n) => `${n} clip${n === 1 ? '' : 's'}`;
/** Camera clock (local time stored as UTC) → "2026-09-05 08:48". */
const fmtRecorded = (creEpochSec) => new Date(creEpochSec * 1000).toISOString().replace('T', ' ').slice(0, 16);
const shortDir = (p) => { const parts = p.split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; };
const chip = (text) => el('span', { class: 'badge', text });
const NO_CAMERA_HINT = 'Connect the GoPro by USB with its USB connection set to GoPro Connect (Preferences › Connections), wake it up, then choose “Look again”.';

/** Status cell of a clip that is part of a job. */
function jobStatus(it) {
  if (it.deleted) return { text: 'imported · deleted from camera ✓', cls: 'ok' };
  if (it.deleteError) return { text: `imported · delete failed: ${it.deleteError}`, cls: 'bad', title: it.deleteError };
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

/** Clips a finished job brought in completely and has not deleted from the camera yet. */
const deletable = (job) => job.items.filter((it) => it.status === 'done' && !it.deleted && !it.deleteError);

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
  const deleted = job.items.filter((it) => it.deleted).length;
  const took = fmtTime((new Date(job.finishedAt) - new Date(job.startedAt)) / 1000, 0);
  const head = job.state === 'cancelled' ? 'Import stopped' : 'Import finished';
  const tail = `${failed ? ` · ${failed} failed` : ''}${deleted ? ` · ${deleted} deleted from the camera` : ''}`;
  return `${head}: ${done} of ${clips(n)} (${fmtBytes(job.doneBytes)}) in ${took}${tail} → ${job.dest}`;
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
    this.asked = false;     // the delete-from-camera question was answered (or dismissed) for this job
    $('import-close').addEventListener('click', () => dialog.close());
    $('import-retry').addEventListener('click', () => this.#refresh());
    $('import-choose').addEventListener('click', () => this.#chooseFolder());
    $('import-start').addEventListener('click', () => this.#start());
    $('import-stop').addEventListener('click', () => api.cancelImport().catch((e) => this.h.toast(e.message, 'error')));
    $('import-delete').addEventListener('click', () => this.#deleteFromCamera());
    $('import-keep').addEventListener('click', () => { this.asked = true; this.#renderFooter(); });
    for (const box of dialog.querySelectorAll('.import-options input')) box.addEventListener('change', () => this.#render());
  }

  /** Sidecar choices as ticked in the dialog. */
  get options() { return { lrv: $('import-lrv').checked, thm: $('import-thm').checked }; }
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
    this.#applyDefaults(this.job.options);
    this.#render();
  }

  #applyDefaults({ dest, lrv, thm }) {
    if (dest && !this.dest) this.dest = dest;
    if (typeof lrv === 'boolean') $('import-lrv').checked = lrv;
    if (typeof thm === 'boolean') $('import-thm').checked = thm;
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

  /** Rows to show: the card when we have it, else the job's own clips, else nothing. */
  #items() {
    if (this.snap?.camera) return this.snap.items;
    return this.job ? this.job.items : null;
  }

  #cameraLabel() {
    const snap = this.snap;
    if (snap?.camera) return `${snap.camera.model} · ${snap.items.length} file(s) on the card · ${fmtBytes(sum(snap.items, (it) => itemBytes(it, { lrv: true })))}`;
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
    for (const box of this.dialog.querySelectorAll('#import-choose, .import-options input')) box.disabled = this.locked;
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
    const { lrv, thm } = this.options;
    const chips = isMp4(it.name) ? [lrv && it.lrvSize > 0 ? chip('LRV') : null, thm ? chip('THM') : null] : [];
    const status = jobItem ? jobStatus(jobItem) : cardStatus(it);
    const cell = el('span', { class: `import-status ${status.cls}` }, [el('span', { text: status.text, title: status.title ?? null })]);
    if (status.frac != null) cell.append(el('div', { class: 'bar' }, el('div', { style: `width:${Math.round(100 * status.frac)}%` })));
    return el('label', { class: `import-row${it.imported ? ' imported' : ''}` }, [
      box,
      el('span', { class: 'import-name' }, [el('b', { text: it.name }), ...chips]),
      el('span', { class: 'import-when', text: fmtRecorded(it.cre) }),
      el('span', { class: 'import-size', text: fmtBytes(itemBytes(it, { lrv })) }),
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
    this.#renderPrompt();
    if (job) { $('import-summary').textContent = jobSummary(job); return; }
    const shown = this.#items() ?? [];
    const picked = shown.filter((it) => this.selected.has(it.key));
    const bytes = sum(picked, (it) => itemBytes(it, this.options));
    start.disabled = !picked.length || !this.dest;
    start.textContent = picked.length ? `Import ${clips(picked.length)} (${fmtBytes(bytes)})` : 'Import';
    $('import-summary').textContent = this.snap?.camera ? `${picked.length} of ${shown.length} selected — new clips are ticked, imported ones are not` : '';
  }

  /** The question that follows a finished import: delete what it brought in from the camera? */
  #renderPrompt() {
    const job = this.job;
    const pending = job && !job.running && !this.asked ? deletable(job) : [];
    $('import-prompt').classList.toggle('hidden', !pending.length);
    if (!pending.length) return;
    $('import-prompt-text').textContent = `${clips(pending.length)} (${fmtBytes(sum(pending, (it) => it.total))}) ${pending.length === 1 ? 'is' : 'are'} now safely on disk. Delete ${pending.length === 1 ? 'it' : 'them'} from the camera to free the card?`;
    $('import-delete').textContent = `Delete ${clips(pending.length)} from camera`;
  }

  /* ---------- job ---------- */

  async #start() {
    const keys = (this.#items() ?? []).filter((it) => this.selected.has(it.key)).map((it) => it.key);
    try {
      this.job = await api.startImport({ dest: this.dest, keys, ...this.options });
      this.asked = false;
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
      if (this.job) this.#finish(this.job);
    } catch (e) {
      this.h.toast(`Lost track of the import: ${e.message}`, 'error', 8000);
    } finally {
      this.polling = false;
    }
  }

  /** A finished job with something to delete brings the dialog back so the question is seen. */
  #finish(job) {
    this.h.onFinished(job);
    if (!this.dialog.open && deletable(job).length) { this.dialog.showModal(); this.#showJob(); }
  }

  async #deleteFromCamera() {
    const keys = deletable(this.job).map((it) => it.key);
    const button = $('import-delete');
    button.disabled = true;
    try {
      this.job = await api.deleteImported(keys);
      this.asked = true;
      const failed = this.job.items.filter((it) => it.deleteError).length;
      this.h.toast(failed ? `${failed} of ${clips(keys.length)} could not be deleted from the camera` : `Deleted ${clips(keys.length)} from the camera`, failed ? 'warn' : 'info', 7000);
    } catch (e) {
      this.h.toast(`Delete failed: ${e.message}`, 'error', 8000);
    } finally {
      button.disabled = false;
      this.#render();
    }
  }
}
