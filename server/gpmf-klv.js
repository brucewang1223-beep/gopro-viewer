/**
 * Minimal GPMF KLV reader — only what gopro-telemetry does not expose:
 *   - per-stream metadata such as ORIN / ORIO (sensor axis orientation) and STNM,
 *   - the camera settings GPMF stored in the MP4 `udta` (HyperSmooth, FOV, Protune…).
 *
 * KLV layout: key(4) type(1) size(1) repeat(2) [data padded to 4 bytes]; type 0 = nested container.
 */

const CONTAINER = 0;
const MAX_CONTAINER_DEPTH = 3;

function* iterate(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const key = buf.toString('latin1', p, p + 4);
    const type = buf[p + 4];
    const size = buf[p + 5];
    const repeat = buf.readUInt16BE(p + 6);
    const len = size * repeat;
    const padded = (len + 3) & ~3;
    const dataStart = p + 8;
    const dataEnd = Math.min(dataStart + len, end);
    yield { key, type, size, repeat, dataStart, dataEnd };
    if (len === 0 && key === '\0\0\0\0') break; // zero padding
    p = dataStart + padded;
  }
}

function readString(buf, klv) {
  return buf.toString('latin1', klv.dataStart, klv.dataEnd).replace(/\0+$/g, '');
}

/* ---------- scalar values (only the types used by the settings header) ---------- */

const SCALAR = {
  b: [1, (buf, p) => buf.readInt8(p)],
  B: [1, (buf, p) => buf.readUInt8(p)],
  s: [2, (buf, p) => buf.readInt16BE(p)],
  S: [2, (buf, p) => buf.readUInt16BE(p)],
  l: [4, (buf, p) => buf.readInt32BE(p)],
  L: [4, (buf, p) => buf.readUInt32BE(p)],
  f: [4, (buf, p) => buf.readFloatBE(p)],
  F: [4, (buf, p) => buf.toString('latin1', p, p + 4)],
  d: [8, (buf, p) => buf.readDoubleBE(p)],
  j: [8, (buf, p) => Number(buf.readBigInt64BE(p))],
  J: [8, (buf, p) => Number(buf.readBigUInt64BE(p))],
};

/** Decode a string, scalar or array value; complex/unknown types yield null. */
function readValue(buf, klv) {
  const type = String.fromCharCode(klv.type);
  if (type === 'c') return readString(buf, klv);
  const scalar = SCALAR[type];
  if (!scalar) return null;
  const [width, read] = scalar;
  const out = [];
  for (let p = klv.dataStart; p + width <= klv.dataEnd; p += width) out.push(read(buf, p));
  return out.length === 1 ? out[0] : out;
}

/* ---------- camera settings (MP4 udta GPMF) ---------- */

const FOV_NAMES = { L: 'Linear', W: 'Wide', S: 'SuperView', H: 'HyperView', N: 'Narrow', M: 'Medium' };
const HCTL_NAMES = { Off: 'Off', Level: 'Horizon Leveling', Locked: 'Horizon Lock', Lock: 'Horizon Lock' };

/**
 * Collect the keys of one DEVC into `raw`. Settings sit directly in the DEVC (HERO8+) or
 * inside nested STRM containers (HERO6/7); keys of secondary devices such as the FOV
 * device are prefixed with their DVID ("FOVL.VFOV"). First occurrence wins.
 */
function collectKeys(buf, container, raw, parentPrefix = '', depth = 0) {
  let prefix = parentPrefix;
  for (const k of iterate(buf, container.dataStart, container.dataEnd)) {
    if (k.key === 'DVID') {
      const dvid = readValue(buf, k);
      prefix = dvid === 1 ? '' : `${String(dvid)}.`;
    } else if (k.type === CONTAINER) {
      if (depth < MAX_CONTAINER_DEPTH) collectKeys(buf, k, raw, prefix, depth + 1);
    } else {
      const v = readValue(buf, k);
      if (v != null && raw[prefix + k.key] === undefined) raw[prefix + k.key] = v;
    }
  }
}

