/**
 * Minimal ISO-BMFF (MP4) reader specialised for GoPro files.
 *
 * Design goals
 *  - Never load the media payload: only the `moov` box (a few MB at most) is
 *    read into memory, so multi-GB chapters cost a handful of reads.
 *  - Expose exactly what the viewer needs: movie timing, video codec & geometry,
 *    the GPMF (`gpmd`) sample table with byte ranges, and the GoPro `udta`
 *    extras (firmware, lens, camera-settings KLV).
 *  - Be tolerant: unknown boxes are skipped, malformed tables throw a
 *    descriptive `Mp4Error` instead of producing garbage.
 *
 * Inputs : absolute path of an .MP4 / .LRV / .MOV file.
 * Output : see `readMp4Info()`.
 */

import { open, stat } from 'node:fs/promises';

const MAX_MOOV_BYTES = 256 * 1024 * 1024; // safety cap (GoPro moov is typically < 10 MB)
const MAC_EPOCH_OFFSET_MS = 2082844800000; // 1904-01-01 → 1970-01-01 in ms
const CODEC_BY_FORMAT = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', mp4a: 'aac' };
const TRAK_CONTAINERS = new Set(['mdia', 'minf', 'stbl']);

export class Mp4Error extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'Mp4Error';
    Object.assign(this, details);
  }
}

/* ---------- primitives ---------- */

/** Convert a "seconds since 1904" value into a Date (or null when 0). */
function macTimeToDate(seconds) {
  if (!seconds) return null;
  const d = new Date(seconds * 1000 - MAC_EPOCH_OFFSET_MS);
  return Number.isFinite(d.getTime()) ? d : null;
}

const fourcc = (buf, off) => buf.toString('latin1', off, off + 4);
const cString = (buf, start, end) => buf.toString('latin1', start, end).replace(/\0+$/g, '').trim();

/** Sequential big-endian reader; `uv()` reads the 32/64-bit field of a versioned full box. */
class Reader {
  constructor(buf, pos) { this.buf = buf; this.pos = pos; }
  u8() { return this.buf.readUInt8(this.pos++); }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u64() { const v = Number(this.buf.readBigUInt64BE(this.pos)); this.pos += 8; return v; }
  uv(version) { return version === 1 ? this.u64() : this.u32(); }
  skip(n) { this.pos += n; return this; }
}

/* ---------- box traversal ---------- */

/**
 * Box header at `off` (size 0 = "to the end of the container", resolved by the caller).
 * Returns null when fewer bytes than a header remain before `end`.
 */
function boxHeader(buf, off, end) {
  if (off + 8 > end) return null;
  let size = buf.readUInt32BE(off);
  const type = fourcc(buf, off + 4);
  let headerSize = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(off + 8));
    headerSize = 16;
  }
  if (type === 'uuid') headerSize += 16;
  return { type, size, headerSize };
}

/** Iterate the boxes in `buf[start, end)`; yields { type, start, end, headerSize }. */
function* iterateBoxes(buf, start, end) {
  for (let off = start; ;) {
    const h = boxHeader(buf, off, end);
    if (!h) return;
    const size = h.size === 0 ? end - off : h.size;
    if (size < h.headerSize) throw new Mp4Error(`Corrupt box '${h.type}' (size ${size}) at offset ${off}`);
    yield { type: h.type, start: off, end: Math.min(off + size, end), headerSize: h.headerSize };
    off += size;
  }
}

/** Top-level box index of a file, read with one small read per box. */
async function readTopLevelIndex(fh, fileSize) {
  const boxes = [];
  const hdr = Buffer.alloc(16);
  for (let off = 0; off + 8 <= fileSize;) {
    const { bytesRead } = await fh.read(hdr, 0, 16, off);
    const h = boxHeader(hdr, 0, bytesRead);
    if (!h) break;
    const size = h.size === 0 ? fileSize - off : h.size;
    if (size < h.headerSize) throw new Mp4Error(`Corrupt top-level box '${h.type}' at offset ${off}`);
    boxes.push({ type: h.type, start: off, size, headerSize: h.headerSize });
    off += size;
  }
  return boxes;
}

