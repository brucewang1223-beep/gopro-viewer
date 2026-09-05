/**
 * Import from the camera connected by USB: a snapshot of the card annotated with the ledger,
 * one job at a time that copies the chosen files into `<dest>/<YYYY-MM-DD>/` (recording each
 * clip in the ledger the moment it is complete), and — on request, afterwards — deletion of
 * the clips that job brought in from the camera.
 *
 * Sidecars are options, not modes: every card entry is eligible, and for an MP4 the LRV proxy
 * (`lrv`, default on) and the THM thumbnail (`thm`, default off) come along when ticked.
 * Selection is the UI's: by default it ticks what the ledger does not know, so a clip imported
 * before (deleted locally or not) only comes back when the user ticks it by hand.
 */

import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { GoProCamera, discoverCameraUrl } from './gopro-camera.js';
import { importKey } from './import-ledger.js';
import { httpError } from './http-error.js';
import { sizeOf } from './fs-util.js';
import { shortId } from './ids.js';
import { createLogger } from './log.js';

const log = createLogger('import');
const RATE_WINDOW_MS = 5000;
const RATE_SAMPLE_MS = 200;

const isMp4 = (name) => /\.mp4$/i.test(name);
const stem = (name) => name.replace(/\.[^.]+$/, '');

/** Folder name of a clip. The camera clock stores local time as if it were UTC, so UTC getters give the local date. */
export function dateFolder(creEpochSec) {
  if (!(creEpochSec > 0)) return 'undated';   // an entry without a usable creation time still imports, into its own folder
  return new Date(creEpochSec * 1000).toISOString().slice(0, 10);
}

/** Card name of a clip's LRV proxy: GX010004.MP4 → GL010004.LRV, GOPR0001.MP4 → GOPR0001.LRV. */
export function proxyName(name) {
  const base = stem(name);
  return /^G[XH]/i.test(base) ? `GL${base.slice(2)}.LRV` : `${base}.LRV`;
}

/** Card name of a clip's THM thumbnail: GX010004.MP4 → GX010004.THM. */
export const thumbName = (name) => `${stem(name)}.THM`;

/**
 * Files to fetch for one card entry, the entry itself first. The THM's size is not in the
 * media list, so it is `null` until fetched (and never verified by count).
 * @param {{ lrv: boolean, thm: boolean }} options
 */
export function filesFor(item, { lrv, thm }) {
  const files = [{ name: item.name, size: item.size, kind: 'main' }];
  if (!isMp4(item.name)) return files;
  if (lrv && item.lrvSize > 0) files.push({ name: proxyName(item.name), size: item.lrvSize, kind: 'proxy' });
  if (thm) files.push({ name: thumbName(item.name), size: null, kind: 'thumb' });
  return files;
}

/** Card entries oldest first. */
export const oldestFirst = (items) => [...items].sort((a, b) => a.cre - b.cre || a.name.localeCompare(b.name));

/** Bytes of the given clips' files whose size is known. */
const knownBytes = (items) => items.reduce((n, it) => n + it.files.reduce((m, f) => m + (f.size ?? 0), 0), 0);

const isBool = (v) => typeof v === 'boolean';

class ImportJob {
  constructor({ dest, options, items, camera, info }) {
    this.id = shortId('job', dest, Date.now());
    this.state = 'running';           // running | done | failed | cancelled
    this.dest = dest;
    this.options = options;
    this.camera = camera;
    this.info = info;
    this.items = items.map((it) => ({ ...it, status: 'pending', bytes: 0, error: null, deleted: false, deleteError: null, files: filesFor(it, options).map((f) => ({ ...f, status: 'pending' })) }));
    this.totalBytes = knownBytes(this.items);
    this.doneBytes = 0;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.abort = new AbortController();
    this.samples = [];                // [ms, doneBytes] over the last RATE_WINDOW_MS, for the transfer rate
  }

  get running() { return this.state === 'running'; }

  cancel() { if (this.running) this.abort.abort(); }

  /** Bytes per second over the recent window, null when idle. */
  get rateBps() {
    const s = this.samples;
    if (!this.running || s.length < 2) return null;
    const [t0, b0] = s[0]; const [t1, b1] = s[s.length - 1];
    return t1 > t0 ? (b1 - b0) * 1000 / (t1 - t0) : null;
  }

