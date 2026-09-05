/** Small file-system helpers shared by the server modules. */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Whether `p` names an existing directory (false for a file, a missing path or no path at all). */
export async function isDirectory(p) {
  try { return !!p && (await stat(p)).isDirectory(); } catch { return false; }
}

/** Byte size of a file, 0 when it does not exist. */
export async function sizeOf(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

/**
 * Writes JSON through a temporary file and a rename, so a crash or a second writer never
 * leaves a half-written file behind (`pretty` adds indentation and a trailing newline).
 */
export async function writeJsonAtomic(file, data, { pretty = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}
