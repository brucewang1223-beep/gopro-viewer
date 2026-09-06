# GoPro Viewer

Your GoPro already knows where you were, how fast you were going and how hard you braked. It just
keeps all of it to itself, in a corner of the MP4 that nothing opens. This tool opens it: video, map
track, HUD and charts on one timeline, and a USB import that gets the clips off the camera without a
ceremony. Everything runs on your own machine.

English · [简体中文](README.zh-CN.md) · Design notes: [`docs/SPEC.md`](docs/SPEC.md)

![Main view: video, gauges, HUD, map track and charts on one timeline](docs/screenshots/viewer.jpg)

## Why this exists

I run a GoPro (HERO13 Black) as a dashcam. Three things got old quickly:

- **Quik and I want different things.** It would like to make me a highlight reel. I would like to
  watch the footage and read the numbers.
- **Getting the clips onto the computer is a production.** Plug a HERO13 into a Mac and you do not
  get a USB drive — in the default GoPro Connect mode you get a network adapter. So it is either pull
  the card or wrestle with software, and 30 GB turns into an evening.
- **The video and the map had never met.** Where was this corner, how fast was that, how hard was
  that stop? The answers are already inside the file — GoPro writes a GPMF telemetry stream next to
  the picture — but nothing on my Mac would show me both at once.

So this one does three things and stops there: play the footage, draw the numbers, and bring the
clips in over the cable. No editing timeline, no cloud, no account.

## How it was built

By chatting with Claude. All of it — the code, the tests, this README and the screenshots in it
(Opus 5 and Fable 5.1; every commit names the model in its `Co-Authored-By` trailer, which is the
honest record). I brought the requirements, the opinions and the occasional veto; it brought the
design, the code, the tests, and the habit of checking things against the real camera on my Mac
before claiming they worked.

The house rules ended up in the repository rather than in the story: 103 automated tests, ESLint with
warnings failing the build, no function over 40 lines, no dead code left lying around. Version 1.0
came out of a full review pass that found and fixed some sixty small sins.

Shared for anyone else running a GoPro on the windscreen who would rather not open Quik. MIT — take
it, change it, no need to ask.

## Screenshots

![Satellite basemap with labels, the route coloured by speed](docs/screenshots/satellite.jpg)

Satellite imagery (Esri) with place and road labels on top, the route coloured by speed and the arrow
at the current position; the bar underneath carries the statistics and the camera settings for this
recording.

![Import from the camera: the card listed, already-imported clips left unticked](docs/screenshots/import.jpg)

Import over USB: the card listed clip by clip. Anything imported before says when it came in and
where it went, and is left unticked.

## What it does

- **One timeline.** Video, map, HUD and charts follow the same playhead. Click the route, a chart or
  the timeline to seek; drag on a chart to zoom (double-click resets). Chapters of one recording
  (`GX01…`, `GX02…`) are merged and play as a single continuous clip.
- **Numbers on the picture.** The HUD gives speed, altitude, position, fix quality (2D/3D and DOP),
  UTC and local time, and current g. Three gauges sit at the top of the video: a G-force ball
  (accelerate / brake / corner), a gyro ball (yaw, pitch and roll rates) and an attitude bubble
  (pitch and roll). Mount the camera tilted or upside down if you like — "up" is measured from
  gravity, not assumed.
- **Charts.** Speed, altitude, longitudinal / lateral / vertical g, gyro rates. Speed is drawn only
  where the fix is steady, so the phantom 270 km/h that a searching receiver repeats never reaches
  the line.
- **Map.** OpenStreetMap streets and Esri satellite imagery with an optional label overlay — no key,
  no account. The route is split into travelled and remaining and can be coloured by speed; follow
  the current position, or fit the whole route with one key.
- **Import over USB.** Lists the card, files clips by recording date, keeps a ledger of what came in,
  and offers to clear the card afterwards. Details below.
- **Export.** GPX, GeoJSON, CSV (every GPS sample) and IMU CSV (25 Hz accelerometer), plus a CLI for
  batch extraction.
- **Local.** The server binds to `127.0.0.1`. Footage and telemetry never leave the machine; only the
  map tiles come from the internet.

## Requirements

Node.js ≥ 20 (tested on 22 and 25) and a browser that can decode your footage: H.264 (`GH…` files)
plays everywhere, HEVC (`GX…` files) plays in Safari and in Chrome on Apple Silicon Macs. Where it
will not, tick **Proxy (LRV)** and the viewer plays the camera's own low-resolution copy instead —
same telemetry, smaller picture.

## Quick start

```bash
git clone https://github.com/brucewang1223-beep/gopro-viewer.git
cd gopro-viewer
npm install
npm start -- --media /Volumes/GOPRO/DCIM     # one or more folders holding your footage
# → http://127.0.0.1:8790
```

