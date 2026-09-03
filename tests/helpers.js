import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const FIX = {
  gx01: path.join(FIXTURES, 'GX010001.MP4'), // Hero6, 5 s, GPS 3D fix
  gx02: path.join(FIXTURES, 'GX020001.MP4'), // Hero6 (different clip), 5 s, GPS 3D fix — chapter 2 of GX0001 for the library
  gh01: path.join(FIXTURES, 'GH010002.MP4'), // HERO8, 5 s, GPS without fix
};

export async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gopro-viewer-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
