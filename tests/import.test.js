import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dateFolder, filesFor, oldestFirst, Importer } from '../server/importer.js';
import { ImportLedger, importKey } from '../server/import-ledger.js';
import { discoverCameraUrl, sizeOf } from '../server/gopro-camera.js';
import { chooserArgs, chooserResult } from '../server/folder-picker.js';
import { sampleCard, startFakeCamera } from './fake-camera.js';
import { withTempDir } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const keysOf = (snap, names) => snap.items.filter((it) => names.includes(it.name)).map((it) => it.key);
const LRV_ONLY = { lrv: true, thm: false };
const NEITHER = { lrv: false, thm: false };
const BOTH = { lrv: true, thm: true };

async function finished(importer) {
  while (importer.job.running) await wait(15);
  return importer.job.toJSON();
}

/** Fake camera + importer with an empty ledger inside `dir`. */
async function setup(dir, card = sampleCard()) {
  const cam = await startFakeCamera(card);
  const ledger = new ImportLedger(path.join(dir, 'ledger', 'import-ledger.json'));
  const importer = new Importer({ ledger, cameraUrl: cam.url });
  return { cam, ledger, importer, card, dest: path.join(dir, 'footage') };
}

test('date folders follow the camera clock (local time stored as UTC)', () => {
  assert.equal(dateFolder(1788598094), '2026-09-05');
  assert.equal(dateFolder(1788480000), '2026-09-04');
  assert.equal(dateFolder(1788479999), '2026-09-03');
});

test('the camera is found through the GoPro USB interface', () => {
  const up = { lo0: [{ family: 'IPv4', address: '127.0.0.1' }], en9: [{ family: 'IPv6', address: 'fe80::1' }, { family: 'IPv4', address: '172.21.165.52' }] };
  assert.equal(discoverCameraUrl(up), 'http://172.21.165.51:8080');
  assert.equal(discoverCameraUrl({ lo0: [{ family: 'IPv4', address: '127.0.0.1' }], en0: [{ family: 'IPv4', address: '192.168.1.20' }] }), null);
});

test('sidecar options: LRV when listed and ticked, THM only when ticked, photos never get either', () => {
  const gx4 = { dir: '100GOPRO', name: 'GX010004.MP4', size: 10, cre: 2, lrvSize: 5 };
  const gx5 = { dir: '100GOPRO', name: 'GX010005.MP4', size: 20, cre: 3, lrvSize: 0 };
  const jpg = { dir: '100GOPRO', name: 'GOPR0001.JPG', size: 1, cre: 1, lrvSize: 0 };
  const old = { dir: '100GOPRO', name: 'GOPR0002.MP4', size: 30, cre: 4, lrvSize: 7 };
  const names = (item, options) => filesFor(item, options).map((f) => f.name);
  assert.deepEqual(names(gx4, LRV_ONLY), ['GX010004.MP4', 'GL010004.LRV']);
  assert.deepEqual(names(gx4, BOTH), ['GX010004.MP4', 'GL010004.LRV', 'GX010004.THM']);
  assert.deepEqual(names(gx4, NEITHER), ['GX010004.MP4']);
  assert.deepEqual(names(gx5, BOTH), ['GX010005.MP4', 'GX010005.THM'], 'no LRV listed → none requested');
  assert.deepEqual(names(old, LRV_ONLY), ['GOPR0002.MP4', 'GOPR0002.LRV'], 'HERO5-era names keep their stem');
  assert.deepEqual(names(jpg, BOTH), ['GOPR0001.JPG']);
  assert.equal(filesFor(gx4, BOTH)[2].size, null, 'the THM size is unknown until fetched');
  assert.deepEqual(oldestFirst([gx5, gx4, jpg]).map((f) => f.name), ['GOPR0001.JPG', 'GX010004.MP4', 'GX010005.MP4']);
});

test('no camera on USB gives an empty snapshot with a reason, not an error', async () => withTempDir(async (dir) => {
  const importer = new Importer({ ledger: new ImportLedger(path.join(dir, 'ledger.json')), discover: () => null });
  const snap = await importer.snapshot();
  assert.equal(snap.camera, null);
  assert.match(snap.reason, /USB/);
  assert.deepEqual(snap.items, []);
  assert.equal(snap.job, null);
}));

