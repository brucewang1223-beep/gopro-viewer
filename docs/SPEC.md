# GoPro Viewer — Specification (v0.1)

Status: implemented (v0.1.0). This document is the single source of truth for scope,
architecture, data contracts and acceptance criteria. Change the spec first, then the code.

## 1. Purpose

A local web application that plays GoPro recordings and replays the telemetry embedded
in the same MP4 files (GPMF track: GPS position/speed/altitude, accelerometer, gyroscope)
in sync with the video: map position, live HUD values and time-series charts follow the
playhead; clicking the map, charts or timeline seeks the video.

Primary use: reviewing drive / road-test footage where "what happened, where, at what
speed" matters. Secondary use: exporting the telemetry (GPX / CSV) for offline analysis
(pandas, geopandas, QGIS).

## 2. Scope

### In scope (v0.1)

| Area | Requirement |
| --- | --- |
| Library | Scan one or more media roots recursively; group GoPro chapter files into recordings; show date, duration, resolution, fps, size, chapters, LRV proxy availability, THM thumbnail. Badges come from a scan-time probe of the GPMF payloads: `GPS` only when the receiver actually had a 2D/3D fix somewhere in the file (≈ 50 payloads sampled evenly, `server/gpmf-probe.js`), `NO FIX` when a GPS stream exists without a lock, `IMU` when accelerometer/gyro data exist; the badge is corrected after the full parse if the sample missed. |
| Playback | Play MP4/MOV directly in the browser (HTTP Range streaming, no transcoding). Chapters play as one continuous timeline with automatic chapter advance. Playback rate 0.25×–4×. Frame stepping. Optional LRV proxy playback. |
| Telemetry | Extract the `gpmd` track without reading the media payload; decode with `gopro-telemetry`; normalise into columnar arrays on a global time base; cache per chapter on disk. GPS5 (HERO5–10) and GPS9 (HERO11+) supported, GPS9 preferred. |
| Sync | Map marker (with heading), HUD (speed, altitude, lat/lon, fix quality/DOP, UTC + local clock, |a|), chart playheads and timeline follow the video within one frame; seeking from map / charts / timeline / keyboard. |
| Map | Leaflet with an OpenStreetMap basemap (alternatives selectable via `config.json` `tiles`: osm, cartoLight, cartoDark, satellite; no on-map layer switcher). On selection the whole route is fitted and centred. Route drawn in two colours — travelled (accent) vs remaining (grey) — updated as playback advances; optional speed colouring (remaining part dimmed). Prominent pulsing position marker with heading. Map stays freely zoomable; "fit whole route" and "centre on position" buttons under the zoom control (also key `F`); follow mode; invalid-fix samples excluded. |
| Charts | Speed (km/h), altitude (m), G-force (longitudinal / lateral / vertical g), gyro rates (yaw / pitch / roll °/s); the chart set adapts to the data available; shared cursor and zoom; chapter boundaries marked. |
| Gauges | Instrument cluster centred at the top of the video: G-force ball (friction circle, 0.5 g / 1 g rings, trail), gyro ball (yaw ↔, pitch ↕, roll-rate arc at the rim) and attitude bubble level (pitch / roll from the measured gravity direction). Toggle with `G`. |
| Audio | Always muted by design (`<video muted>` and enforced in code); no volume UI. Muted playback also avoids browser autoplay restrictions. |
| Timeline alignment | The timeline bar's drawn extent is inset to the charts' plot area (measured after uPlot's ready/setSize hooks, so it tracks resizes), so its playhead and the chart playheads share the same x position. |
| Skip step | ← / → and the −/+ buttons skip a user-selectable number of seconds (1–60, persisted in `localStorage`); Shift multiplies by 6. |
| Layout stability | Every live readout (HUD cells, gauge captions, time display, chart hover readouts) is written at a constant character width in a monospace font with tabular numerals and `white-space: pre`, so nothing reflows or jitters during playback. |
| Stats | Distance, max/avg speed, moving time, elevation gain/loss, fix-quality histogram, camera model/firmware, UTC start. |
| Import (overlays) | GeoJSON files (FeatureCollection / Feature / geometry, WGS84) drawn on the map beneath the route in a distinct colour per file: polygons filled, lines, points as circle markers; feature properties in a popup. Layer panel (top-right of the map) with hide / zoom-to / remove; drag-and-drop onto the map; layers persist across recordings. Client-side only (`web/js/geojson.js` pure parsing, `web/js/overlays.js` Leaflet layer + panel). |
| Export | GPX 1.1 (fixed points only, with ele/time/speed) and CSV (GPS, accelerometer, gyroscope). CLI `scripts/dump-telemetry.js` for headless extraction. |
| Config | Media roots via UI (persisted to `config.json`), CLI flags, environment variables. Server binds 127.0.0.1 by default. |
| Desktop use | `web/manifest.webmanifest` + icons make the page installable as a Chrome app (own window, Dock icon); `scripts/macos-launch-agent.sh` (`npm run autostart`) starts the server at login via launchd. |

### Out of scope (v0.1)

GoPro MAX `.360` files (listed as unsupported), transcoding, multi-camera sync, video
editing/trimming, cloud upload, mobile layout, authentication (local single-user tool),
highlight tags (HLMT), sensor streams other than GPS/ACCL/GYRO (available in
`gopro-telemetry`; add on demand).

## 3. Architecture

```
┌──────────────────────── browser (web/) ────────────────────────┐
│ app.js (wiring, keys)  library.js  player.js  map.js (Leaflet) │
│ charts.js (uPlot)  timeline.js  track.js (time lookups)        │
│ motion.js (driver frame)  gauges.js  hud.js  stats.js  util.js │
│ overlays.js + geojson.js (imported GeoJSON layers)              │
└───────────────▲───────────────────────────▲─────────────────────┘
                │ JSON (fetch)              │ video bytes (Range)
┌───────────────┴───────────── server/ (Node ≥ 20, Express) ─────┐
│ app.js (routes)   library.js (scan, chapter grouping, id map)   │
│ mp4.js (moov-only demuxer)  gpmf-klv.js (settings, ORIN/ORIO)   │
│ gpmf-probe.js (fix probe)  decode.js (gopro-telemetry wrapper)  │
│ telemetry.js (pipeline, cache)  export.js (GPX/CSV)  config.js  │
│ json-cache.js  ids.js  log.js  index.js (entry)                 │
└──────────────┬──────────────────────────────┬──────────────────┘
               │ fs reads (moov + gpmd samples)│ .cache/ (info + telemetry JSON)
        GoPro .MP4 / .LRV / .THM files on disk
```

Key decisions and their rationale:

| Decision | Rationale |
| --- | --- |
| Local Node server + plain browser UI, no bundler | Zero build step, project-local dependencies only, trivial to run (`npm start`). Vendor libraries are served straight from `node_modules`. |
| Own MP4 demuxer (`server/mp4.js`) instead of `gpmf-extract` | `gpmf-extract` needs the whole file in memory (a 4 GB chapter is impossible). The demuxer reads only the `moov` box and the `gpmd` sample byte ranges: a 4 GB chapter costs ~10 small reads plus ~2 MB of telemetry. Output is byte-identical to `gpmf-extract` on all 10 GoPro reference samples (verified during development). |
| `gopro-telemetry` for KLV decoding | Battle-tested handling of scaling, GPS5/GPS9 quirks, timing interpolation, MSL altitude correction (`egm96-universal`). |
| Chapter merge done by the viewer, not by `gopro-telemetry` multi-input | Per-chapter results are cacheable independently; offsets use exact video durations rather than one-second-resolution creation times. |
| Columnar JSON (`t[]`, `lat[]`, …) | Compact, directly chart-friendly, trivial to load into pandas. |
| IMU downsampled to 25 Hz (mean + max magnitude per bin) for the UI | Raw 200 Hz IMU for a 30-min clip is ~1M rows; 25 Hz keeps payloads a few MB while `magMax` preserves impact peaks. Full rate remains available through `gopro-telemetry` if a future export needs it. |
| Time base = video time (MP4 sample timing), wall clock = GPS time | Sync must follow the video clock; GPS UTC is attached via `utcOffsetMs` anchored on the first sample with a real fix. |
| Opaque file/recording ids (SHA-1 of path) | The HTTP layer never receives paths; only files discovered by the scanner are served. |
| IMU expressed in the GoPro camera frame on the server (`server/gpmf-klv.js`) | Raw sample order differs per model (HERO5 Z,X,Y; HERO6 Y,−X,Z; HERO7+ ORIN/ORIO; HERO11+ ORIN only). The server maps every file to X = camera left, Y = camera back, Z = up (right-handed), so the client needs no per-model knowledge. |
| Driver-frame motion derived on the client from measured gravity (`web/js/motion.js`) | Up = 12-s moving average of the accelerometer; forward = optical axis projected on the horizontal plane; right = forward × up. Works for tilted or upside-down mounts without configuration. Verified on HERO13 dashcam footage: braking for a barrier shows −0.5 g longitudinal, a right turn shows −23 °/s yaw and +0.13 g lateral; corr(yaw, lateral g) = −0.64 as physics requires. |
| Code conventions enforced by `npm run lint` (ESLint) | No unused code (variables, private members, exports are checked by hand), no function above 50 lines or cyclomatic complexity 15, nesting ≤ 4, ≤ 5 parameters. Modules are small and single-purpose (`decode.js`, `json-cache.js`, `ids.js` on the server; `hud.js`, `stats.js` in the browser). Refactors are verified against golden outputs: every server function on all 13 reference clips plus a 40-step headless-browser DOM/canvas snapshot must stay identical. |

## 4. Data model

### 4.1 Library (`GET /api/library`)

```
{ scannedAt, roots: [{id, path}],
  recordings: [{
    id, name,              // e.g. "GX0001" (prefix of first chapter + recording number)
    dir, rootId, startTime, // startTime: MP4 creation time (camera local time, ISO)
    durationSec, codec, width, height, fps, sizeBytes, firmware,
    hasGpmd, hasGps, hasImu, hasProxy, thumbId,   // hasGps/hasImu: probed from the first GPMF payloads at scan time
    chapters: [{ id, file, chapter, index, offsetSec, durationSec, sizeBytes,
                 creationTime, video: {codec,width,height,fps,…}, hasGpmd, hasGps, hasImu, proxyId, thumbId }],
    warnings: [] }] }
```

Chapter grouping rules (`server/library.js`): `GX/GHccnnnn.MP4` → recording `nnnn`, chapter `cc`;
`GLccnnnn.LRV` → proxy of the same chapter; `*.THM` → thumbnail; `GOPRnnnn.MP4` + `GPccnnnn.MP4`
(HERO5 and older) → chapter `00` + `cc`; any other `.mp4/.mov` → single-chapter recording.
`offsetSec` of chapter *k* = Σ duration of chapters < *k* (video track duration).

### 4.2 Telemetry (`GET /api/recordings/:id/telemetry`)

```
{ schema: "gopro-viewer.telemetry/1", recordingId, name,
  camera: { model, firmware, lens },
  video: { codec, width, height, fps, durationSec },
  startTimeCamera, utcOffsetMs,                 // utc(t) = utcOffsetMs + t*1000
  chapters: [{ id, file, index, offsetSec, durationSec, gpsPoints, gpsSource, warnings }],
  gps:  { source: "GPS5"|"GPS9", hz, n, altitudeSystem,
          t[], lat[], lon[], alt[], speed2d[], speed3d[], fix[], dop[], utc[] },
  accl: { hz, n, frame: "camera", orientation: {orin, orio, order, source},
          t[], x[], y[], z[], mag[], magMax[] },                            // m/s², x left, y back, z up
  gyro: { … same shape … },                                                  // rad/s, same frame
  stats: { validPoints, totalPoints, distanceM, movingTimeSec, maxSpeedMs, avgSpeedMs,
           elevGainM, elevLossM, minAltM, maxAltM, fixCounts: {none, fix2d, fix3d} },
  warnings: [] }
```

Units: `t` seconds from the first frame of chapter 1; speeds m/s; altitude metres (MSL where
the camera or the EGM96 correction provides it); `fix` 0/2/3; `dop` dilution of precision
(GPS5 `GPSP/100`, GPS9 native); `utc` epoch ms from GPS time.

Validity rule (client, `web/js/track.js`): a GPS sample positions the marker / draws the track
only if `fix ≥ 2` (or fix unknown), coordinates are finite, non-zero and within range.
Statistics apply the same rule; charts and CSV keep every sample.

### 4.2b Camera settings (`recording.settings`, `telemetry.settings`)

GoPro writes the record-time settings into a GPMF block in the MP4 `udta` (`server/gpmf-klv.js` →
`parseHeaderSettings`). The viewer exposes a normalised summary: `stabilization {enabled, mode}`
(EISE / EISA — HyperSmooth off, "HS EIS", "HS High", "HS Boost", "HS AutoBoost", "HS HLevel"),
`horizonControl` (HCTL), `fov` (VFOV / ZFOV: Linear, Wide, SuperView, HyperView + diagonal degrees),
`resolution`, `fps`, `hdr`, `protune`, `color`, `sharpness`, `whiteBalance`, `exposure`, `isoMin/Max`,
`ev`, `bitrate`, `denoise`, `motionBlur`, `audio`, `digitalZoom`, `lensMod`, `mediaMod`, `hindsight`,
`orientation`, `control`, `powerProfile`, `tzMinutes` (TZON), `createdLocalEpoch` (CDAT). HERO6/7
nest the keys in a STRM, HERO8+ store them flat — both are handled. HERO5 has no such block and Fusion
only writes lens calibrations there: in both cases `settings` is `null`.
`tzMinutes` + the camera creation time give a UTC start (`utcSource: "camera-clock"`) for recordings
without GPS, so the HUD clock works on IMU-only footage.

### 4.3 Cache (`.cache/`)

`info/<fileId>.json` — per-file MP4 metadata (validated by size + mtime).
`telemetry/<key>.json` — per-chapter normalised telemetry; key includes path, size, creation
time, `CACHE_VERSION` and the IMU rate. Deleting `.cache/` is always safe.

## 5. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness, node version, last scan time |
| `GET /api/config` | host/port/cache/roots |
| `GET /api/library` | recordings (scans on first call) |
| `POST /api/rescan` | rescan all roots |
| `POST /api/roots {path}` / `DELETE /api/roots/:id` | manage media roots (persisted to `config.json`) |
| `GET /api/media/:fileId` | video bytes, `Accept-Ranges: bytes`, 206 partial content |
| `GET /api/thumb/:fileId` | THM/JPEG thumbnail |
| `GET /api/recordings/:id/telemetry` | merged telemetry JSON |
| `GET /api/recordings/:id/export.gpx` | GPX download |
| `GET /api/recordings/:id/export.csv?stream=gps\|accl\|gyro` | CSV download |
| `GET /`, `/vendor/leaflet/*`, `/vendor/uplot/*` | UI and vendored libraries |

Errors are JSON `{ error }` with 400 (bad input), 404 (unknown id / route), 500 (unexpected).

### 4.4 Motion model (client, `web/js/motion.js`)

Per 25 Hz IMU bin: gravity `g⃗` = centred 12-s moving average of `accl`; `up = ĝ`;
`forward` = camera optical axis (−Y) projected on the plane ⊥ up; `right = forward × up`.
Dynamic acceleration `d = a − g⃗` gives `lonG = d·forward / 9.80665` (+ accelerating, − braking),
`latG = d·right` (+ pushed right, i.e. right turn), `vertG = d·up`. Gyro rates: `yaw = ω·up`
(+ left turn, counter-clockwise from above), `pitch = ω·right` (+ nose rising), `roll = ω·forward`
(+ rolling right). Attitude: `pitchDeg = asin(up·forward_cam)`, `rollDeg = −asin(up·right_cam)`;
the bubble moves to the high side. Bins where the optical axis is within ~6° of vertical are
marked undefined (no heading axis). A rear-facing camera would flip forward/lateral signs (v0.2: mount toggle).

## 6. Synchronisation model

Global time `T = chapter.offsetSec + video.currentTime`, sampled every animation frame.
Per frame: GPS state is interpolated between the two neighbouring samples (only when both
are valid and < 2.5 s apart), the map marker/heading, chart playheads (DOM overlay, no
re-render) and timeline are updated; HUD text is throttled to ~12 Hz. Seeking sets
`video.currentTime` in the right chapter (swapping the source when the target chapter
differs; play/pause state is preserved; a chapter that ends auto-loads the next one).

Expected accuracy: telemetry timing comes from the MP4 sample table (same clock as the video),
so sync error is bounded by the GPS sample interval (55 ms at 18 Hz, 100 ms at 10 Hz) plus the
browser's frame period. Chapter boundaries use video-track durations; a few ms of drift at a
boundary is expected and harmless.

## 7. Configuration

Precedence: CLI flags → environment → `config.json` → defaults.

| Setting | CLI | Env | Default |
| --- | --- | --- | --- |
| media roots | `--media <dir>` (repeatable / positional) | `GOPRO_VIEWER_MEDIA` (`:`-separated) | `[]` |
| port | `--port` | `GOPRO_VIEWER_PORT` | `8790` |
| host | `--host` | `GOPRO_VIEWER_HOST` | `127.0.0.1` |
| cache dir | `--cache` | `GOPRO_VIEWER_CACHE` | `./.cache` |
| IMU rate | `--accel-hz` | — | `25` |
| log level | `--log-level` | `LOG_LEVEL` | `info` |

## 8. Acceptance criteria (v0.1)

1. `npm test` passes (28 tests: demuxer + stream probe, library grouping, telemetry normalisation incl. GPS9 and camera-frame mapping, chapter merge/stats, exports, HTTP API incl. Range streaming) and `npm run lint` is clean (no unused code, no function above 50 lines or cyclomatic complexity 15).
2. Pointing the app at a folder of GoPro files lists every recording with correct chapter grouping and duration; scanning 500 files completes in seconds (moov-only reads, cached).
3. Selecting a recording with GPS shows the track on the map, the HUD and charts populate, and pressing play moves the marker along the track in step with the video; the marker never draws through no-fix segments.
4. Clicking on the map track, a chart or the timeline seeks the video (across chapters) and all views stay consistent.
5. Multi-GB chapters open without loading the media into memory (server RSS stays ~O(telemetry size)).
6. GPX/CSV exports open in QGIS / pandas without cleanup; GPX contains only fixed points.
7. A file without a GPMF track still plays; the UI states that no telemetry is available.
8. On a forward-facing dashcam recording, hard braking moves the G-force ball to BRK, a right turn moves the gyro ball and the G-force ball to the right, and the attitude bubble stays near centre on level road (verified on HERO13 footage).

## 9. Known limitations and risks

| Item | Impact | Mitigation |
| --- | --- | --- |
| HEVC (GX files) needs a browser with hardware HEVC decoding | Safari and Chrome on Apple Silicon play them; other setups may fail to decode | Automatic fallback to the LRV proxy when present; error overlay explains the cause |
| Map tiles require internet | Offline: track still renders on a blank canvas | Alternative basemap providers selectable |
| GoPro creation time is local time stored as UTC | Library dates are "camera time" | Shown verbatim; GPS UTC is used for the HUD clock |
| GPS before first fix can report junk coordinates (e.g. 42°N 129°W) | Would draw wrong track | Fix-quality filter on client and in stats/GPX |
| Camera GPS switched off (HERO13 Preferences › Regional › GPS; HERO12 has no GPS at all) | Telemetry track exists but carries no GPS stream: no map/speed/altitude | Library badge shows IMU instead of GPS; the viewer explains the cause and still plays video with IMU charts |
| Very long recordings (hours) produce large telemetry JSON (tens of MB) | Slow first load | IMU downsampling; per-chapter cache; consider server-side decimation by zoom level (v0.2) |

## 10. Roadmap candidates

Highlight tags (HLMT) on the timeline · lap/segment markers with per-segment stats · rear-facing mount toggle ·
bump / harsh-event detection from `vertG` and `magMax` with markers on the timeline ·
server-side decimation for hours-long recordings · camera orientation (CORI/GRAV) for a
pitch/roll indicator · side-by-side comparison of two recordings · packaging as a single
binary or a menu-bar app.
