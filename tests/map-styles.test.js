import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { deriveAll, STYLES_DIR, toOsm } from '../scripts/make-osm-styles.js';

test('the committed OSM styles are exactly what the K2 styles derive to', async () => {
  for (const { file, style } of await deriveAll()) {
    const committed = JSON.parse(await readFile(path.join(STYLES_DIR, file), 'utf8'));
    assert.deepEqual(committed, style, `${file} is stale — run node scripts/make-osm-styles.js`);
  }
});

test('OSM styles: OpenFreeMap vectors with the K2 zoom split, Esri imagery, OpenFreeMap fonts, every layer wired', async () => {
  const [streets, satellite] = (await deriveAll()).map((d) => d.style);
  for (const style of [streets, satellite]) {
    assert.equal(style.version, 8);
    assert.equal(style.glyphs, 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
    assert.equal(style.sources.worldmaptiles.url, 'https://tiles.openfreemap.org/planet');
    assert.equal(style.sources.worldmaptiles.maxzoom, 7);
    assert.equal(style.sources.openmaptiles.minzoom, 7);
    assert.equal(style.sources.openmaptiles.maxzoom, 14);
    for (const l of style.layers) if (l.type !== 'background') assert.ok(style.sources[l.source], `${l.id} → ${l.source}`);
    assert.ok(style.layers.every((l) => l['source-layer'] !== 'globallandcover'), 'a layer OpenFreeMap has no data for is dropped');
    assert.equal(new Set(style.layers.map((l) => l.id)).size, style.layers.length, 'ids unique');
    const fonts = new Set(style.layers.flatMap((l) => l.layout?.['text-font'] ?? []));
    assert.deepEqual([...fonts].sort(), ['Noto Sans Bold', 'Noto Sans Regular'], 'both served by OpenFreeMap');
    assert.ok(!JSON.stringify(style).includes('/api/map'), 'nothing goes through the K2 proxy');
  }
  assert.ok(streets.layers.some((l) => l.id === 'k2-target-road-shield'), 'road shields kept');
  assert.equal(streets.sources.worldSatellite, undefined);
  assert.equal(satellite.sources.uaeSatellite, undefined);
  assert.match(satellite.sources.worldSatellite.tiles[0], /arcgisonline\.com.*World_Imagery/);
  assert.equal(satellite.sources.worldSatellite.maxzoom, 19);
  assert.equal(satellite.layers.filter((l) => l.type === 'raster').length, 1);
  assert.equal(satellite.layers.filter((l) => /-label$/.test(l.id)).length, 10, 'the label overlay the chip toggles');
});

test('toOsm changes sources, glyphs and the two unsupported layers, nothing else', () => {
  const k2 = {
    version: 8,
    name: 'x',
    glyphs: '/api/map-fonts/{fontstack}/{range}.pbf',
    sources: {
      worldmaptiles: { type: 'vector', tiles: ['/a'], maxzoom: 7 },
      openmaptiles: { type: 'vector', tiles: ['/b'], minzoom: 7, maxzoom: 14 },
      worldSatellite: { type: 'raster', tiles: ['/c'], maxzoom: 12 },
      uaeSatellite: { type: 'raster', tiles: ['/d'] },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eee' } },
      { id: 'w', type: 'raster', source: 'worldSatellite' },
      { id: 'u', type: 'raster', source: 'uaeSatellite' },
      { id: 'lc', type: 'fill', source: 'openmaptiles', 'source-layer': 'globallandcover' },
      { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#fff' } },
    ],
  };
  const osm = toOsm(k2, 'derived');
  assert.deepEqual(osm.layers.map((l) => l.id), ['bg', 'w', 'road']);
  assert.deepEqual(osm.layers[2], k2.layers[4], 'a kept layer is untouched');
  assert.deepEqual(Object.keys(osm.sources), ['worldmaptiles', 'openmaptiles', 'worldSatellite']);
  assert.equal(osm.sources.worldmaptiles.tiles, undefined, 'TileJSON url replaces the tile template');
  assert.equal(osm.name, 'derived');
  assert.equal(osm.version, 8);
});
