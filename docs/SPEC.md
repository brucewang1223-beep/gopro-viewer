# GoPro Viewer — Specification (v0.1)

Status: implemented (v0.3.0 — import from the camera over USB). This document is the single source of truth for scope,
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
| Map | MapLibre GL with the K2 basemaps of `map.lumobility.com`, rendered from the same two styles that service publishes: **Map** (K2 Mapbox Streets Match — UAE vector to z14 over a world vector base to z7, road shields drawn on a canvas at style load because K2 ships no sprite) and **Satellite** (K2 Satellite Hybrid — UAE imagery to z19 over world imagery to z12, with a Labels chip that hides the label layers). The switcher sits bottom-left as two preview cards, mirroring K2's own picker; key `B` cycles it; the choice is remembered in `localStorage` and `config.json` only supplies the first-run default. Tiles and glyphs are fetched through `/api/map*` so the token stays server-side (§4.5). On selection the whole route is fitted and centred. Route drawn in two colours — travelled (accent) vs remaining (grey) — updated as playback advances; optional speed colouring (remaining part dimmed). Prominent pulsing position marker with heading. Map stays freely zoomable; "fit whole route" and "centre on position" buttons top-left (also key `F`); follow mode. Only samples the receiver actually fixed are drawn: a lost fix ends the line rather than being bridged, and the position marker is hidden while there is no fix instead of holding a stale position. |
| Charts | Speed (km/h — drawn only where the GPS fix is steady, see the speed rule in §4.2; elsewhere the line breaks), altitude (m), G-force (longitudinal / lateral / vertical g), gyro rates (yaw / pitch / roll °/s); the chart set adapts to the data available; shared cursor and zoom; chapter boundaries marked. |
| Gauges | Instrument cluster centred at the top of the video: G-force ball (friction circle, 0.5 g / 1 g rings, trail), gyro ball (yaw ↔, pitch ↕, roll-rate arc at the rim) and attitude bubble level (pitch / roll from the measured gravity direction). Toggle with `G`. |
| Audio | Always muted by design (`<video muted>` and enforced in code); no volume UI. Muted playback also avoids browser autoplay restrictions. |
| GPS status strip | A bar along the bottom of the timeline shows the receiver's status over the whole recording, in the HUD's colours: red = no fix (nothing drawn on the map there), amber = 2D fix, green = 3D fix. The recording is bucketed into 600 columns and each column takes the status most of its samples reported (ties go to the worse one). The `Fix 3D / 2D / none` counts in the stats bar carry the same three colours and double as the legend. |
| Timeline alignment | The timeline bar's drawn extent is inset to the charts' plot area (measured after uPlot's ready/setSize hooks, so it tracks resizes), so its playhead and the chart playheads share the same x position. |
| Skip step | ← / → and the −/+ buttons take a user-selectable step: whole video frames (1, 2, 5, 10) or seconds (1, 2, 3, 5, 10, 15, 30, 60); Shift multiplies by 6. A frame step pauses playback and is computed on the chapter's own frame grid (`fps` from the chapter, target = middle of the frame, so repeated steps cannot drift). The choice is persisted in `localStorage` as `2f` / `5s`; a bare number left by an earlier version reads as seconds. `,` / `.` always step one frame regardless of the selector. |
| Layout stability | Every live readout (HUD cells, gauge captions, time display, chart hover readouts) is written at a constant character width in a monospace font with tabular numerals and `white-space: pre`, so nothing reflows or jitters during playback. |
| Stats | Distance, max/avg speed and moving time (from trustworthy speed samples only — see the speed rule in §4.2), elevation gain/loss, fix-quality histogram, camera model/firmware, UTC start. |
| Export | GPX 1.1 (fixed points only, with ele/time/speed), GeoJSON and CSV (GPS, accelerometer, gyroscope). GeoJSON is a `FeatureCollection` of `LineString` features, one per contiguous run of positioned samples (split on lost fix or a gap > 5 s), positions as `[lon, lat, alt]`, per-run stats + camera/settings in `properties`, per-point `times`/`speeds` in `properties.coordinateProperties` (the togeojson convention). CLI `scripts/dump-telemetry.js` for headless extraction. |
| Import | Copy clips from the GoPro connected by USB (GoPro Connect / NCM mode, Open GoPro HTTP API — see §4.6) into a destination folder picked per import in the Mac's own folder panel (opened by the server with `osascript`, never typed), filed under `<destination>/<YYYY-MM-DD>/` by the camera's recording date. Two modes: **All files** (each clip's MP4 plus its LRV proxy, and any photos) or **MP4 only**; THM thumbnails are never imported. A ledger of everything ever imported (`import-ledger.json`, outside `.cache/`) decides what is ticked by default: a clip imported before — whether or not its local copy still exists — is listed unticked and labelled with when and where it went, and is only imported again when the user ticks it by hand. One job at a time, sequential downloads, HTTP Range resume of a `.part` left by a stopped or failed transfer, byte-count verification, a file already complete at the destination is verified rather than fetched, the ledger is written after every completed clip, and the destination is added as a media root (unless one already covers it) so the imported footage appears in the library. |
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
│ app.js (wiring, keys)  library.js  player.js  map.js (MapLibre)│
│ charts.js (uPlot)  timeline.js  track.js (time lookups)        │
│ motion.js (driver frame)  gauges.js  hud.js  stats.js  util.js │
│ import.js (import dialog, job polling)                         │
└───────────────▲───────────────────────────▲─────────────────────┘
                │ JSON (fetch)              │ video bytes (Range)
┌───────────────┴───────────── server/ (Node ≥ 20, Express) ─────┐
│ app.js (routes)   library.js (scan, chapter grouping, id map)   │
│ mp4.js (moov-only demuxer)  gpmf-klv.js (settings, ORIN/ORIO)   │
│ gpmf-probe.js (fix probe)  decode.js (gopro-telemetry wrapper)  │
│ telemetry.js (pipeline, cache)  export.js (GPX/GeoJSON/CSV)     │
│ importer.js (plan + job)  gopro-camera.js (Open GoPro client)   │
│ import-ledger.js  folder-picker.js (macOS panel)  geo.js         │
│ config.js                                                        │
│ json-cache.js  ids.js  log.js  index.js (entry)                 │
└──────────────┬──────────────────────────────┬───────────┬──────┘
               │ fs reads (moov + gpmd samples)│ .cache/   │ HTTP over USB (172.2X.1YZ.51:8080)
        GoPro .MP4 / .LRV / .THM files on disk           GoPro camera (GoPro Connect mode)
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
| Import straight from the camera over USB (Open GoPro HTTP on the GoPro Connect network) rather than through Finder / MTP | A GoPro is not a USB mass-storage device; in GoPro Connect mode it is a USB network card and Finder never sees it. Its HTTP API lists the card, serves every file with Range support and stays scriptable, at the USB 2.0 ceiling of ≈43 MB/s on a HERO13 (a card reader is 2–3× faster, not an order of magnitude). The camera's media list carries a creation time in the camera's local clock stored as if it were UTC, which is exactly what a date folder needs. |
| Import ledger keyed by camera serial + folder + name + size + creation time, kept outside `.cache/` | "Already imported" must survive a deleted local copy and a purged cache, and must not misfire when a formatted card reuses `GX010001` for a new clip. The ledger is the only state the importer trusts; the destination folder is verified by byte count but never scanned for history. |
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
          t[], lat[], lon[], alt[], speed2d[], speed3d[], fix[], dop[], utc[],
          speedOk[] },                          // 0/1 per sample — see the speed rule below
  accl: { hz, n, frame: "camera", orientation: {orin, orio, order, source},
          t[], x[], y[], z[], mag[], magMax[] },                            // m/s², x left, y back, z up
  gyro: { … same shape … },                                                  // rad/s, same frame
  stats: { validPoints, speedPoints, totalPoints, distanceM, movingTimeSec, maxSpeedMs, avgSpeedMs,
           elevGainM, elevLossM, minAltM, maxAltM, fixCounts: {none, fix2d, fix3d} },
  warnings: [] }
