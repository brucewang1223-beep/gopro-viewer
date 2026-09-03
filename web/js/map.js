/**
 * Leaflet map: route with travelled / remaining colouring (or speed colouring), a
 * prominent current-position marker with heading, click-to-seek, follow mode,
 * and "fit whole route" / "centre on position" buttons. Basemap comes from config.tiles.
 *
 * Geometry is built once per track: valid GPS points grouped into runs (split on
 * time gaps). Per playback tick only the travelled polyline (progress mode) or the
 * dimming overlay (speed mode) is rebuilt from pre-made LatLng arrays, at ≤ 20 Hz.
 */

import { speedColor, percentile } from './util.js';

const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_CREDIT = '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const TILES = {
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_CREDIT, maxZoom: 19 },
  cartoDark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attribution: CARTO_CREDIT, maxZoom: 20 },
  cartoLight: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attribution: CARTO_CREDIT, maxZoom: 20 },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics', maxZoom: 19,
  },
};

const STYLE = {
  remaining: { color: '#8b93a7', weight: 4, opacity: 0.55 },
  travelled: { color: '#4cc2ff', weight: 4, opacity: 0.95 },
  speedRun: { weight: 4, opacity: 0.9 },
  futureDim: { color: '#0f1115', weight: 6, opacity: 0.55 },
};

const SVG_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const ICONS = {
  fit: `${SVG_OPEN}<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/><path d="M8 12h8" opacity=".5"/></svg>`,
  locate: `${SVG_OPEN}<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>`,
};

const UPDATE_INTERVAL_MS = 50; // progress geometry refresh cap (20 Hz)
const SPEED_BUCKETS = 8;
const FOLLOW_MARGIN = 0.22; // pan when the marker leaves the central 56 % of the view
const MARKER_ICON = { className: 'pos-marker stopped', html: '<div class="halo"></div><div class="arrow"></div>', iconSize: [30, 30], iconAnchor: [15, 15] };

/* ---------- geometry ---------- */

/** Pre-built LatLng arrays per run plus index maps (GPS index → run / position / last valid index). */
function buildGeometry(track) {
  const g = track.gps;
  const runs = track.runs();
  const runLatLngs = [];
  const runOf = new Int32Array(g.n).fill(-1);
  const posOf = new Int32Array(g.n).fill(-1);
  const prevValid = new Int32Array(g.n).fill(-1);
  for (let i = 0, last = -1; i < g.n; i++) { if (track.valid[i]) last = i; prevValid[i] = last; }
  runs.forEach((run, r) => {
    const pts = [];
    for (let i = run.start; i <= run.end; i++) {
      if (!track.valid[i]) continue;
      runOf[i] = r; posOf[i] = pts.length;
      pts.push(L.latLng(g.lat[i], g.lon[i]));
    }
    runLatLngs.push(pts);
  });
  return { runs, runLatLngs, runOf, posOf, prevValid, bucketOf: speedBuckets(g) };
}

/** Speed bucket per point for speed colouring (0 … SPEED_BUCKETS-1, scaled to the 97th percentile). */
function speedBuckets(g) {
  const vmax = Math.max(1, percentile(g.speed2d, 0.97));
  const bucketOf = new Int8Array(g.n);
  for (let i = 0; i < g.n; i++) bucketOf[i] = Math.min(SPEED_BUCKETS - 1, Math.floor(((g.speed2d[i] ?? 0) / vmax) * SPEED_BUCKETS));
  return bucketOf;
}

/** Split one run into consecutive segments of equal speed bucket (segments share their end points). */
function speedSegments(track, geom, r) {
  const { runs, runLatLngs, bucketOf } = geom;
  const pts = runLatLngs[r];
  const segments = [];
  let seg = []; let bucket = -1; let k = 0;
  for (let i = runs[r].start; i <= runs[r].end; i++) {
    if (!track.valid[i]) continue;
    if (bucket !== -1 && bucketOf[i] !== bucket) {
      seg.push(pts[k]);
      segments.push({ pts: seg, bucket });
      seg = [];
    }
    seg.push(pts[k]); bucket = bucketOf[i]; k++;
  }
  segments.push({ pts: seg, bucket });
  return segments.filter((s) => s.pts.length > 1);
}