/* ---------- box parsers ---------- */

function fullBox(buf, box) {
  const r = new Reader(buf, box.start + box.headerSize);
  const version = r.u8();
  r.skip(3); // flags
  return { version, r };
}

/** mvhd and mdhd share their leading fields: creation, modification, timescale, duration. */
function parseTimeHeader(buf, box) {
  const { version, r } = fullBox(buf, box);
  const creation = r.uv(version);
  r.uv(version); // modification
  const timescale = r.u32();
  const duration = r.uv(version);
  return { creationTime: macTimeToDate(creation), timescale, duration };
}

function parseTkhd(buf, box) {
  const { version, r } = fullBox(buf, box);
  const creation = r.uv(version);
  r.uv(version); // modification
  const trackId = r.u32();
  r.skip(4); // reserved
  const duration = r.uv(version);
  r.skip(8 + 2 + 2 + 2 + 2 + 36); // reserved, layer, alternate_group, volume, reserved, matrix
  const width = r.u32() / 65536;
  const height = r.u32() / 65536;
  return { creationTime: macTimeToDate(creation), trackId, duration, width, height };
}

/** Handler type ('vide', 'soun', 'meta'…). */
function parseHdlr(buf, box) {
  const { r } = fullBox(buf, box);
  return fourcc(buf, r.skip(4).pos); // pre_defined, then handler_type
}

/** One sample description: format fourcc plus width/height for visual entries. */
function sampleEntry(buf, p, size) {
  const entry = { format: fourcc(buf, p + 4) };
  // VisualSampleEntry: 8 hdr + 6 reserved + 2 dref + 2 pre_defined + 2 reserved + 12 pre_defined → width/height
  if (size >= 36) { entry.width = buf.readUInt16BE(p + 32); entry.height = buf.readUInt16BE(p + 34); }
  return entry;
}

function parseStsd(buf, box) {
  const { r } = fullBox(buf, box);
  const entryCount = r.u32();
  const entries = [];
  let p = r.pos;
  for (let i = 0; i < entryCount && p + 8 <= box.end; i++) {
    const size = buf.readUInt32BE(p);
    entries.push(sampleEntry(buf, p, size));
    if (size < 8) break;
    p += size;
  }
  return entries;
}

/** Full box holding an entry count followed by fixed-size rows read by `readRow`. */
function parseTable(buf, box, readRow) {
  const { version, r } = fullBox(buf, box);
  const n = r.u32();
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = readRow(r, version);
  return rows;
}

function parseStsz(buf, box) {
  const { r } = fullBox(buf, box);
  const sampleSize = r.u32();
  const count = r.u32();
  if (sampleSize !== 0) return { sampleSize, count, sizes: null };
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = r.u32();
  return { sampleSize, count, sizes };
}

const STBL_PARSERS = {
  stsd: parseStsd,
  stsz: parseStsz,
  stts: (buf, box) => parseTable(buf, box, (r) => ({ count: r.u32(), delta: r.u32() })),
  ctts: (buf, box) => parseTable(buf, box, (r, version) => ({ count: r.u32(), offset: version === 1 ? r.i32() : r.u32() })),
  stsc: (buf, box) => parseTable(buf, box, (r) => { const row = { firstChunk: r.u32(), samplesPerChunk: r.u32() }; r.skip(4); return row; }),
  stco: (buf, box) => parseTable(buf, box, (r) => r.u32()),
  co64: (buf, box) => parseTable(buf, box, (r) => r.u64()),
};

function parseTrak(buf, box) {
  const trak = { tkhd: null, mdhd: null, handler: null, stbl: {} };
  const visit = (start, end, parent) => {
    for (const b of iterateBoxes(buf, start, end)) {
      if (b.type === 'tkhd') trak.tkhd = parseTkhd(buf, b);
      else if (b.type === 'mdhd') trak.mdhd = parseTimeHeader(buf, b);
      else if (b.type === 'hdlr' && parent === 'mdia') trak.handler = parseHdlr(buf, b);
      else if (b.type in STBL_PARSERS) trak.stbl[b.type === 'co64' ? 'stco' : b.type] = STBL_PARSERS[b.type](buf, b);
      else if (TRAK_CONTAINERS.has(b.type)) visit(b.start + b.headerSize, b.end, b.type);
    }
  };
  visit(box.start + box.headerSize, box.end, 'trak');
  return trak;
}