```

Units: `t` seconds from the first frame of chapter 1; speeds m/s; altitude metres (MSL where
the camera or the EGM96 correction provides it); `fix` 0/2/3; `dop` dilution of precision
(GPS5 `GPSP/100`, GPS9 native); `utc` epoch ms from GPS time.

Validity rule (client `web/js/track.js`, server `server/geo.js`): a GPS sample positions the
marker / draws the track only if the receiver reported `fix ≥ 2` (2D or 3D — a sample with no
fix reported at all is not positioned) and the coordinates are finite, non-zero and in range.
A run of drawn points ends wherever that rule fails, so no line is ever drawn across a stretch
the receiver could not position, and a run left with a single point is not drawn at all.
Statistics apply the same validity rule; the altitude chart and CSV keep every sample.

Speed rule (`SPEED_QUALITY` and `speedOkFlags` in `server/geo.js`, evaluated once per recording in
`mergeChapters` and shipped as the `gps.speedOk` column): a speed reading counts only where the fix
behind it is **steady**, which takes three parameters, not one.

| | value | why |
| --- | --- | --- |
| `maxDop` | 3 | Driving sits at DOP 1.42 (p50) / 3.17 (p99); every implausible reading in GX0001 starts at 3.65. A threshold of 5 would let the 271.8 km/h sample through. A stream that reports no DOP at all passes. |
| `maxDipSec` | 2 | DOP wobbles sample to sample — in normal city driving it crosses 3 for a tenth of a second at a time (17 of the 20 weak stretches in GX0001 last under 1 s). A dip shorter than this with good samples on **both** sides is ignored, otherwise a bare threshold shreds the line into fragments. |
| `minSteadySec` | 3 | An island of good samples shorter than this is dropped. A receiver that has just come back for half a second has proven nothing, and the speed it reports is still the stale one it froze on — that is exactly the 2-sample island that made 271.8 km/h the recording's maximum. |

A receiver that has lost its lock repeats its last speed, so the rule is about the fix rather than
the number: in GX0001 hundreds of consecutive `fix = 0` samples report exactly 176.7 and then
exactly 271.8 km/h. The three values together leave that drive as **one unbroken speed line**
(5188 of 5354 positioned samples) and take the maximum from 271.8 km/h to 54.7 km/h.

The flag drives the HUD readout (`--` when it fails), the speed chart (a gap), the speed-colour
scale on the map, and `maxSpeedMs` / `avgSpeedMs` / `movingTimeSec` in the stats (`speedPoints`
reports how many samples fed them). The client does not re-derive it: `Track.precise` is
`valid && gps.speedOk`, so it can never be looser than the positioning rule. Distance, the drawn
route and the exports are untouched — GPX/GeoJSON/CSV carry the camera's own speeds with the `dop`
column alongside. Older GPS5 receivers report DOP 4–7 throughout (Fusion is pinned at 6.73), so
their speed line thins right out; `SPEED_QUALITY` is the one place to raise.

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

### 4.6 Import (`GET /api/import`, `POST /api/import`, `GET /api/import/job`)

The camera is found on the USB network: the Mac's interface is `172.2X.1YZ.52` and the camera answers on
`172.2X.1YZ.51:8080` (XYZ = last three digits of its serial number); `import.camera` in `config.json`
pins a URL instead. `GET /gopro/camera/control/wired_usb?p=1` enables wired control, `/gopro/camera/info`
gives model / serial / firmware, `/gopro/media/list` the card contents, and `/videos/DCIM/<dir>/<file>`
the bytes (the LRV proxy is not listed but is served under its card name; its size is `glrv`).

```
GET  /api/import → { camera: { model, serial, firmware, url } | null, reason?,
                     items: [{ key, dir, name, size, cre, lrvSize, date,        // key = ledger identity, date = YYYY-MM-DD
                               imported: { at, dest, files } | null }],       // from the ledger
                     defaults: { dest, mode }, job }                           // last destination / mode; current or last job
