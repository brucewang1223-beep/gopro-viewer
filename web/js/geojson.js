/**
 * GeoJSON import helpers — pure functions (no DOM, no Leaflet) so they are unit-testable:
 * parse + validate a file into a FeatureCollection and describe what it contains.
 */

const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
const KIND_OF = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'polygon', MultiPolygon: 'polygon' };
const TITLE_KEYS = ['name', 'Name', 'NAME', 'title', 'label', 'id', 'ID'];

function toFeatureCollection(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return data;
  if (data.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
  if (GEOMETRY_TYPES.has(data.type)) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: data }] };
  return null;
}

/** First coordinate pair of a geometry (depth-first), or null. */
function firstPosition(geometry) {
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) { const p = firstPosition(g); if (p) return p; }
    return null;
  }
  let c = geometry.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && c.length >= 2 ? c : null;
}

const isLonLat = ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

/**
 * Parse GeoJSON text into a FeatureCollection of features that have a geometry.
 * Accepts a FeatureCollection, a single Feature or a bare geometry; rejects projected
 * coordinates (GeoJSON must be WGS84 longitude/latitude). Throws with a readable message.
 */
export function parseGeoJson(text, name = 'file') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${name}: not valid JSON (${e.message})`, { cause: e });
  }
  const collection = toFeatureCollection(data);
  if (!collection) throw new Error(`${name}: not GeoJSON (expected a FeatureCollection, a Feature or a geometry)`);
  const features = collection.features.filter((f) => f?.geometry && GEOMETRY_TYPES.has(f.geometry.type));
  if (!features.length) throw new Error(`${name}: no features with a geometry`);
  const sample = features.map((f) => firstPosition(f.geometry)).find(Boolean);
  if (sample && !isLonLat(sample)) throw new Error(`${name}: coordinates are not longitude/latitude (projected CRS?) — GeoJSON must be WGS84`);
  return { type: 'FeatureCollection', features };
}

/** Human summary of a feature list, e.g. "2 polygons · 1 line · 3 points". */
export function describeFeatures(features) {
  const counts = { polygon: 0, line: 0, point: 0 };
  for (const f of features) {
    const kind = KIND_OF[f.geometry.type] ?? 'other';
    if (kind in counts) counts[kind]++;
  }
  const parts = Object.entries(counts).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}${n > 1 ? 's' : ''}`);
  return parts.join(' · ') || `${features.length} feature${features.length > 1 ? 's' : ''}`;
}

/** Display title of a feature from its usual property names, or null. */
export function featureTitle(feature) {
  const props = feature.properties || {};
  const key = TITLE_KEYS.find((k) => props[k] != null && props[k] !== '');
  return key ? String(props[key]) : null;
}