const yesNo = (v) => (v === 'Y' ? true : v === 'N' ? false : null);
const orNull = (v) => v ?? null;
const unless = (v, off) => (v && v !== off ? v : null);

/** EISA holds the HyperSmooth mode; early firmware wrote a bare Y/N flag instead. */
function eisMode(eisa) {
  if (typeof eisa !== 'string') return null;
  const mode = eisa.trim();
  if (['', 'N', 'N/A', 'OFF'].includes(mode.toUpperCase())) return null;
  return mode.toUpperCase() === 'Y' ? 'EIS' : mode;
}

function stabilizationOf(raw) {
  const enabled = yesNo(raw.EISE);
  const mode = eisMode(raw.EISA);
  if (enabled === null && !mode) return null;
  return { enabled: enabled ?? !!mode, mode: mode ?? (enabled ? 'HS EIS' : null) };
}

function fovOf(raw) {
  const code = raw['FOVL.VFOV'] ?? raw.VFOV ?? null;
  return code ? { code, name: FOV_NAMES[code] ?? code, diagonalDeg: raw['FOVL.ZFOV'] ?? raw.ZFOV ?? null } : null;
}

function videoOf(raw) {
  const fps = Array.isArray(raw.VFPS) && raw.VFPS.length === 2 && raw.VFPS[1] ? raw.VFPS[0] / raw.VFPS[1] : null;
  return {
    resolution: Array.isArray(raw.VRES) && raw.VRES.length === 2 ? { width: raw.VRES[0], height: raw.VRES[1] } : null,
    fps: fps ? Math.round(fps * 1000) / 1000 : null,
    hdr: yesNo(raw.HDRV),
  };
}

function protuneOf(raw) {
  return {
    protune: yesNo(raw.PRTN),
    color: orNull(raw.PTCL),
    sharpness: orNull(raw.PTSH),
    whiteBalance: orNull(raw.PTWB),
    exposure: orNull(raw.EXPT),
    isoMin: orNull(raw.PIMN),
    isoMax: orNull(raw.PIMX),
    ev: raw.PTEV != null ? Number(raw.PTEV) : null,
    bitrate: orNull(raw.BITR),
    denoise: orNull(raw.DNSC),
    motionBlur: orNull(raw.MBLR),
    audio: orNull(raw.AUDO),
  };
}

function digitalZoomOf(raw) {
  const on = yesNo(raw.DZOM);
  if (on === true) return raw.DZMX ?? raw.ZOOM ?? true;
  return on === false ? false : null;
}

function extrasOf(raw) {
  return {
    digitalZoom: digitalZoomOf(raw),
    lensMod: unless(raw.LMOD, 'NONE'),
    mediaMod: unless(raw.MMOD, 'STEREO'),
    hindsight: unless(raw.HSGT, 'OFF'),
    orientation: orNull(raw.OREN),
    control: orNull(raw.CTRL),
    powerProfile: orNull(raw.PWPR),
    tzMinutes: typeof raw.TZON === 'number' ? raw.TZON : null,
    createdLocalEpoch: typeof raw.CDAT === 'number' ? raw.CDAT : null,
  };
}

function summarizeSettings(raw) {
  return {
    model: orNull(raw.MINF),
    firmware: orNull(raw.FMWR),
    serial: orNull(raw.CASN),
    stabilization: stabilizationOf(raw),
    horizonControl: raw.HCTL ? (HCTL_NAMES[raw.HCTL] ?? raw.HCTL) : null,
    fov: fovOf(raw),
    ...videoOf(raw),
    ...protuneOf(raw),
    ...extrasOf(raw),
  };
}

/**
 * Parse the GPMF box stored in the MP4 `udta` (camera settings written at record time).
 * Returns the raw key map plus a human-readable summary — most importantly whether
 * HyperSmooth (EIS) was on. The summary is null when the header holds no known setting
 * (Fusion writes only lens calibrations there); the result is null without any DEVC.
 * @param {Buffer|null|undefined} header
 * @returns {{ raw: Record<string, any>, summary: object|null } | null}
 */
