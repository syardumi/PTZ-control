# Move SE Control Panel

A local-network control panel for a **PTZOptics Move SE (PT20X‑SE‑xx‑G3)**
PTZ camera — pan/tilt/zoom, focus, presets (with thumbnails), and a live
preview, from any browser on your network (phone, laptop, tablet), or a
native macOS app.

It talks to the camera over the same HTTP‑CGI interface PTZOptics' own
joystick controllers and video software use, so nothing needs to be installed
on the camera itself.

The app is split into two independent pieces:

- **`server/`** — talks to the camera, stores settings/presets/thumbnails,
  exposes an HTTP API. Runs on one machine on your network (a Mac Mini, an
  always-on laptop, etc.) — this is the one thing that actually needs to be
  near the camera.
- **`client/`** — the control panel UI, a browser/PWA app (installable to a
  phone's home screen) that talks to the server's API. You can open it from
  any device on the same network — it doesn't need to run on the same
  machine as the server.

## Requirements

- **Node.js 24+ for the server** (the current LTS release; needs the
  built-in `fetch`), **Node.js 18+ for the client**
- The camera and the **server** on the same local network; the **client**
  just needs to reach the server's address over the network
- ffmpeg — for the smooth live preview. **Bundled automatically**: the
  server's `npm install` downloads a copy for your Mac's exact architecture
  (Apple Silicon or Intel) via the `@ffmpeg-installer/ffmpeg` package, so
  there's nothing to install yourself. If that ever fails for some reason,
  it falls back to a system `ffmpeg` on PATH if there is one, and finally to
  a slower snapshot-refresh preview if neither is available — the app still
  works either way.

## Setup

**On macOS, the easy way:** double-click **`server/start.command`**, then
**`client/start.command`**. Each checks for Node, installs its own
dependencies on first run, and starts. The client's script also opens your
browser to it automatically. Closing either window stops that piece.

The first time, Finder may warn a script is "from an unidentified
developer" — right-click the file and choose **Open** instead of
double-clicking, which gives you an explicit Open button past that warning.
If it still won't run, open Terminal, `cd` into that folder, and run `bash
start.command` — launching it that way skips the warning entirely.

**Manually, on any OS:**

```bash
cd server && npm install && npm start   # http://localhost:4790 (API only)
cd client && npm install && npm start   # http://localhost:4791 (the UI)
```

Open **http://localhost:4791** in a browser. On first launch, Settings asks
for the **PTZ server address** (e.g. `http://192.168.1.20:4790` — leave it
blank only if the client happens to be served from the same host as the
server) and the **camera's IP address** — or, since discovery runs
automatically, just pick the camera from the discovered list there. Default
camera credentials are `admin` / `admin` unless you've changed them in the
camera's own web UI.

To run either on a different port: `PORT=8080 npm start` (or `PORT=8080
./start.command`) in that folder.

To reach the client from your phone, use the server machine's LAN IP instead
of `localhost` when entering the server address, e.g.
`http://192.168.1.20:4790`, and open the client itself at
`http://<client-host>:4791` (or install it as a PWA — see below).

### Installing the client as an app

The client is a PWA — on a phone, open it in the browser and use "Add to
Home Screen" (iOS Safari) or "Install app" (Android Chrome) to get an
icon that launches it full-screen, no browser chrome. On desktop Chrome/Edge,
look for the install icon in the address bar.

### Native macOS apps (optional)

