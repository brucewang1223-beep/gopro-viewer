/**
 * Native macOS folder chooser for the import destination. The viewer is a local app, so the
 * server's screen is the user's screen: `osascript` runs Standard Additions' `choose folder` in
 * its own process — no Apple Events to other apps, so no Automation prompt — and `tell me to
 * activate` brings the panel to the front even when the server was started by launchd.
 * Two callers while the panel is open share the same answer.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { httpError } from './http-error.js';
import { isDirectory } from './fs-util.js';

const PICKER_TIMEOUT_MS = 10 * 60 * 1000;   // the panel waits for a person
const CANCELLED = /\(-128\)|user cancell?ed/i; // AppleScript's "User canceled." (error -128)

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/** `osascript` arguments for the chooser: prompt text and the folder it opens on. */
export function chooserArgs(prompt, startDir) {
  const lines = [
    'tell me to activate',
    `set chosen to choose folder with prompt ${quote(prompt)} default location (POSIX file ${quote(startDir)})`,
    'POSIX path of chosen',
  ];
  return lines.flatMap((line) => ['-e', line]);
}

/** Chosen POSIX path (no trailing slash), null when the panel was cancelled; throws on any other failure. */
export function chooserResult(err, stdout, stderr) {
  if (!err) return stdout.trim().replace(/\/+$/, '') || null;
  if (CANCELLED.test(`${stderr} ${err.message}`)) return null;
  throw new Error(`folder chooser failed: ${(stderr || err.message).trim()}`);
}

let pending = null;

/**
 * Shows the panel and resolves to the chosen folder, or null when cancelled.
 * @param {{ prompt: string, startDir?: string }} opts  startDir falls back to the home folder when it does not exist
 */
export async function chooseFolder({ prompt, startDir }) {
  if (process.platform !== 'darwin') throw httpError(501, 'the folder chooser needs macOS');
  if (pending) return pending;
  const start = (await isDirectory(startDir)) ? startDir : os.homedir();
  pending = new Promise((resolve, reject) => {
    execFile('osascript', chooserArgs(prompt, start), { timeout: PICKER_TIMEOUT_MS }, (err, stdout, stderr) => {
      try { resolve(chooserResult(err, stdout, stderr)); } catch (e) { reject(e); }
    });
  }).finally(() => { pending = null; });
  return pending;
}
