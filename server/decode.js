/**
 * Thin wrapper around `gopro-telemetry` (CommonJS): decoding options and iteration over
 * the devices in a decoded result.
 */

import { createRequire } from 'node:module';

const goproTelemetry = createRequire(import.meta.url)('gopro-telemetry');

// `egm96-universal` looks unused here: it is an optional peer dependency that
// gopro-telemetry requires at run time to convert WGS84 ellipsoid heights to mean sea
// level. Drop it from package.json and altitudes silently revert to ellipsoid heights.

/**
 * Options for gopro-telemetry ("GPS" = best of GPS9/GPS5). A fresh object every time:
 * the library mutates `opts.stream` in place.
 */
export function telemetryOptions(streams = ['GPS', 'ACCL', 'GYRO']) {
  return { stream: [...streams], repeatSticky: true, tolerant: true };
}

/** Decode raw GPMF payloads (`{ rawData, timing? }`) into interpreted streams. */
export function decodeTelemetry(input, streams) {
  return goproTelemetry(input, telemetryOptions(streams));
}

/** [id, device] pairs of a decoded result, skipping the `frames/second` scalar. */
export function* devicesOf(tel) {
  for (const [id, dev] of Object.entries(tel)) {
    if (id !== 'frames/second' && dev?.streams) yield [id, dev];
  }
}