Both `server/` and `client/` can also be built into native `.app` bundles
via [Tauri](https://tauri.app), instead of running them with `npm start`:

```bash
cd client && npm run tauri:build   # produces a windowed PTZ Control.app
cd server && npm run tauri:build   # produces a menu-bar-only background app
```

This requires the Rust toolchain and Xcode Command Line Tools, and one-time
icon generation (`npx tauri icon path/to/logo-1024.png` in each folder —
see the `README.md` inside each `src-tauri/icons/` folder). The server's
native build packages the Node server as a self-contained binary, so end
users of the `.app` don't need Node installed at all; it runs quietly in the
menu bar with Start/Stop/Quit, no Dock icon.

## What it does

- **Pan/tilt** — the radial pad, or arrow keys. Press-and-hold moves the
  camera; release stops it. The ring around the pad lights up while it's
  moving.
- **Zoom / focus** — rocker switches, with independent speed sliders.
  `+`/`-` also zoom via keyboard.
- **Focus lock** — locks the current focus so nothing else can rack it.
- **Home** — recalls the camera's home position. **Recalibrate** runs the
  camera's own pan/tilt reset routine (it sweeps through its full range —
  there's a confirmation before it runs).
- **Presets** — 8 slots by default, each with an editable name and a
  thumbnail. "Save" writes the camera's current position to that slot and
  grabs a fresh snapshot as its thumbnail; "Go" recalls it. Presets (and
  their thumbnails) live on the server, keyed to preset slots on the camera
  itself (numbered 0–89 and 100–254), so they survive a server restart.
- **Live preview** — a smoothed feed pulled from the camera's RTSP stream
  via a bundled copy of ffmpeg (see Requirements above). Falls back
  automatically to a slower refreshing snapshot if ffmpeg is ever
  unavailable.
- **Settings** — the PTZ server's address, camera IP/ports/credentials, and
  which RTSP stream to preview (Stream 2 / SD is recommended — lower latency
  than the HD stream). "Test connection" checks camera reachability without
  leaving the panel.

## Finding the camera when its IP keeps changing

If the camera's on DHCP, its address can change any time it reboots or its
lease renews — so instead of trusting the saved IP, the server re-scans the
network every time the client loads:

- **ONVIF WS-Discovery** — a standard multicast probe that ONVIF devices
  answer directly with their current address. This camera line is ONVIF
  Profile S certified, so this is the main mechanism and works almost
  instantly.
- **An HTTP-CGI subnet scan** — asks every host on your local subnet for
  `get_device_conf`, which only a PTZOptics-family camera answers
  meaningfully. Slower (a few seconds), but doesn't depend on multicast
  making it across switches the way WS-Discovery does. Skipped automatically
  on subnets bigger than a /23, since brute-forcing a huge range isn't
  practical.

Results from both are merged and shown under Settings → **Discovered on your
network**, with a **Use** button on each.

The first time you pick a camera, its MAC address is remembered
(`knownMac` in `server/config.json`) — MACs don't change when DHCP hands out
a new IP. On every later load, if a discovered camera's MAC matches, the app
switches to its new address automatically, with a toast confirming the
reconnect — no clicks needed. If nothing matches and the saved address isn't
responding, Settings opens automatically with the current scan results so
you can pick manually.

## How it talks to the camera

All of this rides on PTZOptics' documented HTTP‑CGI API
(`http://<camera-ip>/cgi-bin/ptzctrl.cgi?ptzcmd&...`), the same interface
described at [docs.ptzoptics.com](https://docs.ptzoptics.com/dev/http-api/).
A couple of things worth knowing:

- **Auth**: the server tries each camera request unauthenticated first, and
  only sends credentials if the camera challenges it with a 401 (it handles
  both Basic and Digest, since different firmware versions use either).
- **Absolute/relative position recall** (jumping to an exact pan/tilt
  coordinate) is documented as **Move 4K / Link 4K only** — it isn't listed
  as supported on the Move SE, so it isn't wired up here. Presets cover the
  same need for this camera.
- **RTSP** paths are `rtsp://<camera-ip>:554/stream1` (HD) and `.../stream2`
  (SD) if you ever want to pull the feed into OBS, VLC, etc. directly.

## Where settings are stored

Camera IP, credentials, speeds, and preset names are saved to
`server/config.json` (created automatically on first run). It's plain JSON —
convenient for a personal local tool, but don't share this folder since it
holds your camera's password in plain text. Preset thumbnails are saved as
JPEGs under `server/data/thumbnails/`. The client's only persisted state is
the PTZ server address, stored in the browser's `localStorage` (so it's
per-device, not shared).

## A note on the bundled ffmpeg

The `@ffmpeg-installer/ffmpeg` package downloads a pre-built ffmpeg binary
for your platform — these third-party builds sometimes include GPL-licensed
components (this varies by OS/architecture). That has no practical effect
on using this app yourself; it would only matter if you redistributed this
project publicly, in which case it's worth checking that package's license
for the platform(s) you'd ship.

## Bluetooth controller (DS4, or any standard gamepad)

Pair the DualShock 4 to whatever computer or tablet is running the client —
this is done in the OS, not the web page:

1. Hold **Share + PS** until the light bar flashes rapidly (pairing mode).
2. Add it in your computer's Bluetooth settings like any other device.
3. Open the client in Chrome or Edge (most reliable Gamepad API support) and
   press any button on the controller — browsers only detect a gamepad after
   it receives input at least once.

The status strip under the header shows when it's connected. Default mapping:

| Input | Action |
|---|---|
| Left stick | Pan / tilt (proportional — push further for more speed) |
| Right stick (up/down) | Focus far / near |
| L2 / R2 | Zoom out / in (analog — press harder to zoom faster) |
| D-pad | Recall presets 1–4 |
| Square | Recall preset 5 |
| Cross (✕) | Stop |
| Circle | Home |
| Triangle | Toggle focus lock |
| L1 / R1 | Decrease / increase joystick sensitivity |
| Options | Open/close Settings |

This is plain browser code (`client/public/gamepad.js`) hitting the same
`/api/ptz/*` routes the on-screen controls use — no separate driver or
backend involved. If you'd rather remap any of it, that file is short and
the bindings are all in one place (`pollButtons` for buttons,
`pollMove`/`pollZoom`/`pollFocus` for the sticks and triggers).

Any other browser-standard gamepad works the same way, not just the DS4 —
Xbox controllers, for instance, use the same button layout underneath.

## Troubleshooting

- **"Offline" / can't reach the camera** — double check the IP in Settings,
  and that the server and camera are on the same network/VLAN. "Test
  connection" in Settings will tell you what happened (timeout vs.
  connection refused vs. wrong credentials).