/** GoPro user-data boxes: firmware, lens serial, camera-settings GPMF. */
function parseUdta(buf, box) {
  const out = { firmware: null, lens: null, gpmfHeader: null };
  for (const b of iterateBoxes(buf, box.start + box.headerSize, box.end)) {
    const payload = b.start + b.headerSize;
    if (b.type === 'FIRM') out.firmware = cString(buf, payload, b.end);
    else if (b.type === 'LENS') out.lens = cString(buf, payload, b.end);
    else if (b.type === 'GPMF') out.gpmfHeader = Buffer.from(buf.subarray(payload, b.end));
  }
  return out;
}

function parseMoov(buf, moov, filePath) {
  let mvhd = null; let udta = null; const traks = [];
  for (const b of iterateBoxes(buf, moov.headerSize, moov.size)) {
    if (b.type === 'mvhd') mvhd = parseTimeHeader(buf, b);
    else if (b.type === 'trak') traks.push(parseTrak(buf, b));
    else if (b.type === 'udta') udta = parseUdta(buf, b);
  }
  if (!mvhd) throw new Mp4Error('moov has no mvhd', { filePath });
  return { mvhd, traks, udta };
}

/* ---------- sample table ---------- */

/** Samples per chunk for a 1-based chunk number (stsc rows are sorted by firstChunk). */
function samplesInChunk(stsc, chunkNumber) {
  let perChunk = stsc[0]?.samplesPerChunk ?? 0;
  for (const row of stsc) {
    if (row.firstChunk > chunkNumber) break;
    perChunk = row.samplesPerChunk;
  }
  return perChunk;
}

/** Byte offset and size of every sample, from the chunk map. */
function layoutSamples(stsz, stsc, stco) {
  const count = stsz.count;
  const samples = new Array(count);
  let n = 0;
  for (let ci = 0; ci < stco.length && n < count; ci++) {
    let off = stco[ci];
    for (let left = samplesInChunk(stsc, ci + 1); left > 0 && n < count; left--, n++) {
      const size = stsz.sizes ? stsz.sizes[n] : stsz.sampleSize;
      samples[n] = { offset: off, size, dts: 0, cts: 0, duration: 0 };
      off += size;
    }
  }
  if (n !== count) throw new Mp4Error(`Chunk map covers ${n} samples but stsz declares ${count}`);
  return samples;
}

function applyDecodeTimes(samples, stts) {
  let t = 0; let i = 0;
  for (const { count, delta } of stts) {
    for (let k = 0; k < count && i < samples.length; k++, i++) {
      samples[i].dts = t; samples[i].duration = delta; t += delta;
    }
  }
}

function applyCompositionOffsets(samples, ctts) {
  let i = 0;
  for (const { count, offset } of ctts ?? []) {
    for (let k = 0; k < count && i < samples.length; k++, i++) samples[i].cts = samples[i].dts + offset;
  }
  for (; i < samples.length; i++) samples[i].cts = samples[i].dts;
}

/** Per-sample table (offset/size/dts/cts/duration) of a track, in track timescale units. */
function buildSampleTable(stbl) {
  const { stts, stsz, stsc, stco, ctts } = stbl;
  if (!stts || !stsz || !stsc || !stco) throw new Mp4Error('Track is missing one of stts/stsz/stsc/stco');
  const samples = layoutSamples(stsz, stsc, stco);
  applyDecodeTimes(samples, stts);
  applyCompositionOffsets(samples, ctts);
  return samples;
}

/* ---------- track summaries ---------- */

/** Frame size from the sample description, falling back to the (fixed-point) track header. */
function trackSize(entry, tkhd) {
  return {
    width: entry?.width || Math.round(tkhd?.width || 0) || null,
    height: entry?.height || Math.round(tkhd?.height || 0) || null,
  };
}

