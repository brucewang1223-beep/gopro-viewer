/**
 * Which clock the MP4 creation time (`mvhd`) of a GoPro file follows.
 *
 * Cameras up to the HERO11 write the camera's *local* wall clock into the UTC field; the
 * HERO12 and later write true UTC and keep the local clock in the settings header (CDAT,
 * an epoch that is again local-as-UTC) next to the time zone (TZON, minutes east of UTC).
 * Verified on a HERO13 (mvhd 04:48:29Z, CDAT 08:48:29, TZON 240) and on Hero6 / HERO8
 * files (mvhd 8 h behind the GPS clock, no header). Without a header the GPS clock decides:
 * a creation time within minutes of the GPS time at the start of the file is UTC, one a
 * time-zone-sized offset away is local.
 */

const TOLERANCE_MS = 15 * 60 * 1000;      // camera clocks drift by minutes, never by a time zone
const MAX_ZONE_MS = 14 * 60 * 60 * 1000;  // no time zone is further than 14 h from UTC

/**
 * @param {{ creationTime?: string|null, settings?: object|null, gpsStartUtcMs?: number|null }} clues
 *   creationTime  the mvhd time as an ISO string
 *   settings      the header settings summary (createdLocalEpoch, tzMinutes)
 *   gpsStartUtcMs GPS time (epoch ms) at video time 0, when a fix was seen
 * @returns {'utc'|'local'|null} null when nothing tells the two apart
 */
export function clockConvention({ creationTime, settings, gpsStartUtcMs = null }) {
  const mvhd = Date.parse(creationTime ?? '');
  if (!Number.isFinite(mvhd)) return null;
  return byHeader(mvhd, settings) ?? byGpsClock(mvhd, gpsStartUtcMs);
}

/** The header's local clock (CDAT) and zone (TZON) say which one the creation time equals. */
function byHeader(mvhd, settings) {
  const cdat = settings?.createdLocalEpoch; const tz = settings?.tzMinutes;
  if (cdat == null || tz == null) return null;
  if (Math.abs(mvhd - (cdat - tz * 60) * 1000) < TOLERANCE_MS) return 'utc';
  if (Math.abs(mvhd - cdat * 1000) < TOLERANCE_MS) return 'local';
  return null;
}

/** The GPS clock at video time 0: a creation time within minutes of it is UTC, one a zone away is local. */
function byGpsClock(mvhd, gpsStartUtcMs) {
  if (gpsStartUtcMs == null) return null;
  const off = Math.abs(mvhd - gpsStartUtcMs);
  if (off < TOLERANCE_MS) return 'utc';
  return off <= MAX_ZONE_MS ? 'local' : null;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Start of the recording as the camera's local wall clock (an ISO string whose digits are
 * local time — the convention the library has always used) and as true UTC when it can be
 * known. An unknown convention is treated as the historic local one.
 * @returns {{ local: string|null, utc: string|null }}
 */
export function startTimes(clues) {
  const { creationTime, settings, gpsStartUtcMs = null } = clues;
  const mvhd = Date.parse(creationTime ?? '');
  if (!Number.isFinite(mvhd)) return { local: null, utc: gpsStartUtcMs != null ? iso(gpsStartUtcMs) : null };
  const tz = settings?.tzMinutes ?? null;
  const clockIsUtc = clockConvention(clues) === 'utc';
  const local = clockIsUtc && tz != null ? iso(mvhd + tz * 60000) : creationTime;
  const utc = clockIsUtc ? creationTime : (gpsStartUtcMs != null ? iso(gpsStartUtcMs) : (tz != null ? iso(mvhd - tz * 60000) : null));
  return { local, utc };
}