- **Client can't reach the server / nothing loads** — check the "PTZ server
  address" field in Settings; it needs to be the server machine's LAN
  address and port (default `4790`), reachable from wherever the client is
  running.
- **Preview never goes live** — ffmpeg is bundled automatically, so this
  should be rare. It can happen if the server's `npm install` ran without
  internet access (the bundled ffmpeg couldn't download) or on an
  unsupported OS/architecture; either way, restarting with internet access
  and running `npm install` again (in `server/`) usually fixes it. Worst
  case, the app still works fine in the slower snapshot-preview mode.
- **Everything 401s** — the camera's HTTP API may be set to a non-default
  username/password; update them in Settings here to match.

## Project layout

```
server/
  server.js               Express app + all API routes
  lib/config.js            Reads/writes config.json
  lib/cameraClient.js       Builds HTTP-CGI requests, handles Basic/Digest auth
  lib/discovery.js          ONVIF WS-Discovery + HTTP-CGI subnet scan
  lib/mjpegProxy.js         Bundled-ffmpeg RTSP → MJPEG relay for live preview
  lib/thumbnails.js         Reads/writes preset thumbnail JPEGs
  scripts/build-sidecar.js  Packages server.js for the Tauri macOS build
  src-tauri/                Native macOS menu-bar app (runs the server as a sidecar)
  start.command             Double-clickable macOS launcher

client/
  serve.js                 Static file server (no build step)
  public/                   The browser/PWA UI — plain HTML/CSS/JS
  public/gamepad.js          Bluetooth/USB gamepad support (Gamepad API)
  public/serverBase.js       Stores the configured PTZ server address
  public/manifest.json       PWA manifest
  public/sw.js                Service worker (caches the app shell, never the API)
  src-tauri/                Native macOS windowed app wrapping the same UI
  start.command             Double-clickable macOS launcher
```

This is a personal, single-user tool with no login of its own — it's meant
to stay on your local network. If you ever want to reach it remotely, put it
behind a VPN rather than exposing either port directly.
