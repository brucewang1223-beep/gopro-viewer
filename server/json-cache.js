/**
 * Tiny JSON file cache shared by the library (per-file info) and the telemetry service
 * (per-chapter data). Reads validate freshness; writes are best effort.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Parsed JSON when the file exists and `isFresh(json)` holds, otherwise null. */
export async function readJsonCache(file, isFresh) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return isFresh(data) ? data : null;
  } catch {
    return null;
  }
}

/** A cache that cannot be written only costs a warning. */
export async function writeJsonCache(file, data, log) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  } catch (e) {
    log.warn(`cannot write cache ${path.basename(file)}: ${e.message}`);
  }
}
