/**
 * Open GoPro HTTP client for a camera connected by USB in GoPro Connect (NCM) mode.
 *
 * The camera brings up a small USB network: the Mac gets 172.2X.1YZ.52 and the camera answers
 * on 172.2X.1YZ.51 (XYZ = last three digits of its serial number), port 8080. Endpoints used:
 *   GET /gopro/camera/control/wired_usb?p=1   enable wired control (HERO9+ need it before serving media)
 *   GET /gopro/camera/info                    model, serial number, firmware
 *   GET /gopro/media/list                     { media: [{ d, fs: [{ n, s, cre, mod, glrv | ls }] }] }
 *   GET /videos/DCIM/<dir>/<file>             raw card file, HTTP Range honoured (resume)
 *   GET /gopro/media/delete/file?path=<dir>/<file>   delete one card file
 * The LRV proxy and THM thumbnail of a clip are not in the media list but are served from the
 * same DCIM folder under their card names (GL010004.LRV, GX010004.THM); the list reports the LRV
 * size as `glrv`, the THM size is unknown until fetched.
 */

import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sizeOf } from './fs-util.js';

const USB_HOST_RE = /^172\.2\d\.1\d\d\.52$/;
const PORT = 8080;
const CONTROL_TIMEOUT_MS = 4000;
const LIST_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 30000;   // a transfer that carries no byte for this long has lost the camera (asleep, unplugged)

/** Base URL of the camera on the USB network, or null when no GoPro interface is up. */
export function discoverCameraUrl(interfaces = os.networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    const hit = addrs.find((a) => a.family === 'IPv4' && USB_HOST_RE.test(a.address));
    if (hit) return `http://${hit.address.replace(/\.52$/, '.51')}:${PORT}`;
  }
  return null;
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`${url} → HTTP ${res.status}`); }
  return res.json();
}

/** Card-file record from one media-list entry. Newer cameras report the LRV size as `glrv`, older ones as `ls` (−1 = none). */
function cardFile(dir, f) {
  const lrv = Math.max(0, Number(f.glrv ?? 0), Number(f.ls ?? 0));
  const cre = Number(f.cre);
  return { dir, name: String(f.n), size: Number(f.s), cre: Number.isFinite(cre) ? cre : 0, lrvSize: Number.isFinite(lrv) ? lrv : 0 };
}

/** Counts the bytes flowing through so a download can report progress. */
function byteCounter(onBytes) {
  let n = 0;
  return new Transform({ transform(chunk, _enc, cb) { n += chunk.length; onBytes(n); cb(null, chunk); } });
}

/**
 * A signal that fires when the caller's `outer` signal does, or when `touch()` has not been
 * called for `idleMs` — a stalled transfer then ends instead of hanging on a silent socket.
 */
function idleGuard(outer, idleMs) {
  const ctl = new AbortController();
  const guard = { signal: ctl.signal, timedOut: false, touch: null, stop: null };
  let timer = null;
  const cancelled = () => { clearTimeout(timer); ctl.abort(outer.reason); };
  guard.touch = () => { clearTimeout(timer); timer = setTimeout(() => { guard.timedOut = true; ctl.abort(); }, idleMs); };
  guard.stop = () => { clearTimeout(timer); outer?.removeEventListener('abort', cancelled); };
  if (outer?.aborted) cancelled(); else outer?.addEventListener('abort', cancelled);
  guard.touch();
  return guard;
}

export class GoProCamera {
  /** @param {{ idleTimeoutMs?: number }} [opts] how long a transfer may carry nothing before it is given up */
  constructor(baseUrl, { idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  /** Model / serial / firmware. Also switches on wired control, which HERO9+ need before they serve media. */
  async connect() {
    await fetch(`${this.baseUrl}/gopro/camera/control/wired_usb?p=1`, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) })
      .then((res) => res.body?.cancel(), () => null);   // best effort; drain so the socket is free again
    const info = await getJson(`${this.baseUrl}/gopro/camera/info`, CONTROL_TIMEOUT_MS);
    return { model: info.model_name ?? 'GoPro', serial: String(info.serial_number ?? ''), firmware: info.firmware_version ?? null };
  }

  /** Every file on the card, flattened: { dir, name, size, cre (camera clock, epoch s), lrvSize }. */
  async mediaList() {
    const list = await getJson(`${this.baseUrl}/gopro/media/list`, LIST_TIMEOUT_MS);
    return (list.media ?? []).flatMap((group) => (group.fs ?? []).filter((f) => f?.n).map((f) => cardFile(group.d, f)));
  }

  fileUrl(dir, name) { return `${this.baseUrl}/videos/DCIM/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`; }

  /**
   * Download one card file to `dest`, continuing a partial `<dest>.part` where the camera honours
   * Range, and verifying the byte count against `expectedSize` when it is known.
   * @returns {Promise<number|null>} bytes on disk, or null when the camera has no such file
   */
  async download(dir, name, dest, { expectedSize = null, onProgress = () => {}, signal }) {
    const part = `${dest}.part`;
    let offset = await sizeOf(part);
    if (expectedSize != null && offset >= expectedSize) offset = 0;      // stale or oversized leftover: start over
    const guard = idleGuard(signal, this.idleTimeoutMs);
    try {
      if (!(await this.#fetchInto(this.fileUrl(dir, name), part, offset, { onProgress, guard }))) return null;
    } catch (e) {
      if (guard.timedOut) throw new Error(`${name}: no data from the camera for ${this.idleTimeoutMs / 1000} s`, { cause: e });
      throw e;
    } finally {
      guard.stop();
    }
    const size = await sizeOf(part);
    if (expectedSize != null && size !== expectedSize) throw new Error(`${name}: got ${size} bytes, expected ${expectedSize}`);
    await rename(part, dest);
    return size;
  }

  /** Deletes one card file; the camera answers 200 for a file it removed and an error otherwise. */
  async deleteFile(dir, name) {
    const res = await fetch(`${this.baseUrl}/gopro/media/delete/file?path=${encodeURIComponent(`${dir}/${name}`)}`, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`${name}: camera refused the delete (HTTP ${res.status})`);
  }

  /** Streams the card file into `part` from `offset`; false when the camera answers 404. */
  async #fetchInto(url, part, offset, { onProgress, guard }) {
    const opened = await this.#open(url, offset, guard.signal);
    if (!opened) return false;
    if (opened.restart) return this.#fetchInto(url, part, 0, { onProgress, guard });   // leftover longer than the file
    const { res, base } = opened;
    const sink = createWriteStream(part, { flags: base > 0 ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(res.body), byteCounter((n) => { guard.touch(); onProgress(base + n); }), sink, { signal: guard.signal });
    return true;
  }

  /**
   * Opens the card file from `offset`: null for a 404, `restart` for a 416 on a resume (the
   * leftover was longer than the file), else the response and the byte it continues from —
   * 0 when the camera answered 200 and ignored the Range.
   */
  async #open(url, offset, signal) {
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const res = await fetch(url, { headers, signal });
    if (res.ok) return { res, base: res.status === 206 && offset > 0 ? offset : 0 };
    await res.body?.cancel();
    if (res.status === 404) return null;
    if (res.status === 416 && offset > 0) return { restart: true };
    throw new Error(`${url} → HTTP ${res.status}`);
  }
}