POST /api/import/choose-folder { current } → { path | null }                   // macOS folder panel on the server's screen; null = cancelled; 501 elsewhere
POST /api/import { dest, mode: "all" | "mp4", keys: [key] } → 202 job         // 400 bad input, 409 while one runs, 503 no camera
GET  /api/import/job → job | null      DELETE /api/import/job → { cancelled }
job = { id, state: running | done | failed | cancelled, dest, mode, camera, startedAt, finishedAt,
        totalBytes, doneBytes, rateBps,
        items: [{ key, name, date, size, total, bytes, status: pending | downloading | done | failed | cancelled, error,
                  files: [{ name, size, status: pending | downloading | done | present | absent }] }] }
```

`date` comes from `cre` read with UTC getters: the camera writes its local wall-clock time as if it
were UTC (verified against the THM's EXIF time on the card), so the folder is the local recording date.
Files per clip: `all` → the entry plus `GLccnnnn.LRV` when the list reports an LRV size; `mp4` → MP4
entries only. The THM thumbnail is never fetched in either mode. Files are fetched in order, one
clip at a time, oldest first; a file already at the destination with the expected size is `present`;
a `<file>.part` is resumed with `Range: bytes=<n>-` (a 200 restarts it, a 416 discards it); a listed
file the camera does not serve (404) is `absent` and dropped from the byte total; the clip's ledger
entry is written only when all its files are in.

The destination comes from the Mac's folder panel (`server/folder-picker.js`): `osascript -e 'tell me
to activate' -e 'choose folder …'` in the server's own GUI session, opening on the last destination
(or the home folder), returning the POSIX path; Cancel (AppleScript error −128) answers `null`; a
second request while the panel is open shares its answer. The server never accepts a typed path
from the dialog — `POST /api/import` still validates that `dest` is absolute.