Folders can also be added from the header bar once the server is running (they are saved to
`config.json`), or written into a `config.json` copied from `config.example.json`. All options:
`npm start -- --help`.

No footage to hand? `npm run samples` fetches GoPro's public sample clips into `samples/`, then
`npm start -- --media samples`.

### Run at login, and as a desktop app (macOS)

```bash
npm run autostart          # launchd agent: starts the server at login, restarts it if it crashes
npm run autostart:status   # agent state and health check
npm run autostart:remove
```

The agent runs the server in this folder and logs to `.cache/server.log`. With it always on, open
http://127.0.0.1:8790 in Chrome → ⋮ menu → *Cast, save and share* → *Install page as app…* for a
window and a Dock icon of its own; the page ships a web-app manifest and icons, so Chrome offers this
by itself.

## Import from the camera

1. Set the camera's USB connection to **GoPro Connect** (Preferences › Connections › USB Connection;
   it is the factory default). In that mode the camera is not a drive but a small USB network, and
   the viewer talks to it over the Open GoPro HTTP API.
2. Plug it in and press **Import from camera**. The dialog lists the card: new clips ticked, clips
   imported before unticked, with the date and destination of that earlier import.
3. **Choose folder…** opens the Mac's own folder panel for the destination, starting where you left
   it last time. Each clip can bring its **LRV proxy** (ticked by default — the file the viewer falls
   back to when HEVC will not decode) and its **THM thumbnail** (unticked by default). Both choices
   are remembered.
4. **Import.** Clips are filed under `<destination>/<YYYY-MM-DD>/` by recording date, verified byte
   for byte, and the destination joins the media library when the job ends. Close the dialog and
   carry on watching if you like — the status bar follows the job. **Stop** halts it; a
   half-transferred file stays as `.part` and resumes next time.
5. When it finishes, the dialog asks whether to **delete what it just imported from the camera**
   (the LRV and THM go with the clip). *Keep on camera* leaves the card untouched. Only clips that
   arrived complete in that job are ever offered for deletion.

`import-ledger.json` remembers everything that has been imported, whether or not the local copy still
exists, so nothing is fetched twice by accident. Tick a clip by hand to bring it in again; if the
copy at the destination is still complete it is verified rather than downloaded.

A HERO13 transfers at the USB 2.0 ceiling, about 43 MB/s — roughly 13 minutes for 33 GB.

**No camera** in the dialog: the camera is asleep, its USB connection is set to MTP instead of GoPro
Connect, or another program (MacDroid, adb) is holding the device. Fix that, then press
**Look again**.

## The map