  async run(ledger) {
    for (const item of this.items) {
      if (this.abort.signal.aborted) { item.status = 'cancelled'; continue; }
      await this.#importItem(item, ledger);
    }
    this.state = this.abort.signal.aborted ? 'cancelled' : (this.items.some((it) => it.status === 'failed') ? 'failed' : 'done');
    this.finishedAt = new Date().toISOString();
    const done = this.items.filter((it) => it.status === 'done').length;
    log.info(`import ${this.state}: ${done}/${this.items.length} clips, ${this.doneBytes} bytes → ${this.dest}`);
  }

  async #importItem(item, ledger) {
    const folder = path.join(this.dest, item.date);
    item.status = 'downloading';
    try {
      await mkdir(folder, { recursive: true });
      for (const file of item.files) await this.#fetchFile(item, file, folder);
      await ledger.record(item.key, this.#ledgerEntry(item, folder));
      item.status = 'done';
    } catch (e) {
      item.status = this.abort.signal.aborted ? 'cancelled' : 'failed';   // a stalled transfer is a failure, a Stop is not
      item.error = item.status === 'failed' ? e.message : null;
      if (item.status === 'failed') log.warn(`import of ${item.name} failed: ${e.message}`);
    }
  }

  /**
   * One card file into `folder`: verified as present, downloaded (resuming a `.part`), or absent
   * on the camera — which is fine for a sidecar and fails the clip when it is the clip itself.
   */
  async #fetchFile(item, file, folder) {
    const dest = path.join(folder, file.name);
    const onDisk = await sizeOf(dest);
    if (onDisk > 0 && (file.size == null || onDisk === file.size)) {
      file.status = 'present';
      await rm(`${dest}.part`, { force: true });   // a leftover from an earlier attempt has nothing to add
      this.#advance(item, file.size ?? 0);
      return;
    }
    file.status = 'downloading';
    let last = 0;
    const onProgress = (n) => { this.#advance(item, n - last); last = n; };
    const got = await this.camera.download(item.dir, file.name, dest, { expectedSize: file.size, onProgress, signal: this.abort.signal });
    if (got == null) {
      if (file.kind === 'main') throw new Error(`${file.name}: listed by the camera but not served (HTTP 404)`);
      file.status = 'absent'; this.totalBytes -= file.size ?? 0;   // listed or expected, yet not served
      return;
    }
    if (file.size == null) this.totalBytes += got;                  // a thumbnail: counted once its size is known
    file.status = 'done';
  }

  #advance(item, delta) {
    item.bytes += delta;
    this.doneBytes += delta;
    const now = Date.now();
    const s = this.samples;
    if (s.length && now - s[s.length - 1][0] < RATE_SAMPLE_MS) return;
    s.push([now, this.doneBytes]);
    while (s.length > 2 && now - s[0][0] > RATE_WINDOW_MS) s.shift();
  }

  #ledgerEntry(item, folder) {
    const { model, serial } = this.info;
    const files = item.files.filter((f) => f.status === 'done' || f.status === 'present').map((f) => f.name);
    return { camera: model, serial, dir: item.dir, name: item.name, size: item.size, cre: item.cre, importedAt: new Date().toISOString(), dest: folder, files };
  }

  /** Clips this job brought in completely — the only ones that may be deleted from the camera. */
  deletable() { return this.items.filter((it) => it.status === 'done' && !it.deleted); }

  /** Deletes the given clips (by key) from the camera: the clip itself, then its sidecars best-effort. */
  async deleteFromCamera(keys) {
    const wanted = new Set(keys);
    for (const item of this.deletable().filter((it) => wanted.has(it.key))) {
      try {
        await this.camera.deleteFile(item.dir, item.name);
        for (const name of [proxyName(item.name), thumbName(item.name)]) await this.camera.deleteFile(item.dir, name).catch(() => null);
        item.deleted = true;
        item.deleteError = null;
      } catch (e) {
        item.deleteError = e.message;
        log.warn(`delete of ${item.name} from the camera failed: ${e.message}`);
      }
    }
    log.info(`deleted from camera: ${this.items.filter((it) => it.deleted).length} clips`);
  }

  toJSON() {
    const { id, state, dest, options, startedAt, finishedAt, totalBytes, doneBytes, rateBps } = this;
    const items = this.items.map((it) => ({ ...it, total: knownBytes([it]), files: it.files.map(({ name, size, status }) => ({ name, size, status })) }));
    return { id, state, dest, options, camera: this.info.model, startedAt, finishedAt, totalBytes, doneBytes, rateBps, items };
  }
}