Ledger (`import-ledger.json`, `config.ledgerFile`): `{ v: 1, entries: { <key>: { camera, serial, dir,
name, size, cre, importedAt, dest, files } } }`, written atomically after every clip; a corrupt
ledger is an error, never treated as empty. `key = shortId('import', serial, dir, name, size, cre)`.

## 5. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | liveness, node version, last scan time |
| `GET /api/config` | host/port/cache/roots |
| `GET /api/library` | recordings (scans on first call) |
| `POST /api/rescan` | rescan all roots |
| `GET /api/recordings/:id/export.geojson` | driven route as a GeoJSON FeatureCollection |
| `POST /api/roots {path}` / `DELETE /api/roots/:id` | manage media roots (persisted to `config.json`) |
| `GET /api/media/:fileId` | video bytes, `Accept-Ranges: bytes`, 206 partial content |
| `GET /api/thumb/:fileId` | THM/JPEG thumbnail |
| `GET /api/recordings/:id/telemetry` | merged telemetry JSON |
| `GET /api/recordings/:id/export.gpx` | GPX download |
| `GET /api/recordings/:id/export.csv?stream=gps\|accl\|gyro` | CSV download |
| `GET /api/import` | camera on USB + card files annotated with the ledger (§4.6) |
| `POST /api/import/choose-folder {current}` | macOS folder panel → `{ path | null }` (501 off macOS) |
| `POST /api/import {dest, mode, keys}` | start an import job (202; 400 / 409 / 503) |
| `GET /api/import/job` / `DELETE /api/import/job` | progress of the current or last job / cancel it |
| `GET /api/map/v2/tiles/…` | K2 tiles / TileJSON, token added server-side, 7-day browser cache |
| `GET /api/map-fonts/…` | K2 glyph ranges (no token upstream) |
| `GET /`, `/vendor/maplibre/*`, `/vendor/uplot/*` | UI and vendored libraries |

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

### 4.5 Map credentials and route rendering

`config.json` holds the K2 `api`, `glyphs`, `token`, `basemap` and `labels`; only that file
ever sees the token. `server/map.js` whitelists the tile and glyph path shapes, appends the
token and streams the upstream response back, so the committed styles in `web/styles/` carry
no host and no credential, and `/api/config` reports only whether a token is configured.

The route is uploaded to the renderer once as one GeoJSON LineString per run
(`lineMetrics: true`). Playback moves the cut point of a `line-gradient` per run instead of
pushing new geometry, so cost is independent of track length; speed colouring is the same
mechanism with a sampled colour ramp and a dimmed copy of it for the part not yet driven
(`web/js/map-route.js`, unit tested).

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
| K2 map | — | — | `map.api`, `map.glyphs`, `map.token`, `map.basemap`, `map.labels` — `config.json` only, so the token never lands in a shell history or a process listing |
| import | — | — | `import.dest` and `import.mode` (last choices in the dialog, written back on every start), `import.camera` (URL override, empty = discover on USB), `ledgerFile` (default `./import-ledger.json`; a custom path survives saves) — `config.json` only |

