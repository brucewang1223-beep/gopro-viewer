/**
 * Media library: scans media roots, groups GoPro chapter files into recordings,
 * and keeps an id → file registry so the HTTP layer never handles raw paths.
 *
 * GoPro naming conventions handled
 *   GXccnnnn.MP4 / GHccnnnn.MP4   HERO6+  (GX = HEVC, GH = AVC), cc = chapter, nnnn = recording number
 *   GLccnnnn.LRV                  low-resolution proxy of the chapter above
 *   G?ccnnnn.THM                  JPEG thumbnail of the chapter
 *   GOPRnnnn.MP4 + GPccnnnn.MP4   HERO5 and older (first chapter + continuation chapters)
 *   GSccnnnn.360                  MAX 360 files are recognised but skipped (not playable in a browser)
 *   anything else *.mp4 / *.mov   single-chapter recording named after the file
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readMp4Info, probeGpmfStreams } from './mp4.js';
import { probeGpsFix } from './gpmf-probe.js';
import { headerSettingsSummary } from './gpmf-klv.js';
import { clockConvention, startTimes } from './camera-clock.js';
import { readJsonCache, writeJsonCache } from './json-cache.js';
import { isDirectory } from './fs-util.js';
import { shortId } from './ids.js';
import { createLogger } from './log.js';

const log = createLogger('library');
const INFO_VERSION = 6; // bump when the cached per-file info shape changes

const VIDEO_EXT = new Set(['.mp4', '.mov']);
const PROXY_EXT = new Set(['.lrv']);
const THUMB_EXT = new Set(['.thm', '.jpg', '.jpeg']);
const MEDIA_EXT = new Set([...VIDEO_EXT, ...PROXY_EXT, ...THUMB_EXT, '.360']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.Trashes', '.Spotlight-V100', '.fseventsd']);
const MAX_DEPTH = 8;

const CHAPTERED_RE = /^(GX|GH|GL|GS|GP)(\d{2})(\d{4})$/i;
const LEGACY_RE = /^GOPR(\d{4})$/i;

/* ---------- file names ---------- */

function kindOf(ext) {
  if (THUMB_EXT.has(ext)) return 'thumb';
  if (PROXY_EXT.has(ext)) return 'proxy';
  return VIDEO_EXT.has(ext) ? 'video' : 'other';
}

/** HERO6+ style names: prefix letters encode encoding (GX = HEVC) and role (GL proxy, GS 360, GP legacy chapter). */
function parseChapteredName(prefix, chapter, number, ext) {
  const family = prefix === 'GP' ? 'GOPR' : 'GX';
  if (prefix === 'GS' || ext === '.360') return { family: 'GS', chapter, number, kind: '360', encoding: 'hevc' };
  if (prefix === 'GL' || PROXY_EXT.has(ext)) return { family, chapter, number, kind: 'proxy', encoding: 'h264' };
  if (THUMB_EXT.has(ext)) return { family, chapter, number, kind: 'thumb', encoding: null };
  return { family, chapter, number, kind: kindOf(ext), encoding: prefix === 'GX' ? 'hevc' : 'h264' };
}

/**
 * Parse a GoPro file name.
 * @returns {{ family: string, chapter: string, number: string, kind: 'video'|'proxy'|'thumb'|'360'|'other', encoding: string|null } | null}
 */
export function parseGoProName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName, path.extname(fileName));
  const chaptered = CHAPTERED_RE.exec(base);
  if (chaptered) return parseChapteredName(chaptered[1].toUpperCase(), chaptered[2], chaptered[3], ext);
  const legacy = LEGACY_RE.exec(base);
  if (!legacy) return null;
  const kind = kindOf(ext);
  return { family: 'GOPR', chapter: '00', number: legacy[1], kind, encoding: kind === 'thumb' ? null : 'h264' };
}

/* ---------- directory scan ---------- */