/* ---------- component ---------- */

export class TrackMap {
  /**
   * @param {HTMLElement} el
   * @param {{ tiles?: string, onSeek?: (t:number)=>void }} opts
   */
  constructor(el, { tiles = 'osm', onSeek } = {}) {
    this.onSeek = onSeek;
    this.map = L.map(el, { preferCanvas: true, zoomControl: true, attributionControl: true, worldCopyJump: true });
    this.renderer = L.canvas({ padding: 0.5 });
    this.tileLayer = null;
    this.setBasemap(tiles);
    L.control.scale({ imperial: false }).addTo(this.map);
    this.#addButtons();
    this.map.setView([24.45, 54.6], 3);

    this.baseGroup = L.featureGroup().addTo(this.map);   // static route (bounds source)
    this.overlay = null;                                  // travelled polyline / future dim overlay
    this.marker = null;
    this.track = null;
    this.geom = null;
    this.follow = true;
    this.colorBySpeed = false;
    this.userInteracting = false;
    this.lastIdx = -1;
    this.lastUpdate = 0;

    this.map.on('dragstart zoomstart', () => { this.userInteracting = true; });
    this.map.on('dragend zoomend', () => { this.userInteracting = false; });
    this.baseGroup.on('click', (e) => this.#seekTo(e.latlng));
  }

  #addButtons() {
    const buttons = [[ICONS.fit, 'Fit the whole route (F)', () => this.fitTrack()], [ICONS.locate, 'Centre on the current position', () => this.centerOnPosition()]];
    const Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control-route');
        for (const [icon, title, handler] of buttons) {
          const a = L.DomUtil.create('a', '', div);
          a.href = '#'; a.title = title; a.setAttribute('role', 'button'); a.innerHTML = icon;
          L.DomEvent.on(a, 'click', (e) => { L.DomEvent.stop(e); handler(); });
          L.DomEvent.disableClickPropagation(a);
        }
        return div;
      },
    });
    this.map.addControl(new Control());
  }

  /** The underlying Leaflet map and the route's canvas renderer, for modules that add their own layers (overlays). */
  get leaflet() { return this.map; }
  get pathRenderer() { return this.renderer; }

  invalidate() { this.map.invalidateSize(); }

  /** Swap the basemap (config.json "tiles": osm | cartoLight | cartoDark | satellite). */
  setBasemap(key) {
    const t = TILES[key] ?? TILES.osm;
    if (this.tileLayer) this.tileLayer.remove();
    this.tileLayer = L.tileLayer(t.url, { attribution: t.attribution, maxZoom: t.maxZoom, subdomains: 'abcd' }).addTo(this.map);
  }

  #seekTo(latlng) {
    if (!this.track || !this.onSeek) return;
    const i = this.track.nearestToLatLng(latlng.lat, latlng.lng);
    if (i >= 0) this.onSeek(this.track.gps.t[i]);
  }

  #pathOptions(extra) {
    return { ...extra, renderer: this.renderer, lineCap: 'round', lineJoin: 'round' };
  }

  #clearLayers() {
    this.baseGroup.clearLayers();
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (this.marker) { this.marker.remove(); this.marker = null; }
  }

  setTrack(track) {
    this.track = track;
    this.geom = null;
    this.lastIdx = -1;
    this.#clearLayers();
    if (!track || !track.hasGps) return;
    this.geom = buildGeometry(track);
    this.#drawBase();
    this.overlay = L.polyline([], this.#pathOptions({ ...(this.colorBySpeed ? STYLE.futureDim : STYLE.travelled), interactive: false })).addTo(this.map);
    const first = this.geom.runLatLngs.find((r) => r.length)?.[0] ?? null;
    this.marker = L.marker(first ?? [track.gps.lat[0], track.gps.lon[0]], { icon: L.divIcon(MARKER_ICON), interactive: false, zIndexOffset: 1000 }).addTo(this.map);
    this.#updateProgress(0, first, true);
    this.map.invalidateSize();
    this.fitTrack({ animate: false });
  }

  /** Static route: remaining colour (progress mode) or speed-coloured runs (speed mode). */
  #drawBase() {
    this.baseGroup.clearLayers();
    const { runs, runLatLngs } = this.geom;
    if (!this.colorBySpeed) {
      const multi = runLatLngs.filter((r) => r.length > 1);
      if (multi.length) L.polyline(multi, this.#pathOptions({ ...STYLE.remaining, interactive: true })).addTo(this.baseGroup);
      return;
    }
    runs.forEach((run, r) => {
      for (const { pts, bucket } of speedSegments(this.track, this.geom, r)) {
        L.polyline(pts, this.#pathOptions({ ...STYLE.speedRun, color: speedColor((bucket + 0.5) / SPEED_BUCKETS), interactive: true })).addTo(this.baseGroup);
      }
    });
  }

  /**
   * Rebuild the dynamic overlay for GPS index i (marker at `ll`, interpolated):
   * progress mode → travelled part; speed mode → dimmed remaining part.
   */
  #updateProgress(i, ll, force = false) {
    if (!this.geom || !this.overlay) return;
    const now = performance.now();
    if (!force && (i === this.lastIdx || now - this.lastUpdate < UPDATE_INTERVAL_MS)) return;
    this.lastIdx = i; this.lastUpdate = now;
    const { runLatLngs, runOf, posOf, prevValid } = this.geom;
    const iv = prevValid[Math.max(0, Math.min(i, prevValid.length - 1))];
    if (iv < 0) { this.overlay.setLatLngs([]); return; }
    const r = runOf[iv]; const p = posOf[iv];
    let lines;
    if (this.colorBySpeed) {
      const cur = runLatLngs[r].slice(p);
      if (ll) cur.unshift(ll);
      lines = [cur, ...runLatLngs.slice(r + 1)].filter((x) => x.length > 1);
    } else {
      lines = runLatLngs.slice(0, r).filter((x) => x.length > 1);
      const cur = runLatLngs[r].slice(0, p + 1);
      if (ll) cur.push(ll);
      if (cur.length > 1) lines.push(cur);
    }
    this.overlay.setLatLngs(lines);
  }

  setColorBySpeed(on) {
    this.colorBySpeed = on;
    if (!this.geom) return;
    this.#drawBase();
    this.overlay.setStyle(on ? STYLE.futureDim : STYLE.travelled);
    this.#updateProgress(Math.max(0, this.lastIdx), this.marker ? this.marker.getLatLng() : null, true);
  }

  setFollow(on) { this.follow = on; }

  /** Zoom so the whole route is centred on the map. */
  fitTrack({ animate = true } = {}) {
    const b = this.baseGroup.getBounds();
    if (!b.isValid()) return;
    this.userInteracting = false;
    this.map.fitBounds(b.pad(0.08), { animate, padding: [10, 10] });
  }

  centerOnPosition() {
    if (!this.marker) return;
    this.userInteracting = false;
    this.map.setView(this.marker.getLatLng(), Math.max(this.map.getZoom(), 15), { animate: true });
  }

  #moveMarker(sample, ll) {
    this.marker.setLatLng(ll);
    const iconEl = this.marker.getElement();
    if (!iconEl) return;
    if (sample.heading == null) { iconEl.classList.add('stopped'); return; }
    iconEl.querySelector('.arrow').style.transform = `rotate(${sample.heading}deg)`;
    iconEl.classList.remove('stopped');
  }

  /** Pan when the marker drifts towards the edge of the view (follow mode, user not interacting). */
  #keepInView(ll) {
    if (!this.follow || this.userInteracting) return;
    const p = this.map.latLngToContainerPoint(ll);
    const size = this.map.getSize();
    const mx = size.x * FOLLOW_MARGIN; const my = size.y * FOLLOW_MARGIN;
    if (p.x < mx || p.x > size.x - mx || p.y < my || p.y > size.y - my) this.map.panTo(ll, { animate: true, duration: 0.4 });
  }

  /** Update marker + progress to a GPS sample (from Track.sampleAt). */
  update(sample) {
    if (!this.marker || !sample || !sample.valid || sample.lat == null) return;
    const ll = L.latLng(sample.lat, sample.lon);
    this.#moveMarker(sample, ll);
    this.#updateProgress(sample.i, ll);
    this.#keepInView(ll);
  }
}
