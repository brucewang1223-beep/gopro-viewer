/**
 * K2 map (MapLibre GL): the driven route with travelled / remaining or speed colouring,
 * a heading marker at the current position, click-to-seek, follow mode, and the
 * Map / Satellite switcher.
 *
 * The route is handed to the renderer once as GeoJSON. Playback then only moves the
 * cut point of a `line-gradient`, so a long drive costs a paint-property update per
 * frame instead of a geometry rebuild. Tiles, glyphs and the access token are served
 * by our own /api/map proxy — see server/map.js.
 */

import { buildRoute, fractionAlong, runGradient, ROUTE } from './map-route.js';
import { installRoadShields } from './map-shields.js';
import { ButtonsControl, BasemapControl, ICONS } from './map-controls.js';
import { clamp } from './util.js';

const BASEMAPS = {
  streets: { label: 'Map', style: '/styles/k2-streets.json', shields: true },
  satellite: { label: 'Satellite', style: '/styles/k2-satellite.json', labelLayers: /-label$/ },
};

const SOURCE = 'route';
const CASING_LAYER = 'route-casing';
const RUN_LAYER = 'route-run-';
const runLayer = (r) => RUN_LAYER + r;

const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 8, 2.2, 14, 4.5, 18, 6];
const CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 8, 4.4, 14, 7.5, 18, 9.5];
const LINE_LAYOUT = { 'line-cap': 'round', 'line-join': 'round' };

const UPDATE_INTERVAL_MS = 50;    // gradient refresh cap (20 Hz)
const PROGRESS_EPS = 1 / 2048;    // ignore sub-pixel movements of the cut point
const FOLLOW_MARGIN = 0.22;       // pan once the marker leaves the central 56 % of the view
const HOME = { center: [54.6, 24.45], zoom: 3 };

/**
 * Style URLs are root-relative so the styles stay free of hosts and tokens, but
 * vector tiles are fetched inside a blob worker where a relative URL has nothing to
 * resolve against — hence the absolute form here, on the main thread.
 */
const absolute = (url) => ({ url: url.startsWith('/') ? location.origin + url : url });

export class TrackMap {
  /**
   * @param {HTMLElement} el
   * @param {{ basemap?: string, labels?: boolean, onSeek?: (t: number) => void,
   *   onPrefs?: (prefs: { basemap: string, labels: boolean }) => void }} opts
   */
  constructor(el, { basemap = 'streets', labels = true, onSeek, onPrefs } = {}) {
    this.onSeek = onSeek;
    this.onPrefs = onPrefs;
    this.basemap = BASEMAPS[basemap] ? basemap : 'streets';
    this.labels = labels;
    this.track = null;
    this.route = null;
    this.progress = [];                    // gradient cut currently painted per run
    this.cursor = { run: 0, progress: 0 }; // where playback is
    this.position = null;                  // [lon, lat] under the marker
    this.follow = true;
    this.colorBySpeed = false;
    this.userInteracting = false;
    this.styleReady = false;
    this.lastPaint = 0;

    this.map = new maplibregl.Map({
      container: el,
      style: BASEMAPS[this.basemap].style,
      center: HOME.center,
      zoom: HOME.zoom,
      maxZoom: 19,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 120,
      attributionControl: { compact: true },
      transformRequest: absolute,
    });
    this.map.keyboard.disable();               // ← / → drive the player, not the map
    this.map.touchZoomRotate.disableRotation();
    this.#addControls();
    this.#addMarker();
    this.routeHandlers = {
      click: (e) => this.#seekTo(e.lngLat),
      enter: () => { this.map.getCanvas().style.cursor = 'pointer'; },
      leave: () => { this.map.getCanvas().style.cursor = ''; },
    };
    this.map.on('style.load', () => this.#onStyleLoad());
    this.#watchInteraction();
  }

  /* ---------- setup ---------- */

  #addControls() {
    this.map.addControl(new ButtonsControl([
      [ICONS.fit, 'Fit the whole route (F)', () => this.fitTrack()],
      [ICONS.locate, 'Centre on the current position', () => this.centerOnPosition()],
    ]), 'top-left');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-right');
    this.basemapControl = new BasemapControl({
      basemaps: BASEMAPS,
      active: this.basemap,
      labels: this.labels,
      onSelect: (key) => this.setBasemap(key),
      onLabels: (on) => this.setLabels(on),
    });
    this.map.addControl(this.basemapControl, 'bottom-left');
  }

