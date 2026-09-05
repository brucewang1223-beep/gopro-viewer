#!/usr/bin/env node
/**
 * Derives the OpenStreetMap basemaps from the K2 styles: same layers, colours, fonts and road
 * shields, different data — OpenFreeMap vector tiles (OpenMapTiles schema, the whole world to
 * z14, no key, no quota) and Esri World Imagery for the satellite view, both fetched by the
 * browser directly.
 *
 *   node scripts/make-osm-styles.js   → web/styles/osm-streets.json, web/styles/osm-satellite.json
 *
 * The derived files are committed; tests/map-styles.test.js re-derives them and compares, so a
 * change to a K2 style or to this script shows up as a failing test until the files are regenerated.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'styles');
const OFM = 'https://tiles.openfreemap.org';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://openfreemap.org">OpenFreeMap</a>';
const IMAGERY = {
  type: 'raster',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
};
/** OpenFreeMap does not build the ESA `globallandcover` layer K2 paints at low zoom; its `landcover` covers the rest. */
const MISSING_SOURCE_LAYERS = new Set(['globallandcover']);
/** K2 stacks UAE imagery over world imagery; Esri's single source covers the world, so the UAE one goes. */
const DROPPED_SOURCES = new Set(['uaeSatellite']);

export const DERIVED = [
  ['k2-streets.json', 'osm-streets.json', 'OSM Streets (K2 Mapbox Streets Match style)'],
  ['k2-satellite.json', 'osm-satellite.json', 'OSM Satellite Hybrid (K2 style on Esri World Imagery)'],
];

/** Vector sources keep their zoom split (world ≤ z7, detail ≥ z7) so the two layer sets take over from each other as on K2. */
function vectorSource(src) {
  const zoom = { ...(src.minzoom != null ? { minzoom: src.minzoom } : {}), ...(src.maxzoom != null ? { maxzoom: src.maxzoom } : {}) };
  return { type: 'vector', url: `${OFM}/planet`, ...zoom, attribution: OSM_ATTRIBUTION };
}

/** The K2 style on OSM data: same layers minus the ones whose data OpenFreeMap does not carry. */
export function toOsm(k2, name) {
  const sources = {};
  for (const [id, src] of Object.entries(k2.sources)) {
    if (DROPPED_SOURCES.has(id)) continue;
    sources[id] = src.type === 'raster' ? IMAGERY : vectorSource(src);
  }
  const layers = k2.layers.filter((l) => !MISSING_SOURCE_LAYERS.has(l['source-layer']) && !DROPPED_SOURCES.has(l.source));
  return { ...k2, name, sources, glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`, layers };
}

export async function deriveAll() {
  const out = [];
  for (const [from, to, name] of DERIVED) {
    const k2 = JSON.parse(await readFile(path.join(STYLES_DIR, from), 'utf8'));
    out.push({ file: to, style: toOsm(k2, name) });
  }
  return out;
}

async function main() {
  for (const { file, style } of await deriveAll()) {
    await writeFile(path.join(STYLES_DIR, file), JSON.stringify(style, null, 2) + '\n', 'utf8');
    console.log(`${file}: ${style.layers.length} layers, sources ${Object.keys(style.sources).join(', ')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