test('import with the LRV: date sub-folders, ledger entries, no THM requested', async () => withTempDir(async (dir) => {
  const { cam, ledger, importer, card, dest } = await setup(dir);
  try {
    const snap = await importer.snapshot();
    assert.equal(snap.camera.model, 'HERO13 Black');
    assert.equal(snap.camera.serial, 'C3531325563165');
    assert.deepEqual(snap.items.map((it) => it.name), ['GOPR0001.JPG', 'GX010004.MP4', 'GX010005.MP4'], 'oldest first');
    assert.ok(snap.items.every((it) => it.imported === null && it.key.length === 16));
    assert.equal(snap.items.find((it) => it.name === 'GX010004.MP4').date, '2026-09-05');

    const started = await importer.start({ dest, ...LRV_ONLY, keys: snap.items.map((it) => it.key) });
    assert.equal(started.state, 'running');
    assert.deepEqual(started.options, LRV_ONLY);
    assert.equal(started.totalBytes, 10_000 + 2_000 + 20_000 + 1_000);
    const job = await finished(importer);
    assert.equal(job.state, 'done');
    assert.deepEqual(job.items.map((it) => [it.name, it.status]), [['GOPR0001.JPG', 'done'], ['GX010004.MP4', 'done'], ['GX010005.MP4', 'done']]);
    assert.equal(job.doneBytes, 33_000);

    for (const [name, folder] of [['GX010004.MP4', '2026-09-05'], ['GL010004.LRV', '2026-09-05'], ['GX010005.MP4', '2026-09-05'], ['GOPR0001.JPG', '2026-09-04']]) {
      assert.deepEqual(await readFile(path.join(dest, folder, name)), card.files.get(name), name);
    }
    assert.ok(cam.hits.every((h) => !/\.THM$/i.test(h.path)), 'the THM on the card is not requested unless ticked');
    assert.deepEqual(job.items.find((it) => it.name === 'GX010005.MP4').files.map((f) => [f.name, f.status]), [['GX010005.MP4', 'done']]);

    assert.equal(ledger.size, 3);
    const onDisk = JSON.parse(await readFile(ledger.file, 'utf8'));
    assert.equal(onDisk.v, 1);
    const entry = onDisk.entries[keysOf(snap, ['GX010004.MP4'])[0]];
    assert.equal(entry.serial, 'C3531325563165');
    assert.equal(entry.dest, path.join(dest, '2026-09-05'));
    assert.deepEqual(entry.files, ['GX010004.MP4', 'GL010004.LRV']);

    const after = await importer.snapshot();
    assert.ok(after.items.every((it) => it.imported?.dest.endsWith(it.date)), 'everything is now known to the ledger');
    assert.equal(after.job.state, 'done');
  } finally { await cam.close(); }
}));

test('with the THM ticked it is fetched when the card has one and skipped when it does not', async () => withTempDir(async (dir) => {
  const { cam, importer, card, dest } = await setup(dir);
  try {
    const snap = await importer.snapshot();
    await importer.start({ dest, ...BOTH, keys: keysOf(snap, ['GX010004.MP4', 'GX010005.MP4']) });
    const job = await finished(importer);
    assert.equal(job.state, 'done');
    const [gx4, gx5] = job.items;
    assert.deepEqual(gx4.files.map((f) => [f.name, f.status, f.size]), [['GX010004.MP4', 'done', 10_000], ['GL010004.LRV', 'done', 2_000], ['GX010004.THM', 'done', null]]);
    assert.deepEqual(gx5.files.map((f) => [f.name, f.status]), [['GX010005.MP4', 'done'], ['GX010005.THM', 'absent']]);
    assert.deepEqual(await readFile(path.join(dest, '2026-09-05', 'GX010004.THM')), card.files.get('GX010004.THM'));
    assert.equal(job.totalBytes, 32_000 + 500, 'the thumbnail joins the total once its size is known');
    assert.equal(job.doneBytes, 32_500);
    assert.equal(await sizeOf(path.join(dest, '2026-09-05', 'GX010005.THM')), 0);
  } finally { await cam.close(); }
}));

test('imported clips are only re-fetched when asked, and verified in place when already there', async () => withTempDir(async (dir) => {
  const { cam, ledger, importer, dest } = await setup(dir);
  try {
    const snap = await importer.snapshot();
    await importer.start({ dest, ...NEITHER, keys: keysOf(snap, ['GX010004.MP4']) });
    await finished(importer);
    const key = keysOf(snap, ['GX010004.MP4'])[0];
    assert.equal(key, importKey('C3531325563165', snap.items.find((it) => it.name === 'GX010004.MP4')));
    const downloads = () => cam.hits.filter((h) => h.path.endsWith('GX010004.MP4')).length;
    assert.equal(downloads(), 1);

    // same destination again (a manual re-import): the complete file is verified, not downloaded
    await importer.start({ dest, ...NEITHER, keys: [key] });
    let job = await finished(importer);
    assert.equal(job.state, 'done');
    assert.equal(job.items[0].files[0].status, 'present');
    assert.equal(downloads(), 1);

    // a different destination (the local copy was deleted or moved): downloaded again, ledger follows
    const dest2 = path.join(dir, 'elsewhere');
    await importer.start({ dest: dest2, ...NEITHER, keys: [key] });
    job = await finished(importer);
    assert.equal(job.items[0].files[0].status, 'done');
    assert.equal(downloads(), 2);
    assert.equal(ledger.get(key).dest, path.join(dest2, '2026-09-05'));
    assert.equal(ledger.size, 1);
  } finally { await cam.close(); }
}));

