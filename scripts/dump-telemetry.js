#!/usr/bin/env node
/**
 * CLI: extract telemetry from one or more GoPro files without running the server.
 *
 *   node scripts/dump-telemetry.js <file.MP4> [more chapters...] [--format json|gpx|csv|csv-accl|csv-gyro] [--accel-hz 25] [--out file]
 *
 * Multiple files are treated as consecutive chapters of one recording (in the order given).
 * Output goes to stdout unless --out is given. JSON is the same structure the UI consumes.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readMp4Info } from '../server/mp4.js';
import { parseChapter, mergeChapters } from '../server/telemetry.js';
import { toGpx, toCsv } from '../server/export.js';
import { setLogLevel } from '../server/log.js';

const USAGE = 'usage: dump-telemetry.js <file.MP4> [chapter2.MP4 ...] [--format json|gpx|csv|csv-accl|csv-gyro] [--accel-hz 25] [--out file]\n';

const FORMATS = {
  json: (merged) => JSON.stringify(merged),
  gpx: (merged) => toGpx(merged),
  csv: (merged) => toCsv(merged, 'gps'),
  'csv-accl': (merged) => toCsv(merged, 'accl'),
  'csv-gyro': (merged) => toCsv(merged, 'gyro'),
};

function parseArgs(argv) {
  const out = { files: [], format: 'json', accelHz: 25, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') out.format = argv[++i];
    else if (a === '--accel-hz') out.accelHz = Number(argv[++i]);
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out.files.push(a);
  }
  return out;
}

/** A recording record like the library builds, from the chapter files given on the command line. */
async function buildRecording(files) {
  const chapters = [];
  let offset = 0;
  for (const [index, file] of files.entries()) {
    const abs = path.resolve(file);
    const info = await readMp4Info(abs, { withSamples: false });
    chapters.push({
      id: `c${index}`, file: path.basename(abs), path: abs, index, offsetSec: offset, durationSec: info.durationSec,
      sizeBytes: info.fileSize, creationTime: info.creationTime?.toISOString() ?? null, video: info.video,
    });
    offset += info.durationSec;
  }
  const first = chapters[0];
  return {
    id: 'cli', name: path.basename(first.file, path.extname(first.file)), chapters, durationSec: offset, startTime: first.creationTime,
    codec: first.video?.codec ?? null, width: first.video?.width ?? null, height: first.video?.height ?? null, fps: first.video?.fps ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const render = FORMATS[args.format];
  if (!render) throw new Error(`unknown format ${args.format}`);
  setLogLevel('warn');
  const recording = await buildRecording(args.files);
  const items = [];
  for (const chapter of recording.chapters) items.push({ chapter, data: await parseChapter(chapter.path, { accelHz: args.accelHz }) });
  const merged = mergeChapters(recording, items);
  const text = render(merged);
  if (args.out) {
    await writeFile(args.out, text);
    process.stderr.write(`wrote ${args.out} (${text.length} bytes)\n`);
  } else {
    process.stdout.write(text);
  }
  if (merged.warnings.length) process.stderr.write(`warnings:\n  ${merged.warnings.join('\n  ')}\n`);
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