export class Importer {
  /**
   * @param {{ ledger: import('./import-ledger.js').ImportLedger, cameraUrl?: string|null, discover?: () => string|null, camera?: object }} opts
   *   cameraUrl pins the camera (tests, unusual setups); otherwise the USB network is probed on every snapshot.
   *   camera: options for the GoProCamera client (idleTimeoutMs).
   */
  constructor({ ledger, cameraUrl = null, discover = discoverCameraUrl, camera = {} }) {
    this.ledger = ledger;
    this.cameraUrl = cameraUrl || null;
    this.discover = discover;
    this.cameraOptions = camera;
    this.job = null;
    this.starting = false;    // a start() is between its checks and its job: a second one is refused meanwhile
    this.onFinished = null;   // async (job) => void, set by the app (rescan, add the destination as a media root)
  }

  /** Camera + card contents annotated with the ledger; `camera` is null (with a `reason`) when nothing answers. */
  async snapshot() {
    await this.ledger.load();
    const job = this.job?.toJSON() ?? null;
    try {
      const { camera, info, items } = await this.#source();
      return { camera: { ...info, url: camera.baseUrl }, items: oldestFirst(items).map((it) => this.#describe(info.serial, it)), job };
    } catch (e) {
      return { camera: null, reason: e.message, items: [], job };
    }
  }

  /** Starts a job for the given keys (from a snapshot); throws 400/409/503 errors the HTTP layer forwards. */
  async start({ dest, keys, lrv, thm }) {
    if (this.job?.running || this.starting) throw httpError(409, 'an import is already running');
    if (!isBool(lrv) || !isBool(thm)) throw httpError(400, 'lrv and thm must be true or false');
    if (typeof dest !== 'string' || !path.isAbsolute(dest)) throw httpError(400, 'destination must be an absolute path');
    if (!Array.isArray(keys) || !keys.length) throw httpError(400, 'nothing to import');
    this.starting = true;
    try {
      const job = await this.#prepare({ dest: path.resolve(dest), keys, options: { lrv, thm } });
      this.job = job;
      log.info(`import started: ${job.items.length} clips, ${job.totalBytes} bytes, lrv=${lrv} thm=${thm} → ${job.dest}`);
      job.run(this.ledger).then(() => this.onFinished?.(job)).catch((e) => log.error('import job crashed', e));
      return job.toJSON();
    } finally {
      this.starting = false;
    }
  }

  /** The job for a validated request: the card is listed, the keys resolved, the destination created. */
  async #prepare({ dest, keys, options }) {
    await this.ledger.load();
    const source = await this.#source().catch((e) => { throw httpError(503, `camera not reachable: ${e.message}`); });
    const wanted = new Set(keys);
    const items = oldestFirst(source.items).map((it) => this.#describe(source.info.serial, it)).filter((it) => wanted.has(it.key));
    if (!items.length) throw httpError(400, 'none of the requested files is on the camera');
    await mkdir(dest, { recursive: true });
    return new ImportJob({ dest, options, items, camera: source.camera, info: source.info });
  }

  cancel() {
    if (!this.job?.running) return false;
    this.job.cancel();
    return true;
  }

  /**
   * Deletes clips of the last job from the camera; only clips that job imported completely are
   * accepted, and only while the camera the job read them from is the one connected.
   */
  async deleteImported(keys) {
    if (!this.job || this.job.running) throw httpError(409, 'no finished import to delete from');
    if (!Array.isArray(keys) || !keys.length) throw httpError(400, 'nothing to delete');
    const allowed = new Set(this.job.deletable().map((it) => it.key));
    if (!keys.every((k) => allowed.has(k))) throw httpError(400, 'only clips the last import brought in completely can be deleted from the camera');
    const { serial } = await this.job.camera.connect().catch((e) => { throw httpError(503, `camera not reachable: ${e.message}`); });
    if (serial !== this.job.info.serial) throw httpError(409, `a different camera is connected (serial ${serial})`);
    await this.job.deleteFromCamera(keys);
    return this.job.toJSON();
  }

  async #source() {
    const url = this.cameraUrl ?? this.discover();
    if (!url) throw new Error('no GoPro on USB — connect the camera in GoPro Connect mode');
    const camera = new GoProCamera(url, this.cameraOptions);
    const info = await camera.connect();
    return { camera, info, items: await camera.mediaList() };
  }

  #describe(serial, item) {
    const key = importKey(serial, item);
    const known = this.ledger.get(key);
    const imported = known ? { at: known.importedAt, dest: known.dest, files: known.files } : null;
    return { key, ...item, date: dateFolder(item.cre), imported };
  }
}
