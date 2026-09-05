# GoPro Viewer

Local web app that plays GoPro footage with its embedded telemetry replayed in sync:
GPS track on a map, live HUD (speed, altitude, position, fix quality, clock, g-force),
round G-force / gyro / attitude gauges on the video, speed / altitude / G-force / gyro
charts, chapter-aware timeline, GPX and CSV export, and import straight from the camera over USB.
Nothing leaves your machine; the server binds to `127.0.0.1`.

Spec and design decisions: [`docs/SPEC.md`](docs/SPEC.md).

## Requirements

Node.js ≥ 20 (tested on 22 and 24). A browser that decodes your footage:
H.264 (`GH…` files) plays everywhere; HEVC (`GX…` files) plays in Safari and in
Chrome on Apple Silicon Macs. The basemap needs internet access and a K2 map token
(see below); everything else works offline.

## Quick start

```bash
cd "GoPro Viewer"
npm install                      # project-local: node_modules/ and .npm-cache/ only
npm start -- --media /Volumes/GOPRO/DCIM
# → http://127.0.0.1:8790
```

You can also add folders from the header bar in the UI (persisted to `config.json`),
or create `config.json` from `config.example.json`. All options: `npm start -- --help`.

The basemap comes from the K2 map service (`map.lumobility.com`). Put your token in the
`map` block of `config.json` — that file is git-ignored, and the server signs every tile
request itself, so the token never reaches the browser and never lands in a style file:

```json
"map": { "token": "…", "basemap": "streets", "labels": true }
```

Without a token the app still runs; the map pane stays empty and says so. K2 covers the
UAE in detail (vector to z14, imagery to z19) and the rest of the world coarsely (vector
to z7, imagery to z12), so footage shot far outside the UAE has no basemap when zoomed in.

Try it without a camera: `npm run samples` downloads GoPro's public sample clips into
`samples/`, then `npm start -- --media samples`.

## Run at login and use it as a desktop app (macOS)

```bash
npm run autostart            # launchd agent: starts the server at login, restarts it if it crashes
npm run autostart:status     # agent state + health check
npm run autostart:remove
```

The agent runs `node server/index.js` in this folder and logs to `.cache/server.log`. With the
server always on, install the page as a Chrome app so it gets its own window and Dock icon: open
http://127.0.0.1:8790 in Chrome → ⋮ menu → *Cast, save and share* → *Install page as app…*
(the page ships a web-app manifest and icons, so Chrome offers this directly). The installed app
lives in `~/Applications/Chrome Apps.localized/`; right-click its Dock icon → *Options* →
*Keep in Dock* to pin it.

## Using the viewer