  #addMarker() {
    const el = document.createElement('div');
    el.className = 'pos-marker stopped';
    el.innerHTML = '<div class="halo"></div><div class="arrow"></div>';
    this.markerEl = el;
    this.arrowEl = el.querySelector('.arrow');
    this.marker = new maplibregl.Marker({ element: el, anchor: 'center' });
    this.markerVisible = true;
  }

  /** Track whether the user is panning or zooming, so follow mode stays out of the way. */
  #watchInteraction() {
    const begin = (e) => { if (e.originalEvent) this.userInteracting = true; };
    const end = () => { this.userInteracting = false; };
    this.map.on('dragstart', begin);
    this.map.on('zoomstart', begin);
    this.map.on('dragend', end);
    this.map.on('zoomend', end);
  }

  /** Runs after every style load, including a basemap switch, which wipes our layers. */
  #onStyleLoad() {
    this.styleReady = true;
    if (BASEMAPS[this.basemap].shields) installRoadShields(this.map);
    this.#applyLabels();
    this.#addRouteLayers();
    this.#paintProgress(true);
  }

  /**
   * Hit-testing for the route layer. Bound only while that layer exists — MapLibre
   * reports an error for every pointer move over a delegated layer that is missing.
   */
  #routeEvents(on) {
    if (on === !!this.routeEventsBound) return;
    this.routeEventsBound = on;
    const bind = on ? 'on' : 'off';
    this.map[bind]('click', CASING_LAYER, this.routeHandlers.click);
    this.map[bind]('mouseenter', CASING_LAYER, this.routeHandlers.enter);
    this.map[bind]('mouseleave', CASING_LAYER, this.routeHandlers.leave);
    if (!on) this.map.getCanvas().style.cursor = '';
  }

  /* ---------- route layers ---------- */

  #addRouteLayers() {
    if (!this.route || !this.styleReady || this.map.getSource(SOURCE)) return;
    this.map.addSource(SOURCE, { type: 'geojson', data: this.route.geojson, lineMetrics: true });
    this.map.addLayer({ id: CASING_LAYER, type: 'line', source: SOURCE, layout: LINE_LAYOUT, paint: { 'line-color': ROUTE.casing, 'line-width': CASING_WIDTH } });
    this.route.runs.forEach((run, r) => {
      this.progress[r] = this.#cutFor(r);
      this.map.addLayer({
        id: runLayer(r),
        type: 'line',
        source: SOURCE,
        filter: ['==', ['get', 'run'], r],
        layout: LINE_LAYOUT,
        paint: { 'line-width': LINE_WIDTH, 'line-gradient': this.#gradient(run, this.progress[r]) },
      });
    });
    this.#routeEvents(true);
  }

  #removeRouteLayers() {
    if (!this.styleReady) return;
    this.#routeEvents(false);
    for (const id of this.map.getStyle().layers.map((l) => l.id)) {
      if (id === CASING_LAYER || id.startsWith(RUN_LAYER)) this.map.removeLayer(id);
    }
    if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
  }

  /** Where the driven/undriven cut sits on run `r`: runs behind the cursor are whole. */
  #cutFor(r) {
    const { run, progress } = this.cursor;
    return r < run ? 1 : r > run ? 0 : progress;
  }

  #gradient(run, cut) {
    return runGradient(run, { colorBySpeed: this.colorBySpeed, progress: cut });
  }

  /**
   * Move each run's gradient cut to where playback is. Throttled to 20 Hz, and runs
   * whose cut has not moved are skipped, so a normal frame touches a single layer.
   */
  #paintProgress(force = false) {
    if (!this.route || !this.styleReady) return;
    const now = performance.now();
    if (!force && now - this.lastPaint < UPDATE_INTERVAL_MS) return;
    this.lastPaint = now;
    this.route.runs.forEach((run, r) => {
      const cut = this.#cutFor(r);
      if (!force && Math.abs(cut - this.progress[r]) < PROGRESS_EPS) return;
      this.progress[r] = cut;
      this.map.setPaintProperty(runLayer(r), 'line-gradient', this.#gradient(run, cut));
    });
  }

  /* ---------- public API ---------- */

  setTrack(track) {
    this.track = track;
    this.route = track?.hasGps ? buildRoute(track) : null;
    this.progress = this.route ? new Array(this.route.runs.length).fill(-1) : [];
    this.cursor = { run: 0, progress: 0 };
    this.marker.remove();
    this.#removeRouteLayers();
    if (!this.route?.runs.length) return;
    this.#addRouteLayers();     // a no-op until the first style has loaded; #onStyleLoad retries
    this.position = this.route.runs[0].coordinates[0];
    this.marker.setLngLat(this.position).addTo(this.map);
    this.map.resize();
    this.fitTrack({ animate: false });
  }

  /** Update marker and progress from a Track.sampleAt() sample. */
  update(sample) {
    if (!this.route || !sample) return;
    const at = sample.valid && sample.lat != null ? [sample.lon, sample.lat] : null;
    this.#showMarker(!!at);
    if (at) { this.position = at; this.#moveMarker(sample, at); }
    this.#trackProgress(sample.i, at);
    if (at) this.#keepInView(at);
  }

  /**
   * Move the travelled / remaining cut to where playback is. While the receiver had no
   * fix the cut holds at the last drawn point before it, so an unpositioned stretch is
   * never painted as driven — and seeking back in front of the first fix undoes it all.
   */
  #trackProgress(i, at) {
    const drawn = this.route.prevDrawn[clamp(i, 0, this.route.prevDrawn.length - 1)];
    if (drawn < 0) {
      this.cursor = { run: 0, progress: 0 };
    } else {
      const run = this.route.runOf[drawn]; const pos = this.route.posOf[drawn];
      const point = at ?? this.route.runs[run].coordinates[pos];
      this.cursor = { run, progress: fractionAlong(this.route.runs[run], pos, point) };
    }
    this.#paintProgress();
  }

  setFollow(on) { this.follow = on; }

  setColorBySpeed(on) {
    this.colorBySpeed = on;
    this.progress.fill(-1);
    this.#paintProgress(true);
  }

  /** `user: false` applies a default from config.json without recording a preference. */
  setBasemap(key, { user = true } = {}) {
    if (!BASEMAPS[key] || key === this.basemap) return;
    this.basemap = key;
    this.styleReady = false;
    this.#routeEvents(false);              // setStyle drops the layer these are bound to
    this.map.setStyle(BASEMAPS[key].style);
    this.basemapControl.setState({ active: key });
    if (user) this.#prefsChanged();
  }

  toggleBasemap() {
    const keys = Object.keys(BASEMAPS);
    this.setBasemap(keys[(keys.indexOf(this.basemap) + 1) % keys.length]);
  }

  setLabels(on, { user = true } = {}) {
    this.labels = on;
    this.basemapControl.setState({ labels: on });
    this.#applyLabels();
    if (user) this.#prefsChanged();
  }

  fitTrack({ animate = true } = {}) {
    if (!this.route?.bounds) return;
    this.userInteracting = false;
    this.map.fitBounds(this.route.bounds, { padding: 30, animate, duration: 500 });
  }

  centerOnPosition() {
    if (!this.position) return;
    this.userInteracting = false;
    this.map.easeTo({ center: this.position, zoom: Math.max(this.map.getZoom(), 15), duration: 400 });
  }

  invalidate() { this.map.resize(); }

  /* ---------- internals ---------- */

  /** Imagery basemaps carry their labels in one style; the chip hides them. */
  #applyLabels() {
    const pattern = BASEMAPS[this.basemap].labelLayers;
    if (!pattern || !this.styleReady) return;
    const visibility = this.labels ? 'visible' : 'none';
    for (const { id } of this.map.getStyle().layers) {
      if (pattern.test(id)) this.map.setLayoutProperty(id, 'visibility', visibility);
    }
  }

  #prefsChanged() { this.onPrefs?.({ basemap: this.basemap, labels: this.labels }); }

  #seekTo(lngLat) {
    if (!this.track || !this.onSeek) return;
    const i = this.track.nearestToLatLng(lngLat.lat, lngLat.lng);
    if (i >= 0) this.onSeek(this.track.gps.t[i]);
  }

  /** Hidden wherever the receiver had no fix, so the marker never sits on a guessed position. */
  #showMarker(on) {
    if (on === this.markerVisible) return;
    this.markerVisible = on;
    this.markerEl.style.visibility = on ? '' : 'hidden';
  }

  #moveMarker(sample, at) {
    this.marker.setLngLat(at);
    if (sample.heading == null) { this.markerEl.classList.add('stopped'); return; }
    this.arrowEl.style.transform = `rotate(${sample.heading}deg)`;
    this.markerEl.classList.remove('stopped');
  }

  /** Pan once the marker drifts towards the edge of the view (follow mode only). */
  #keepInView(at) {
    if (!this.follow || this.userInteracting) return;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const p = this.map.project(at);
    const mx = w * FOLLOW_MARGIN;
    const my = h * FOLLOW_MARGIN;
    if (p.x < mx || p.x > w - mx || p.y < my || p.y > h - my) this.map.panTo(at, { duration: 400 });
  }
}