function describeTrack(t) {
  const entry = t.stbl.stsd?.[0];
  const format = entry?.format ?? null;
  const mdhd = t.mdhd ?? { timescale: 0, duration: 0, creationTime: null };
  return {
    id: t.tkhd?.trackId ?? null,
    handler: t.handler,
    format,
    codec: CODEC_BY_FORMAT[format] ?? format,
    timescale: mdhd.timescale,
    durationSec: mdhd.timescale ? mdhd.duration / mdhd.timescale : 0,
    nbSamples: t.stbl.stsz?.count ?? 0,
    ...trackSize(entry, t.tkhd),
    creationTime: mdhd.creationTime ?? t.tkhd?.creationTime ?? null,
  };
}

function videoSummary(t) {
  if (!t) return null;
  const fps = t.durationSec > 0 ? t.nbSamples / t.durationSec : undefined;
  return { id: t.id, codec: t.codec, format: t.format, width: t.width, height: t.height, fps, durationSec: t.durationSec, nbSamples: t.nbSamples };
}

function audioSummary(t) {
  return t ? { id: t.id, codec: t.codec, durationSec: t.durationSec } : null;
}

/** GPMF track summary; with `stbl` the sample table is resolved to byte ranges and ms timing. */
function gpmdSummary(t, stbl) {
  const out = { trackId: t.id, timescale: t.timescale, durationSec: t.durationSec, nbSamples: t.nbSamples, creationTime: t.creationTime, samples: null };
  if (!stbl) return out;
  const scale = 1000 / t.timescale;
  out.samples = buildSampleTable(stbl).map((s) => ({ offset: s.offset, size: s.size, ctsMs: s.cts * scale, durationMs: s.duration * scale }));
  return out;
}

/* ---------- file access ---------- */

async function readBrand(fh, ftyp) {
  if (!ftyp) return null;
  const b = Buffer.alloc(4);
  await fh.read(b, 0, 4, ftyp.start + ftyp.headerSize);
  return fourcc(b, 0);
}

/** Locate and load the moov box (plus the ftyp major brand). */
async function readMoov(fh, fileSize, filePath) {
  const top = await readTopLevelIndex(fh, fileSize);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Mp4Error('No moov box found (not an MP4 file, or file still being written)', { filePath });
  if (moov.size > MAX_MOOV_BYTES) throw new Mp4Error(`moov box too large (${moov.size} bytes)`, { filePath });
  const buf = Buffer.alloc(moov.size);
  const { bytesRead } = await fh.read(buf, 0, moov.size, moov.start);
  if (bytesRead !== moov.size) throw new Mp4Error('Truncated moov box', { filePath });
  return { moov, buf, brand: await readBrand(fh, top.find((b) => b.type === 'ftyp')) };
}

/**
 * Read the structural metadata of an MP4 file.
 *
 * @param {string} filePath
 * @param {{ withSamples?: boolean }} [opts] withSamples=false skips the gpmd sample table (faster library scans)
 * @returns {Promise<{
 *   filePath: string, fileSize: number, mtimeMs: number, brand: string|null,
 *   creationTime: Date|null, timescale: number, durationSec: number,
 *   video: { id, codec, format, width, height, fps, durationSec, nbSamples }|null,
 *   audio: { id, codec, durationSec }|null,
 *   gpmd: { trackId, timescale, durationSec, nbSamples, creationTime, samples: Array<{ offset, size, ctsMs, durationMs }>|null }|null,
 *   udta: { firmware: string|null, lens: string|null, gpmfHeader: Buffer|null }|null
 * }>}
 */
export async function readMp4Info(filePath, { withSamples = true } = {}) {
  const st = await stat(filePath);
  const fh = await open(filePath, 'r');
  try {
    const { moov, buf, brand } = await readMoov(fh, st.size, filePath);
    const { mvhd, traks, udta } = parseMoov(buf, moov, filePath);
    const tracks = traks.map(describeTrack);
    const gpmdIndex = tracks.findIndex((t) => t.format === 'gpmd');
    return {
      filePath,
      fileSize: st.size,
      mtimeMs: st.mtimeMs,
      brand,
      creationTime: mvhd.creationTime,
      timescale: mvhd.timescale,
      durationSec: mvhd.duration / mvhd.timescale,
      video: videoSummary(tracks.find((t) => t.handler === 'vide')),
      audio: audioSummary(tracks.find((t) => t.handler === 'soun')),
      gpmd: gpmdIndex < 0 ? null : gpmdSummary(tracks[gpmdIndex], withSamples ? traks[gpmdIndex].stbl : null),
      udta,
    };
  } finally {
    await fh.close();
  }
}