Pick a recording in the sidebar (grouped by date; chapters of one recording are merged).
The video, map, HUD and charts share one timeline: click anywhere on the map track, a
chart or the timeline bar to seek; drag on a chart to zoom (double-click resets).
The map fits the whole route when a recording is selected; the travelled part is drawn in
blue and the remaining part in grey, the pulsing arrow is the current position. Zoom and
pan freely — the first button top-left (or `F`) fits the whole route again, the second
centres on the current position. "Speed colours" switches the route to a speed-coloured
rendering with the remaining part dimmed. The card at the bottom-left switches between
the **Map** (K2 vector) and **Satellite** (K2 imagery) basemaps — `B` cycles them — and
the Labels chip on the satellite card hides the place and road labels over the imagery.
The choice is remembered per browser; `config.json` only sets the first-run default.

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` / `→` | skip back / forward by the "Skip" step (default 5 s; 1/2/5/10 frames or 1–60 s; `Shift` = ×6) |
| `,` / `.` | previous / next frame |
| `[` / `]` | previous / next chapter |
| `Home` / `End` | start / end |
| `M` (or `L`) | toggle map follow |
| `F` | fit map to track |
| `B` | switch basemap (Map ↔ Satellite) |
| `H` | toggle HUD |
| `G` | toggle gauges (G-force ball, gyro ball, attitude bubble) |
| double-click video | fullscreen |

Controls bar: playback speed, LRV proxy toggle (uses the camera's low-resolution
`GL…LRV` files when present — handy for 5.3K HEVC), speed colouring of the track,
GPX / CSV (GPS) / IMU (accelerometer CSV) exports.

Gauges (top centre of the video, driver's frame, works without GPS): the G-force ball moves
up when accelerating, down when braking, right in a right turn (rings at 0.5 g and 1 g); the
gyro ball moves left/right with turn rate and up/down with pitch rate, the arc at its rim
shows roll rate; the attitude bubble shows pitch and roll from the measured gravity direction.
The camera may be mounted tilted or upside down — "up" is measured, not assumed.
The sidebar shows the record-time camera settings read from the file header — `HS` badge when
HyperSmooth was on (hover for the level), `HS OFF` when it was off, the lens/FOV mode — and the bar
under the map lists the rest (Protune, colour profile, ISO range, horizon leveling, HDR, time zone).
The HUD's `G` value is the same quantity as the G-force ball: horizontal dynamic acceleration
with gravity removed (0 at rest, ~0.2–0.3 g in normal braking, 0.5 g is a hard stop), labelled
with the dominant direction. Playback is always muted: this is a telemetry review tool, not a
media player, so the audio track is never rendered.

### Import from the camera

*Import from camera* (header bar) copies clips straight from a GoPro connected by USB — no card
reader, no Finder. Set the camera's USB connection to **GoPro Connect** (Preferences › Connections ›
USB Connection; that is the default) and plug it in: it shows up as a small USB network, not as a
drive, and the viewer talks to it over the Open GoPro HTTP API. The dialog lists the card; *Choose
folder…* opens the Mac's own folder panel for the destination (it starts on the folder you used last
time), and you pick **All files** (each clip's MP4 with its LRV proxy, plus any photos) or **MP4 only**
— THM thumbnails are never copied. Clips are filed under `<destination>/<YYYY-MM-DD>/` by their
recording date, verified by byte count, and the destination joins the library as a media root when
the job ends.

Everything imported is remembered in `import-ledger.json`: a clip imported before is listed unticked
and labelled *imported 2026-09-05 → …/2026-09-05*, whether or not the local copy still exists, and is
only fetched again when you tick it (a copy that is still complete at the destination is verified,
not downloaded). *Stop* halts the job; the file in flight stays as `.part` and resumes next time.
A HERO13 transfers at the USB 2.0 ceiling, about 43 MB/s (≈ 13 minutes for 33 GB) — close the dialog
and keep using the viewer; the status bar follows the job.

### Export

*Export* gives the selected recording as **GPX** (fixed track points with elevation, time and
speed), **GeoJSON**, **CSV** (every GPS sample incl. fix and DOP) or **IMU** CSV (25 Hz
accelerometer). The GeoJSON is a `FeatureCollection` with one `LineString` per contiguous run of
positioned samples — a lost fix or a gap over 5 s starts a new one — with altitude as the third
ordinate, per-run statistics and camera settings in `properties`, and per-point `times` / `speeds`
arrays in `properties.coordinateProperties`. It opens directly in QGIS, kepler.gl or geopandas.

## Command-line extraction

```bash
node scripts/dump-telemetry.js GX010042.MP4 GX020042.MP4 --format gpx --out ride.gpx
node scripts/dump-telemetry.js GX010042.MP4 --format csv          # GPS table for pandas
node scripts/dump-telemetry.js GX010042.MP4 --format csv-accl     # 25 Hz accelerometer
node scripts/dump-telemetry.js GX010042.MP4                       # full JSON (same as the API)
```

Multiple files are treated as consecutive chapters of one recording.

## Project layout

```
server/   Node server: mp4.js (moov-only demuxer), gpmf-klv.js (settings header, sensor
          orientation), gpmf-probe.js (scan-time GPS fix probe), decode.js (gopro-telemetry
          wrapper), telemetry.js (pipeline), library.js (scan + chapter grouping), app.js
          (routes), export.js (GPX/GeoJSON/CSV), map.js (K2 tile + glyph proxy), importer.js
          (import plan + job), gopro-camera.js (Open GoPro HTTP client over USB), import-ledger.js,
          folder-picker.js (macOS folder panel), geo.js, config.js, json-cache.js, ids.js, log.js, index.js
web/      browser UI (plain ES modules, no build step; PWA manifest + icons): app.js (wiring, keys), player,
          map (+ map-route, map-controls, map-shields), charts, timeline, track, motion, gauges, hud,
          stats, library, import (dialog), util, api; styles/ holds the two K2 MapLibre styles
tests/    node --test suite + 5-second GoPro fixtures (see tests/fixtures/README.md) + a fake camera
          (fake-camera.js) for the import tests
scripts/  dump-telemetry.js (CLI), fetch-samples.sh, macos-launch-agent.sh (run at login)
docs/     SPEC.md
.cache/   per-file metadata and telemetry cache (safe to delete)
```

## Development

```bash
npm test          # 60 tests: demuxer, library, telemetry, exports, HTTP API, map proxy, route geometry, import
npm run lint      # ESLint: no unused code, functions ≤ 50 lines, complexity ≤ 15
npm run dev       # server with --watch
LOG_LEVEL=debug npm start -- --media <dir>
```

## Troubleshooting

"Cannot play / source not supported": the browser cannot decode the codec. Use Safari or
Chrome on Apple Silicon for HEVC, or enable the LRV proxy (the app switches automatically
when a proxy exists). "No usable GPS fix": the camera never locked (GPS off, indoors,
first seconds after power-on); the video still plays. Stale data after re-encoding a file:
delete `.cache/`. "No camera" in the import dialog: the camera is asleep, its USB connection is set
to MTP instead of GoPro Connect, or another program (MacDroid, adb) is holding the USB device — wake
it, change the mode, quit the program, then *Look again*. The folder panel is macOS-only: it is
opened by the server on its own screen, so it works with `npm start` and with the launchd agent, but
not when the server runs on another machine.

## Credits

Telemetry decoding by [gopro-telemetry](https://github.com/JuanIrache/gopro-telemetry)
(MIT), altitude correction by egm96-universal, map rendering by MapLibre GL JS with
basemaps and styles from K2 Maps (map.lumobility.com), charts by uPlot.
Test fixtures derive from GoPro's public samples in gopro/gpmf-parser (Apache-2.0).
