import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseGeoJson, describeFeatures, featureTitle } from '../web/js/geojson.js';
import { FIXTURES } from './helpers.js';

test('parseGeoJson accepts collections, features and bare geometries and drops geometry-less features', async () => {
  const text = await readFile(path.join(FIXTURES, 'overlay.geojson'), 'utf8');
  const fc = parseGeoJson(text, 'overlay.geojson');
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 3, 'the feature without geometry is dropped');
  assert.equal(describeFeatures(fc.features), '1 polygon · 1 line · 1 point');
  assert.deepEqual(fc.features.map(featureTitle), ['Depot zone', 'Planned route', 'Gate A']);

  const single = parseGeoJson(JSON.stringify({ type: 'Feature', properties: { title: 'T' }, geometry: { type: 'Point', coordinates: [54.6, 24.45] } }));
  assert.equal(single.features.length, 1);
  assert.equal(featureTitle(single.features[0]), 'T');
  const bare = parseGeoJson(JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }));
  assert.equal(describeFeatures(bare.features), '1 polygon');
  assert.equal(featureTitle(bare.features[0]), null);
});

test('parseGeoJson rejects non-JSON, non-GeoJSON, empty and projected input with readable messages', () => {
  assert.throws(() => parseGeoJson('{not json', 'a.geojson'), /a\.geojson: not valid JSON/);
  assert.throws(() => parseGeoJson('{"hello":"world"}', 'b.json'), /b\.json: not GeoJSON/);
  assert.throws(() => parseGeoJson('{"type":"FeatureCollection","features":[]}', 'c.geojson'), /no features with a geometry/);
  const projected = { type: 'Feature', geometry: { type: 'Point', coordinates: [500000, 3660000] } };
  assert.throws(() => parseGeoJson(JSON.stringify(projected), 'utm.geojson'), /not longitude\/latitude/);
});