export function parseHeaderSettings(header) {
  if (!header || header.length < 8) return null;
  const raw = {};
  let devices = 0;
  for (const devc of iterate(header, 0, header.length)) {
    if (devc.key !== 'DEVC' || devc.type !== CONTAINER) continue;
    devices++;
    collectKeys(header, devc, raw);
  }
  if (!devices) return null;
  const summary = summarizeSettings(raw);
  return { raw, summary: Object.values(summary).some((v) => v != null) ? summary : null };
}

/** Settings summary of a header, or null — never throws on odd input. */
export function headerSettingsSummary(header) {
  try {
    return parseHeaderSettings(header)?.summary ?? null;
  } catch {
    return null;
  }
}

/* ---------- sensor stream orientation ---------- */

/** Sensor key and orientation metadata of one STRM container. */
function streamMeta(buf, strm, wanted) {
  const meta = { sensor: null, orin: null, orio: null, stnm: null };
  for (const k of iterate(buf, strm.dataStart, strm.dataEnd)) {
    if (wanted.has(k.key)) meta.sensor = k.key;
    else if (k.key === 'ORIN' || k.key === 'ORIO' || k.key === 'STNM') meta[k.key.toLowerCase()] = readString(buf, k);
  }
  return meta;
}

/**
 * Inspect the first DEVC payloads and return orientation metadata per sensor stream.
 * @param {Buffer} rawData concatenated GPMF payloads
 * @param {string[]} sensorKeys stream keys of interest
 * @returns {Record<string, { orin: string|null, orio: string|null, stnm: string|null }>}
 */
export function readStreamOrientations(rawData, sensorKeys = ['ACCL', 'GYRO']) {
  const out = {};
  const wanted = new Set(sensorKeys);
  const limit = Math.min(rawData.length, 4 * 1024 * 1024);
  let devcSeen = 0;
  for (const devc of iterate(rawData, 0, limit)) {
    if (devc.key !== 'DEVC' || devc.type !== CONTAINER) continue;
    if (devcSeen++ > 2) break; // the first few payloads are enough
    for (const strm of iterate(rawData, devc.dataStart, devc.dataEnd)) {
      if (strm.key !== 'STRM' || strm.type !== CONTAINER) continue;
      const { sensor, ...meta } = streamMeta(rawData, strm, wanted);
      if (sensor && !out[sensor]) out[sensor] = meta;
    }
    if (sensorKeys.every((k) => out[k])) break;
  }
  return out;
}

/**
 * Build the mapping from a gopro-telemetry sample value array to the GoPro camera
 * frame (X = camera left, Y = camera back, Z = up — right-handed, see gpmf-parser README).
 *
 * gopro-telemetry reorders values into ORIO when both ORIN and ORIO exist; with only ORIN
 * present (HERO11+) the values stay in raw order, i.e. ORIN order. Without either, GoPro's
 * historic default order Z,X,Y is assumed (HERO5). Lower-case letters mean a negated axis.
 *
 * @returns {{ order: string, map: Array<{ axis: 'x'|'y'|'z', index: number, sign: 1|-1 }>, source: string }}
 */
export function cameraFrameMapping({ orin, orio } = {}) {
  let order = 'ZXY'; let source = 'default';
  if (orin && orio && orio.length === 3) { order = orio; source = 'ORIO'; }
  else if (orin && orin.length === 3) { order = orin; source = 'ORIN'; }
  const map = [];
  for (let i = 0; i < 3; i++) {
    const axis = order[i].toLowerCase();
    if (!'xyz'.includes(axis)) return cameraFrameMapping({}); // unexpected letters → default
    map.push({ axis, index: i, sign: order[i] === order[i].toUpperCase() ? 1 : -1 });
  }
  if (new Set(map.map((m) => m.axis)).size !== 3) return cameraFrameMapping({}); // an axis named twice → default
  return { order, map, source };
}