test('a partial download is resumed with a Range request', async () => withTempDir(async (dir) => {
  const { cam, importer, card, dest } = await setup(dir);
  try {
    const original = card.files.get('GX010005.MP4');
    await mkdir(path.join(dest, '2026-09-05'), { recursive: true });
    await writeFile(path.join(dest, '2026-09-05', 'GX010005.MP4.part'), original.subarray(0, 7000));
    const snap = await importer.snapshot();
    await importer.start({ dest, ...NEITHER, keys: keysOf(snap, ['GX010005.MP4']) });
    const job = await finished(importer);
    assert.equal(job.state, 'done');
    const hit = cam.hits.find((h) => h.path.endsWith('GX010005.MP4'));
    assert.equal(hit.range, 'bytes=7000-');
    assert.deepEqual(await readFile(path.join(dest, '2026-09-05', 'GX010005.MP4')), original);
    assert.equal(await sizeOf(path.join(dest, '2026-09-05', 'GX010005.MP4.part')), 0, 'the .part is renamed away');
  } finally { await cam.close(); }
}));

test('cancelling stops the transfer, keeps the partial file and leaves the ledger untouched', async () => withTempDir(async (dir) => {
  const { cam, ledger, importer, card, dest } = await setup(dir);
  try {
    cam.setThrottle(25);          // 1 000 bytes every 25 ms: GX010004 (10 000 bytes) takes ~250 ms
    const snap = await importer.snapshot();
    await importer.start({ dest, ...NEITHER, keys: keysOf(snap, ['GX010004.MP4', 'GX010005.MP4']) });
    await wait(80);
    assert.equal(importer.cancel(), true);
    const job = await finished(importer);
    assert.equal(job.state, 'cancelled');
    assert.deepEqual(job.items.map((it) => it.status), ['cancelled', 'cancelled']);
    assert.equal(job.items[0].error, null);
    const part = await sizeOf(path.join(dest, '2026-09-05', 'GX010004.MP4.part'));
    assert.ok(part > 0 && part < 10_000, `partial file kept (${part} bytes)`);
    assert.equal(ledger.size, 0);
    assert.equal(importer.cancel(), false, 'nothing left to cancel');
    await assert.rejects(importer.deleteImported(keysOf(snap, ['GX010004.MP4'])), { status: 400 }, 'a cancelled clip is not deletable');

    cam.setThrottle(0);
    await importer.start({ dest, ...NEITHER, keys: keysOf(snap, ['GX010004.MP4']) });
    const resumed = await finished(importer);
    assert.equal(resumed.state, 'done');
    assert.deepEqual(await readFile(path.join(dest, '2026-09-05', 'GX010004.MP4')), card.files.get('GX010004.MP4'));
    assert.equal(ledger.size, 1);
  } finally { await cam.close(); }
}));