## 8. Acceptance criteria (v0.1)

1. `npm test` passes (60 tests: demuxer + stream probe, library grouping, telemetry normalisation incl. GPS9 and camera-frame mapping, chapter merge/stats, exports, HTTP API incl. Range streaming, map proxy path whitelist and token signing, route geometry and gradients, import against a fake camera — date folders, modes without THM, ledger skip and manual re-import, in-place verification, Range resume, cancel, error codes, folder-panel scripting) and `npm run lint` is clean (no unused code, no function above 50 lines or cyclomatic complexity 15).
2. Pointing the app at a folder of GoPro files lists every recording with correct chapter grouping and duration; scanning 500 files completes in seconds (moov-only reads, cached).
3. Selecting a recording with GPS shows the track on the map, the HUD and charts populate, and pressing play moves the marker along the track in step with the video; the marker never draws through no-fix segments.
4. Clicking on the map track, a chart or the timeline seeks the video (across chapters) and all views stay consistent.
5. Multi-GB chapters open without loading the media into memory (server RSS stays ~O(telemetry size)).
6. GPX/CSV exports open in QGIS / pandas without cleanup; GPX contains only fixed points.
7. A file without a GPMF track still plays; the UI states that no telemetry is available.
8. On a forward-facing dashcam recording, hard braking moves the G-force ball to BRK, a right turn moves the gyro ball and the G-force ball to the right, and the attitude bubble stays near centre on level road (verified on HERO13 footage).
9. With a HERO13 on USB in GoPro Connect mode, *Import from camera* lists the card within a second, opens the Mac's folder panel in front of every window for the destination, files the chosen clips under `<destination>/<YYYY-MM-DD>/` with their LRV proxies (no THM) at the USB 2.0 rate (≈43 MB/s), records them in the ledger, shows them unticked as "imported …" on the next visit, imports a ticked one again (verifying a copy that is still there instead of fetching it), resumes a stopped transfer from its `.part`, and the imported recordings appear in the library when the job ends.

## 9. Known limitations and risks

| Item | Impact | Mitigation |
| --- | --- | --- |
| HEVC (GX files) needs a browser with hardware HEVC decoding | Safari and Chrome on Apple Silicon play them; other setups may fail to decode | Automatic fallback to the LRV proxy when present; error overlay explains the cause |
| Map tiles require internet | Offline: track still renders on a blank canvas | Alternative basemap providers selectable |
| GoPro creation time is local time stored as UTC | Library dates are "camera time" | Shown verbatim; GPS UTC is used for the HUD clock |
| GPS before first fix can report junk coordinates (e.g. 42°N 129°W) | Would draw wrong track | Fix-quality filter on client and in stats/GPX |
| Camera GPS switched off (HERO13 Preferences › Regional › GPS; HERO12 has no GPS at all) | Telemetry track exists but carries no GPS stream: no map/speed/altitude | Library badge shows IMU instead of GPS; the viewer explains the cause and still plays video with IMU charts |
| Very long recordings (hours) produce large telemetry JSON (tens of MB) | Slow first load | IMU downsampling; per-chapter cache; consider server-side decimation by zoom level (v0.2) |
| Import runs over USB 2.0 (HERO13: ≈43 MB/s, so ~13 min for 33 GB) and needs the camera in GoPro Connect mode with wired control | MTP mode, MacDroid/adb holding the device, or a sleeping camera → "No camera"; a card reader is 2–3× faster | The dialog says what to check; transfers resume from `.part`; one job at a time keeps the USB link saturated |

## 10. Roadmap candidates

Highlight tags (HLMT) on the timeline · lap/segment markers with per-segment stats · rear-facing mount toggle ·
bump / harsh-event detection from `vertG` and `magMax` with markers on the timeline ·
server-side decimation for hours-long recordings · camera orientation (CORI/GRAV) for a
pitch/roll indicator · side-by-side comparison of two recordings · packaging as a single
binary or a menu-bar app.
