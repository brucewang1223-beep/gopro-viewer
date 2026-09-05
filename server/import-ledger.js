/**
 * Import ledger: every camera file that was ever imported. A file listed here is never picked
 * again by default — whether or not its local copy still exists — and only comes back when
 * the user ticks it by hand. That is why the ledger lives outside `.cache/` (which is safe to
 * delete) in `import-ledger.json` next to `config.json` (`config.ledgerFile`).
 *
 * Entries are keyed by the card file's identity: camera serial, folder, name, byte size and
 * creation time. The same clip on a re-inserted card matches; a new clip that reuses the
 * name after a card format does not.
 */

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './fs-util.js';
import { shortId } from './ids.js';

const VERSION = 1;

/** Identity of a card file; `item` is a media-list record ({ dir, name, size, cre }). */
export const importKey = (serial, item) => shortId('import', serial, item.dir, item.name, item.size, item.cre);

export class ImportLedger {
  constructor(file) {
    this.file = file;
    this.entries = new Map();   // key → { camera, serial, dir, name, size, cre, importedAt, dest, files }
    this.loaded = false;
  }

  /** Reads the file once; a missing ledger is an empty one, a corrupt one is an error (never silently re-import everything). */
  async load() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.entries = new Map(Object.entries(data.entries ?? {}));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Cannot read import ledger ${this.file}: ${e.message}`, { cause: e });
    }
    this.loaded = true;
  }

  get(key) { return this.entries.get(key) ?? null; }

  get size() { return this.entries.size; }

  /** Records an import: the file is written first (atomically), so memory never claims what disk does not hold. */
  async record(key, entry) {
    const entries = new Map(this.entries).set(key, entry);
    await writeJsonAtomic(this.file, { v: VERSION, entries: Object.fromEntries(entries) }, { pretty: true });
    this.entries = entries;
  }
}