/** Merge adjacent samples into single byte ranges so a track is read with few syscalls. */
function contiguousRuns(samples) {
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.offset + last.size === s.offset) last.size += s.size;
    else runs.push({ offset: s.offset, size: s.size });
  }
  return runs;
}

/**
 * Read the given samples' bytes into one Buffer (in order). A short read — the file is
 * still being written or truncated — ends the result early; callers check the length.
 */
export async function readSampleData(filePath, samples) {
  const out = Buffer.alloc(samples.reduce((a, s) => a + s.size, 0));
  const fh = await open(filePath, 'r');
  try {
    let pos = 0;
    for (const run of contiguousRuns(samples)) {
      const { bytesRead } = await fh.read(out, pos, run.size, run.offset);
      pos += bytesRead;
      if (bytesRead !== run.size) return out.subarray(0, pos);
    }
  } finally {
    await fh.close();
  }
  return out;
}

/**
 * Cheap capability probe: scan the first few GPMF payloads for well-known stream keys
 * (GPS5/GPS9/ACCL/GYRO…). Lets the library tell "GPS recorded" from "telemetry track
 * without GPS" without decoding anything.
 * @returns {Promise<{ gps: boolean, imu: boolean, keys: string[] }>}
 */
export async function probeGpmfStreams(filePath, info, { maxSamples = 3, keys = ['GPS9', 'GPS5', 'ACCL', 'GYRO', 'GRAV', 'CORI'] } = {}) {
  const meta = info ?? await readMp4Info(filePath);
  const samples = meta.gpmd?.samples?.slice(0, maxSamples) ?? [];
  const found = new Set();
  if (samples.length) {
    const data = await readSampleData(filePath, samples);
    let pos = 0;
    for (const s of samples) {
      const payload = data.subarray(pos, pos + s.size);
      pos += s.size;
      for (const k of keys) if (!found.has(k) && payload.includes(k, 0, 'latin1')) found.add(k);
    }
  }
  return { gps: found.has('GPS9') || found.has('GPS5'), imu: found.has('ACCL') || found.has('GYRO'), keys: [...found] };
}

/**
 * Timing object expected by gopro-telemetry (cts/duration in ms). Following gpmf-extract,
 * `start` is the track creation time re-interpreted as local time (GoPro writes local
 * wall-clock time into the UTC field).
 */
function gpmfTiming(meta, samples) {
  const created = meta.gpmd.creationTime ?? meta.creationTime ?? new Date(0);
  const video = meta.video;
  return {
    frameDuration: video?.fps ? 1 / video.fps : (video?.nbSamples ? meta.durationSec / video.nbSamples : 1 / 29.97),
    videoDuration: meta.durationSec,
    start: new Date(created.getTime() + created.getTimezoneOffset() * 60000),
    samples: samples.map((s) => ({ cts: s.ctsMs, duration: s.durationMs })),
  };
}

/**
 * Read all GPMF payloads of a file into one contiguous Buffer plus the timing object for
 * `gopro-telemetry`. Memory is proportional to the telemetry track only (~1–2 MB per 10 min).
 */
export async function readGpmfTrack(filePath, info) {
  const meta = info ?? await readMp4Info(filePath);
  const samples = meta.gpmd?.samples;
  if (!samples?.length) throw new Mp4Error('File has no GPMF (gpmd) track', { filePath });
  const rawData = await readSampleData(filePath, samples);
  if (rawData.length !== samples.reduce((a, s) => a + s.size, 0)) throw new Mp4Error('Short read while extracting GPMF samples', { filePath });
  return { rawData, timing: gpmfTiming(meta, samples) };
}
