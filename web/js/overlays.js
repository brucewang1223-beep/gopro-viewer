/**
 * Imported map overlays: GeoJSON files (operating zones, planned routes, points of interest)
 * drawn underneath the recording's route. A panel in the map's top-right corner lists every
 * layer with hide / fit / remove controls; files can also be dropped onto the map.
 *
 * Overlays share the route's canvas renderer and are sent to the back of it: one canvas keeps
 * every feature clickable (popups) while the route always stays on top.
 */

import { parseGeoJson, describeFeatures, featureTitle } from './geojson.js';
import { el } from './util.js';

const PALETTE = ['#c48cff', '#ff6fb1', '#ffd166', '#2ee6c5', '#ff8c42'];
const MAX_POPUP_ROWS = 12;
const POINT_ZOOM = 15;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Popup body: the feature's title plus its properties as a small table. */
function popupHtml(feature) {
  const title = featureTitle(feature);
  const rows = Object.entries(feature.properties || {})
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, MAX_POPUP_ROWS)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`);
  return `<div class="overlay-popup">${title ? `<b>${escapeHtml(title)}</b>` : ''}${rows.length ? `<table>${rows.join('')}</table>` : ''}</div>`;
}

export class Overlays {
  /**
   * @param {L.Map} map Leaflet map instance
   * @param {{ renderer: L.Renderer, onMessage?: (text:string, kind:'info'|'warn'|'error')=>void }} opts
   *   renderer: the canvas renderer the route is drawn with
   */
  constructor(map, { renderer, onMessage } = {}) {
    this.map = map;
    this.renderer = renderer;
    this.onMessage = onMessage;
    this.layers = new Map(); // id → { id, name, color, layer, visible, summary }
    this.nextId = 1;
    this.panel = this.#addPanel();
    this.#enableDrop();
  }

  /** Import files chosen by the user (or dropped on the map); each file becomes one layer. */
  async addFiles(files) {
    for (const file of files) {
      try {
        const record = this.add(file.name.replace(/\.(geo)?json$/i, ''), parseGeoJson(await file.text(), file.name));
        this.onMessage?.(`${record.name}: ${record.summary}`, 'info');
      } catch (e) {
        this.onMessage?.(e.message, 'error');
      }
    }
  }

  /** Add a parsed FeatureCollection as a layer, fit the map to it and return its record. */
  add(name, collection) {
    const id = this.nextId++;
    const color = PALETTE[(id - 1) % PALETTE.length];
    const layer = L.geoJSON(collection, {
      renderer: this.renderer,
      style: () => ({ color, weight: 2.5, opacity: 0.9, fillColor: color, fillOpacity: 0.12 }),
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, { renderer: this.renderer, radius: 5, color: '#0f1115', weight: 1.5, fillColor: color, fillOpacity: 0.95 }),
      onEachFeature: (feature, l) => l.bindPopup(popupHtml(feature), { maxWidth: 320 }),
    });
    const record = { id, name, color, layer, visible: true, summary: describeFeatures(collection.features) };
    this.layers.set(id, record);
    this.#show(record);
    this.fit(id);
    this.#renderPanel();
    return record;
  }

  remove(id) {
    const record = this.layers.get(id);
    if (!record) return;
    record.layer.remove();
    this.layers.delete(id);
    this.#renderPanel();
  }

  setVisible(id, visible) {
    const record = this.layers.get(id);
    if (!record || record.visible === visible) return;
    record.visible = visible;
    if (visible) this.#show(record); else record.layer.remove();
    this.#renderPanel();
  }

  /** Add to the map underneath the route (same canvas, drawn first). */
  #show(record) {
    record.layer.addTo(this.map);
    record.layer.bringToBack();
  }

  /** Zoom to one layer (a single point gets a street-level view). */
  fit(id) {
    const record = this.layers.get(id);
    const bounds = record?.layer.getBounds();
    if (!bounds?.isValid()) return;
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) this.map.setView(bounds.getCenter(), Math.max(this.map.getZoom(), POINT_ZOOM));
    else this.map.fitBounds(bounds.pad(0.1), { padding: [10, 10] });
  }

  #addPanel() {
    const container = L.DomUtil.create('div', 'leaflet-control-overlays empty');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    const Panel = L.Control.extend({ options: { position: 'topright' }, onAdd: () => container });
    this.map.addControl(new Panel());
    return container;
  }

  #row(record) {
    return el('div', { class: `overlay-row${record.visible ? '' : ' hidden-layer'}` }, [
      el('input', { type: 'checkbox', title: 'Show / hide', onchange: (e) => this.setVisible(record.id, e.target.checked), ...(record.visible ? { checked: '' } : {}) }),
      el('span', { class: 'swatch', style: `background:${record.color}` }),
      el('span', { class: 'name', title: record.name }, [record.name, ' ', el('small', { text: record.summary })]),
      el('button', { type: 'button', title: 'Zoom to this layer', onclick: () => this.fit(record.id) }, '⤢'),
      el('button', { type: 'button', title: 'Remove this layer', onclick: () => this.remove(record.id) }, '✕'),
    ]);
  }

  #renderPanel() {
    this.panel.replaceChildren(...[...this.layers.values()].map((r) => this.#row(r)));
    this.panel.classList.toggle('empty', !this.layers.size);
  }

  /** Drop a .geojson file anywhere on the map to import it. */
  #enableDrop() {
    const target = this.map.getContainer();
    const highlight = (on) => target.classList.toggle('drop-target', on);
    target.addEventListener('dragover', (e) => { e.preventDefault(); highlight(true); });
    target.addEventListener('dragleave', () => highlight(false));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      highlight(false);
      this.addFiles([...e.dataTransfer.files]);
    });
  }
}