test('after an import, the clips it brought in can be deleted from the camera — sidecars included, nothing else', async () => withTempDir(async (dir) => {
  const { cam, importer, card, dest } = await setup(dir);
  try {
    await assert.rejects(importer.deleteImported(['0000000000000000']), { status: 409 }, 'nothing imported yet');
    const snap = await importer.snapshot();
    const keys = keysOf(snap, ['GX010004.MP4', 'GX010005.MP4']);
    await importer.start({ dest, ...LRV_ONLY, keys });
    await finished(importer);
    await assert.rejects(importer.deleteImported(keysOf(snap, ['GOPR0001.JPG'])), { status: 400 }, 'the photo was not part of this import');
    await assert.rejects(importer.deleteImported([]), { status: 400 });

    const job = await importer.deleteImported(keys);
    assert.deepEqual(job.items.map((it) => [it.name, it.deleted, it.deleteError]), [['GX010004.MP4', true, null], ['GX010005.MP4', true, null]]);
    assert.deepEqual([...card.files.keys()], ['GOPR0001.JPG'], 'MP4, LRV and THM are gone from the card, the photo stays');
    const deletes = cam.hits.filter((h) => h.path.startsWith('/delete/')).map((h) => h.path.slice(8));
    assert.deepEqual(deletes, ['GX010004.MP4', 'GL010004.LRV', 'GX010004.THM', 'GX010005.MP4', 'GL010005.LRV', 'GX010005.THM'], 'sidecars are attempted after the clip, best effort');
    assert.deepEqual((await importer.snapshot()).items.map((it) => it.name), ['GOPR0001.JPG'], 'the card no longer lists them');
    await assert.rejects(importer.deleteImported(keys), { status: 400 }, 'a clip is deletable once');

    await cam.close();
    await importer.start({ dest, ...NEITHER, keys: keysOf(snap, ['GOPR0001.JPG']) }).catch(() => null);   // camera gone: 503, job untouched
    const again = importer.job.toJSON();
    assert.equal(again.items.length, 2, 'the finished job is still the last one');
  } finally { await cam.close(); }
}));

test('a delete the camera refuses is reported per clip, and the others still go', async () => withTempDir(async (dir) => {
  const { cam, importer, card, dest } = await setup(dir);
  try {
    const snap = await importer.snapshot();
    const keys = keysOf(snap, ['GX010004.MP4', 'GX010005.MP4']);
    await importer.start({ dest, ...NEITHER, keys });
    await finished(importer);
    card.files.delete('GX010004.MP4');          // vanished behind our back → the camera answers 404
    const job = await importer.deleteImported(keys);
    const [gx4, gx5] = job.items;
    assert.equal(gx4.deleted, false);
    assert.match(gx4.deleteError, /HTTP 404/);
    assert.equal(gx5.deleted, true);
    assert.equal(gx5.deleteError, null);
  } finally { await cam.close(); }
}));

test('start() rejects bad input, a second job, and an unreachable camera with HTTP-ready errors', async () => withTempDir(async (dir) => {
  const { cam, importer, dest } = await setup(dir);
  try {
    const snap = await importer.snapshot();
    const keys = keysOf(snap, ['GX010004.MP4']);
    await assert.rejects(importer.start({ dest: 'relative/dir', ...NEITHER, keys }), { status: 400 });
    await assert.rejects(importer.start({ dest, lrv: 'yes', thm: false, keys }), { status: 400 });
    await assert.rejects(importer.start({ dest, ...NEITHER, keys: [] }), { status: 400 });
    await assert.rejects(importer.start({ dest, ...NEITHER, keys: ['0000000000000000'] }), { status: 400 });
    cam.setThrottle(25);
    await importer.start({ dest, ...NEITHER, keys });
    await assert.rejects(importer.start({ dest, ...NEITHER, keys }), { status: 409 });
    await assert.rejects(importer.deleteImported(keys), { status: 409 }, 'not while a job runs');
    importer.cancel();
    await finished(importer);
    await cam.close();
    await assert.rejects(importer.start({ dest, ...NEITHER, keys }), { status: 503 });
    assert.equal((await importer.snapshot()).camera, null);
  } finally { await cam.close(); }
}));

test('the folder panel is scripted with escaped strings and its answer is parsed', () => {
  const args = chooserArgs('Pick a "folder"', '/Users/bruce/GoPro Footage');
  assert.deepEqual(args.slice(0, 2), ['-e', 'tell me to activate']);
  assert.equal(args[3], 'set chosen to choose folder with prompt "Pick a \\"folder\\"" default location (POSIX file "/Users/bruce/GoPro Footage")');
  assert.equal(args[5], 'POSIX path of chosen');
  assert.equal(chooserResult(null, '/Users/bruce/GoPro Footage/\n', ''), '/Users/bruce/GoPro Footage');
  assert.equal(chooserResult(Object.assign(new Error('Command failed'), { code: 1 }), '', 'execution error: User canceled. (-128)\n'), null, 'cancel is not an error');
  assert.throws(() => chooserResult(new Error('spawn osascript ENOENT'), '', ''), /folder chooser failed: spawn osascript ENOENT/);
});

test('a corrupt ledger is refused rather than treated as empty', async () => withTempDir(async (dir) => {
  const file = path.join(dir, 'import-ledger.json');
  await writeFile(file, '{ not json');
  await assert.rejects(new ImportLedger(file).load(), /Cannot read import ledger/);
  const fresh = new ImportLedger(path.join(dir, 'missing.json'));
  await fresh.load();
  assert.equal(fresh.size, 0);
}));