Out of the box (`"map": { "provider": "osm" }`) the data comes from OpenStreetMap: vector tiles from
[OpenFreeMap](https://openfreemap.org) (the whole world to z14, no key, no quota) and Esri World
Imagery for the satellite view, with the same label overlay on top. The browser fetches the tiles
directly. The basemap card sits at the bottom left, `B` cycles it, and the **Labels** chip on the
satellite card hides the place and road labels over the imagery. The choice is remembered per
browser; `config.json` only supplies the first-run default.

`"provider": "k2"` renders the same two styles from the K2 map service (`map.lumobility.com`), which
covers the UAE in more detail and needs a token in the `map` block of `config.json`:

```json
"map": { "provider": "k2", "token": "…", "basemap": "streets", "labels": true }
```

The token stays server-side — the server signs every tile request itself, and `config.json` is
git-ignored. The OSM styles are derived from the K2 ones by `node scripts/make-osm-styles.js`; edit a
K2 style, rerun it, and the test suite will tell you if you forgot.

## Export

With a recording selected, the controls bar offers **GPX** (positioned track points with elevation,
time and speed), **GeoJSON**, **CSV** (every GPS sample, fix state and DOP included) and **IMU**
(25 Hz accelerometer CSV). The GeoJSON is a `FeatureCollection` with one `LineString` per unbroken
run of positioned samples — a lost fix or a gap over 5 s starts a new one — with altitude as the
third ordinate, per-run statistics and camera settings in `properties`, and per-point `times` and
`speeds` in `properties.coordinateProperties`. It opens as it is in QGIS, kepler.gl or geopandas.

Exports are deliberately unfiltered: they carry the camera's own speeds with the `dop` column beside
them, so you can apply whatever rule your analysis needs.

From the command line (several files are treated as consecutive chapters of one recording):

```bash
node scripts/dump-telemetry.js GX010042.MP4 GX020042.MP4 --format gpx --out ride.gpx
node scripts/dump-telemetry.js GX010042.MP4 --format csv          # GPS table for pandas
node scripts/dump-telemetry.js GX010042.MP4 --format csv-accl     # 25 Hz accelerometer
node scripts/dump-telemetry.js GX010042.MP4                       # full JSON (same as the API)
```

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` / `→` | skip back / forward by the Skip step (default 5 s; 1/2/5/10 frames or 1–60 s; hold `Shift` for ×6) |
| `,` / `.` | previous / next frame |
| `[` / `]` | previous / next chapter |
| `Home` / `End` | start / end |
| `M` (or `L`) | follow the current position on the map |
| `F` | fit the map to the whole route |
| `B` | switch basemap (Map ↔ Satellite) |
| `H` | show / hide the HUD |
| `G` | show / hide the gauges |
| double-click the video | fullscreen |

## Known limits

- Verified on macOS with a HERO13 Black. GPMF is common to every GoPro generation — the sample clips
  from `npm run samples` cover HERO5 through MAX and all play — but the camera import has only been
  exercised on a HERO13.
- The folder panel is macOS-only. On another system set `import.dest` in `config.json`; the rest of
  the import works the same.
- The sidebar shows the camera's local recording time. HERO12 and newer write true UTC into the file
  header and the viewer converts it back with the recorded time zone; older cameras write local time
  there already. Hover a recording for its UTC start; the HUD shows both clocks.
- Playback is always muted. This is a telemetry review tool, not a media player, so the audio track
  is never rendered.
- Map tiles come from public services (OpenFreeMap, Esri) and need a connection. Everything else
  works offline.

## Troubleshooting

**"Cannot play / source not supported"** — the browser cannot decode the codec. Use Safari or Chrome
on Apple Silicon for HEVC, or switch on the LRV proxy; the app does that by itself when a proxy
exists. **"No usable GPS fix"** — the receiver never locked (GPS switched off, indoors, the first
seconds after power-on); the video still plays. **Stale figures after re-encoding a file** — delete
`.cache/`. **The folder panel never appears** — it is opened by the server on its own machine, so it
works with `npm start` and with the launchd agent, but not when the server runs somewhere else.

## Project layout

```
server/   Node server: mp4.js (moov-only demuxer), gpmf-klv.js (settings header, sensor
          orientation), gpmf-probe.js (scan-time GPS fix probe), decode.js (gopro-telemetry
          wrapper), telemetry.js (pipeline), library.js (scan + chapter grouping), camera-clock.js
          (what a creation time means per camera generation), app.js (routes), export.js
          (GPX/GeoJSON/CSV), map.js (K2 tile + glyph proxy), importer.js (import plan and job),
          gopro-camera.js (Open GoPro HTTP client over USB), import-ledger.js, folder-picker.js
          (macOS folder panel), geo.js (positions, runs, run statistics, speed rule), config.js,
          fs-util.js, http-error.js, json-cache.js, ids.js, log.js, index.js
web/      browser UI — plain ES modules, no build step, PWA manifest and icons: app.js (wiring,
          keys), player, map (+ map-route, map-controls, map-shields), charts, timeline, track,
          motion, gauges, hud, stats, library, import (dialog), util, api; styles/ holds the two K2
          MapLibre styles and the two OSM styles derived from them
tests/    node --test suite + 5-second GoPro fixtures (see tests/fixtures/README.md) + a fake camera
          (fake-camera.js) for the import tests
scripts/  dump-telemetry.js (CLI), make-osm-styles.js (K2 styles → OSM styles), fetch-samples.sh,
          macos-launch-agent.sh (run at login)
docs/     SPEC.md, screenshots/
.cache/   per-file metadata and telemetry cache (safe to delete)
```

## Development

```bash
npm test          # 103 tests: demuxer, library, camera clock, telemetry and geodesy, exports,
                  # config, HTTP API, map proxy and OSM styles, route geometry, browser helpers, import
npm run lint      # ESLint, warnings fail: no unused code, functions ≤ 40 lines, complexity ≤ 12
npm run dev       # server with --watch
LOG_LEVEL=debug npm start -- --media <dir>
```

[`docs/SPEC.md`](docs/SPEC.md) is the single source of truth for scope, architecture, data contracts
and acceptance criteria. Change the spec first, then the code.

English is the project language — code, comments, commit messages, the spec and the interface are all
written in it. [`README.zh-CN.md`](README.zh-CN.md) is a translation of this file and follows it.

## Credits

Telemetry decoding by [gopro-telemetry](https://github.com/JuanIrache/gopro-telemetry) (MIT),
altitude correction by egm96-universal, map rendering by MapLibre GL JS, basemap data from
OpenStreetMap contributors and OpenFreeMap, satellite imagery by Esri, map styles from K2 Maps
(map.lumobility.com), charts by uPlot. The test fixtures are cut from GoPro's public samples in
gopro/gpmf-parser (Apache-2.0).

MIT licensed. If you also run a GoPro on the windscreen, I hope it saves you an evening.