/** Directory / file nature of an entry, following symlinks (a linked footage folder is a common setup). */
async function entryKind(ent, full) {
  if (ent.isSymbolicLink()) {
    try { const st = await stat(full); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'; } catch { return 'other'; }
  }
  return ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other';
}

async function walk(dir, out, depth = 0) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    log.warn(`cannot read directory ${dir}: ${e.message}`);
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const kind = await entryKind(ent, full);
    if (kind === 'dir') { if (depth < MAX_DEPTH) await walk(full, out, depth + 1); }
    else if (kind === 'file' && MEDIA_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
}

async function fileRecord(filePath, rootId) {
  const st = await stat(filePath);
  const name = path.basename(filePath);
  return {
    id: shortId('file', filePath), path: filePath, name, ext: path.extname(name).toLowerCase(),
    sizeBytes: st.size, mtimeMs: st.mtimeMs, rootId, parsed: parseGoProName(name),
  };
}

/** Recording key: GoPro-named files group by directory + family + number, loose videos stand alone. */
function groupKey(file) {
  const dir = path.dirname(file.path);
  if (file.parsed) return `${dir}|${file.parsed.family}|${file.parsed.number}`;
  return VIDEO_EXT.has(file.ext) ? `${dir}|file|${file.name}` : null;
}

function addToGroup(group, file) {
  const kind = file.parsed?.kind ?? 'video';
  if (kind === 'video') group.videos.push(file);
  else if (kind === 'proxy') group.proxies.push(file);
  else if (kind === 'thumb') group.thumbs.push(file);
}

/** Register every file in `paths` and group them into candidate recordings; a file that vanished since the listing is skipped. */
async function groupFiles(paths, rootId, files) {
  const groups = new Map();
  for (const p of paths) {
    let file;
    try { file = await fileRecord(p, rootId); } catch (e) { log.warn(`skipping ${p}: ${e.message}`); continue; }
    files.set(file.id, file);
    const key = groupKey(file);
    if (!key) continue; // stray thumbnails / proxies that are not GoPro-named
    if (!groups.has(key)) groups.set(key, { dir: path.dirname(p), parsed: file.parsed, videos: [], proxies: [], thumbs: [] });
    addToGroup(groups.get(key), file);
  }
  return groups;
}

/* ---------- per-file info (cached) ---------- */

/** Which streams the GPMF track carries and whether GPS ever had a fix — probes only, no full decode. */
async function probeTelemetry(filePath, info) {
  const result = { gps: false, imu: false, keys: [], hasFix: false, fixRatio: 0, utcAtStartMs: null };
  if (!info.gpmd?.samples?.length) return result;
  try {
    Object.assign(result, await probeGpmfStreams(filePath, info));
  } catch (e) {
    log.warn(`stream probe failed for ${filePath}: ${e.message}`);
  }
  if (!result.gps) return result;
  try {
    const fix = await probeGpsFix(filePath, info);
    Object.assign(result, { hasFix: fix.hasFix, fixRatio: fix.fixRatio, utcAtStartMs: fix.utcAtStartMs });
  } catch (e) {
    log.warn(`fix probe failed for ${filePath}: ${e.message}`);
  }
  return result;
}

function slimInfo(info, mtimeMs, probe) {
  const video = info.video ? { ...info.video } : null;
  if (video?.fps) video.fps = Math.round(video.fps * 1000) / 1000;
  const creationTime = info.creationTime ? info.creationTime.toISOString() : null;
  const settings = headerSettingsSummary(info.udta?.gpmfHeader);
  return {
    v: INFO_VERSION,
    fileSize: info.fileSize,
    mtimeMs,
    creationTime,
    clock: clockConvention({ creationTime, settings, gpsStartUtcMs: probe.utcAtStartMs }),  // 'utc' | 'local' | null: what the creation time means
    gpsStartUtc: probe.utcAtStartMs != null ? new Date(probe.utcAtStartMs).toISOString() : null,
    durationSec: info.durationSec,
    video,
    audio: info.audio,
    hasGpmd: !!info.gpmd,
    hasGps: probe.gps,
    hasGpsFix: probe.hasFix,
    gpsFixRatio: Math.round(probe.fixRatio * 100) / 100,
    hasImu: probe.imu,
    gpmdKeys: probe.keys,
    gpmdSamples: info.gpmd?.nbSamples ?? 0,
    firmware: info.udta?.firmware ?? null,
    settings,
  };
}

/* ---------- recordings ---------- */

/** Chapter order; for the same chapter the camera's own .MP4 ranks before a .mov re-encode, then the name decides. */
const extRank = (file) => (file.ext === '.mp4' ? 0 : 1);
const byChapter = (a, b) => (a.parsed?.chapter ?? '').localeCompare(b.parsed?.chapter ?? '') || extRank(a) - extRank(b) || a.name.localeCompare(b.name);

function chapterRecord(file, info, group, previous) {
  const chapter = file.parsed?.chapter ?? '00';
  const last = previous[previous.length - 1];
  return {
    id: file.id,
    file: file.name,
    path: file.path,
    chapter,
    index: previous.length,
    offsetSec: last ? last.offsetSec + last.durationSec : 0,
    durationSec: info.durationSec,
    sizeBytes: file.sizeBytes,
    creationTime: info.creationTime,
    clock: info.clock ?? null,
    gpsStartUtc: info.gpsStartUtc ?? null,
    video: info.video,
    hasGpmd: info.hasGpmd,
    hasGps: !!info.hasGps,
    hasGpsFix: !!info.hasGpsFix,
    hasImu: !!info.hasImu,
    proxyId: group.proxies.find((p) => p.parsed?.chapter === chapter)?.id ?? null,
    thumbId: group.thumbs.find((t) => t.parsed?.chapter === chapter)?.id ?? null,
    firmware: info.firmware,
    settings: info.settings ?? null,
  };
}

/** On-card prefix of the first chapter (GX/GH/GOPR) + recording number; loose videos keep their file name. */
function displayName(group, first) {
  if (!group.parsed) return path.basename(first.file, path.extname(first.file));
  if (group.parsed.family === 'GOPR') return `GOPR${group.parsed.number}`;
  return `${first.file.slice(0, 2).toUpperCase()}${group.parsed.number}`;
}

/** What the recording carries, from its chapters: any chapter with telemetry / GPS / a fix / IMU, every chapter with a proxy. */
function capabilities(chapters) {
  return {
    hasGpmd: chapters.some((c) => c.hasGpmd),
    hasGps: chapters.some((c) => c.hasGps),
    hasGpsFix: chapters.some((c) => c.hasGpsFix),
    hasImu: chapters.some((c) => c.hasImu),
    hasProxy: chapters.every((c) => c.proxyId),
  };
}

/** Start of the recording: the camera's local wall clock (as the sidebar shows it) and true UTC when known. */
function recordingStart(first, fallbackStart) {
  const gpsStartUtcMs = first.gpsStartUtc ? Date.parse(first.gpsStartUtc) : null;
  const { local, utc } = startTimes({ creationTime: first.creationTime, settings: first.settings, gpsStartUtcMs });
  return { startTime: local ?? fallbackStart, startTimeUtc: utc };
}

function recordingRecord({ key, group, rootId, chapters, warnings, fallbackStart }) {
  const first = chapters[0];
  return {
    id: shortId('rec', key),
    name: displayName(group, first),
    dir: group.dir,
    rootId,
    ...recordingStart(first, fallbackStart),
    durationSec: chapters.reduce((a, c) => a + c.durationSec, 0),
    chapters,
    codec: first.video?.codec ?? null,
    width: first.video?.width ?? null,
    height: first.video?.height ?? null,
    fps: first.video?.fps ?? null,
    ...capabilities(chapters),
    thumbId: first.thumbId,
    firmware: first.firmware,
    settings: first.settings ?? null,
    sizeBytes: chapters.reduce((a, c) => a + c.sizeBytes, 0),
    warnings,
  };
}

/** Video files of a group in chapter order; a second file for the same chapter (GX010001.MP4 next to GX010001.mov) is reported and skipped. */
function chapterFiles(group, warnings) {
  const sorted = [...group.videos].sort(byChapter);
  const kept = [];
  for (const file of sorted) {
    const last = kept[kept.length - 1];
    if (last && file.parsed && last.parsed?.chapter === file.parsed.chapter) { warnings.push(`${file.name}: same chapter as ${last.name}, skipped`); continue; }
    kept.push(file);
  }
  return kept;
}

export class Library {
  /**
   * @param {{ roots: string[], cacheDir: string }} opts
   */
  constructor({ roots, cacheDir }) {
    this.roots = roots;
    this.cacheDir = cacheDir;
    this.files = new Map();       // fileId → file record
    this.recordings = new Map();  // recordingId → recording
    this.missing = new Set();     // root ids that were not on disk at the last scan
    this.scannedAt = null;
    this.scanning = null;         // the scan in progress
    this.queued = null;           // the follow-up scan promised to callers that arrived during it
  }

  rootRecords() {
    return this.roots.map((p) => {
      const id = shortId('root', p);
      return { id, path: p, exists: !this.missing.has(id) };
    });
  }

  getFile(id) { return this.files.get(id) ?? null; }
  getRecording(id) { return this.recordings.get(id) ?? null; }

  toJSON() {
    const recordings = [...this.recordings.values()]
      .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || '') || a.name.localeCompare(b.name))
      .map((r) => ({ ...r, chapters: r.chapters.map(({ path: _p, ...c }) => c) }));
    return { scannedAt: this.scannedAt, roots: this.rootRecords(), recordings };
  }

  /**
   * Scan all roots. A call while a scan runs waits for it and then scans once more (shared
   * by every such caller), so a root added meanwhile is part of the answer.
   */
  async scan() {
    if (this.scanning) {
      this.queued ??= this.scanning.catch(() => null).then(() => { this.queued = null; return this.scan(); });
      return this.queued;
    }
    this.scanning = this.#scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async #scan() {
    const t0 = Date.now();
    const files = new Map();
    const recordings = new Map();
    const missing = new Set();
    for (const root of this.rootRecords()) await this.#scanRoot(root, files, recordings, missing);
    this.files = files;
    this.recordings = recordings;
    this.missing = missing;
    this.scannedAt = new Date().toISOString();
    log.info(`scan complete: ${recordings.size} recordings, ${files.size} files in ${Date.now() - t0} ms`);
    return this.toJSON();
  }

  async #scanRoot(root, files, recordings, missing) {
    if (!(await isDirectory(root.path))) { log.warn(`media root not found: ${root.path}`); missing.add(root.id); return; }
    const paths = [];
    await walk(root.path, paths);
    log.info(`scanning ${root.path}: ${paths.length} candidate files`);
    for (const [key, group] of await groupFiles(paths, root.id, files)) {
      const recording = await this.#buildRecording(key, group, root.id);
      if (recording) recordings.set(recording.id, recording);
    }
  }

  async #buildRecording(key, group, rootId) {
    if (!group.videos.length) return null;
    const chapters = []; const warnings = [];
    for (const file of chapterFiles(group, warnings)) {
      try {
        chapters.push(chapterRecord(file, await this.#fileInfo(file), group, chapters));
      } catch (e) {
        warnings.push(`${file.name}: ${e.message}`);
        log.warn(`skipping ${file.path}: ${e.message}`);
      }
    }
    if (!chapters.length) return null;
    const firstFile = group.videos.find((v) => v.id === chapters[0].id);
    return recordingRecord({ key, group, rootId, chapters, warnings, fallbackStart: new Date(firstFile.mtimeMs).toISOString() });
  }

  /** Slim MP4 info of one file, cached on disk and keyed by size + mtime. */
  async #fileInfo(file) {
    const cacheFile = path.join(this.cacheDir, 'info', `${file.id}.json`);
    const cached = await readJsonCache(cacheFile, (c) => c.v === INFO_VERSION && c.fileSize === file.sizeBytes && Math.abs(c.mtimeMs - file.mtimeMs) < 1);
    if (cached) return cached;
    const info = await readMp4Info(file.path);
    const slim = slimInfo(info, file.mtimeMs, await probeTelemetry(file.path, info));
    await writeJsonCache(cacheFile, slim, log);
    return slim;
  }
}
