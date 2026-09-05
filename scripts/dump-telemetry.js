#!/usr/bin/env node
/**
 * CLI: extract telemetry from one or more GoPro files without running the server.
 *
 *   node scripts/dump-telemetry.js <file.MP4> [more chapters...] [--format json|gpx|geojson|csv|csv-accl|csv-gyro] [--accel-hz 25] [--out file]
 *
 * Multiple files are treated as consecutive chapters of one recording (in the order given).
 * Output goes to stdout unless --out is given. JSON is the same structure the UI consumes.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readMp4Info } from '../server/mp4.js';
import { parseChapter, mergeChapters } from '../server/telemetry.js';
import { toGpx, toCsv, toGeoJson } from '../server/export.js';
import { setLogLevel } from '../server/log.js';

const USAGE = 'usage: dump-telemetry.js <file.MP4> [chapter2.MP4 ...] [--format json|gpx|geojson|csv|csv-accl|csv-gyro] [--accel-hz 25] [--out file]\n';

const FORMATS = {
  json: (merged) => JSON.stringify(merged),
  gpx: (merged) => toGpx(merged),
  geojson: (merged) => toGeoJson(merged),
  csv: (merged) => toCsv(merged, 'gps'),
  'csv-accl': (merged) => toCsv(merged, 'accl'),
  'csv-gyro': (merged) => toCsv(merged, 'gyro'),
};

const OPTIONS = { '--format': 'format', '-f': 'format', '--accel-hz': 'accelHz', '--out': 'out', '-o': 'out' };

function parseArgs(argv) {
  const out = { files: [], format: 'json', accelHz: 25, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const key = OPTIONS[a];
    if (!key) { out.files.push(a); continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  out.accelHz = Number(out.accelHz);
  if (!(out.accelHz > 0 && out.accelHz <= 200)) throw new Error(`--accel-hz must be between 1 and 200, got ${out.accelHz}`);
  if (!FORMATS[out.format]) throw new Error(`unknown format ${out.format} (expected ${Object.keys(FORMATS).join(' | ')})`);
  return out;
}

/** One chapter record like the library builds, plus the parsed MP4 info it came from. */
async function chapterOf(file, index, offsetSec) {
  const abs = path.resolve(file);
  const info = await readMp4Info(abs);
  const chapter = {
    id: `c${index}`, file: path.basename(abs), path: abs, index, offsetSec, durationSec: info.durationSec,
    sizeBytes: info.fileSize, creationTime: info.creationTime?.toISOString() ?? null, video: info.video,
  };
  return { chapter, info };
}

/** A recording record like the library builds, from the chapter files given on the command line. */
async function buildRecording(files) {
  const chapters = []; const infos = [];
  let offset = 0;
  for (const [index, file] of files.entries()) {
    const { chapter, info } = await chapterOf(file, index, offset);
    chapters.push(chapter); infos.push(info);
    offset += info.durationSec;
  }
  const first = chapters[0];
  const video = first.video ?? {};
  return {
    recording: {
      id: 'cli', name: path.basename(first.file, path.extname(first.file)), chapters, durationSec: offset, startTime: first.creationTime,
      codec: video.codec ?? null, width: video.width ?? null, height: video.height ?? null, fps: video.fps ?? null,
    },
    infos,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  setLogLevel('warn');
  const { recording, infos } = await buildRecording(args.files);
  const items = [];
  for (const [i, chapter] of recording.chapters.entries()) items.push({ chapter, data: await parseChapter(chapter.path, { accelHz: args.accelHz, info: infos[i] }) });
  const merged = mergeChapters(recording, items);
  const text = FORMATS[args.format](merged);
  if (args.out) {
    await writeFile(args.out, text);
    process.stderr.write(`wrote ${args.out} (${text.length} bytes)\n`);
  } else {
    process.stdout.write(text);
  }
  if (merged.warnings.length) process.stderr.write(`warnings:\n  ${merged.warnings.join('\n  ')}\n`);
}

main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
