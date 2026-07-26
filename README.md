# Move SE Control Panel

A local-network web control panel for a **PTZOptics Move SE (PT20X‑SE‑xx‑G3)**
PTZ camera — pan/tilt/zoom, focus, presets, and a live preview, from any
browser on your network (phone, laptop, tablet).

It talks to the camera over the same HTTP‑CGI interface PTZOptics' own
joystick controllers and video software use, so nothing needs to be installed
on the camera itself.

## Requirements

- **Node.js 18+** (uses the built-in `fetch`)
- The camera and this server on the **same local network**
- *Optional:* **ffmpeg** on this machine, for a smooth live video feed. Without
  it, the preview still works, just as a refreshing snapshot (~1 frame/sec)
  instead of live video.

## Setup

**On macOS, the easy way:** double-click **`start.command`**. It checks for
Node (and ffmpeg), installs dependencies on first run, starts the server,
and opens your browser to it automatically. Closing that window stops the
server.

The first time, Finder may warn it's "from an unidentified developer" —
right-click the file and choose **Open** instead of double-clicking, which
gives you an explicit Open button past that warning. If it still won't run,
open Terminal, `cd` into this folder, and run `bash start.command` —
launching it that way skips the warning entirely.

**Manually, on any OS:**

```bash
npm install
npm start
```

Then open **http://localhost:4790** in a browser. On first launch it'll
prompt you for the camera's IP address (Settings → gear icon, top right) —
or, since discovery runs automatically, just pick it from the list there.
Default camera credentials are `admin` / `admin` unless you've changed them
in the camera's own web UI.

To run on a different port: `PORT=8080 npm start` (or `PORT=8080
./start.command`).

To reach it from your phone, use this machine's LAN IP instead of
`localhost`, e.g. `http://192.168.1.20:4790`.

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
- **Presets** — 8 slots by default, each with an editable name. "Save" writes
  the camera's current position to that slot; "Go" recalls it. Presets live
  on the camera itself (numbered 0–89 and 100–254), so they'll survive a
  server restart.
- **Live preview** — if `ffmpeg` is available, a smoothed feed pulled from
  the camera's RTSP stream. Otherwise it automatically falls back to
  polling the camera's built-in snapshot endpoint.
- **Settings** — camera IP, ports, credentials, and which RTSP stream to
  preview (Stream 2 / SD is recommended — lower latency than the HD stream).
  "Test connection" checks reachability without leaving the panel.

## Finding the camera when its IP keeps changing

If the camera's on DHCP, its address can change any time it reboots or its
lease renews — so instead of trusting the saved IP, the app re-scans the
network every time it loads:

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
(`knownMac` in `config.json`) — MACs don't change when DHCP hands out a new
IP. On every later load, if a discovered camera's MAC matches, the app
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

Camera IP, credentials, speeds, and preset names are saved to `config.json`
in this folder (created automatically on first run). It's plain JSON —
convenient for a personal local tool, but don't share this folder since it
holds your camera's password in plain text.

## Bluetooth controller (DS4, or any standard gamepad)

Pair the DualShock 4 to whatever computer or tablet is running the browser —
this is done in the OS, not the web page:

1. Hold **Share + PS** until the light bar flashes rapidly (pairing mode).
2. Add it in your computer's Bluetooth settings like any other device.
3. Open this page in Chrome or Edge (most reliable Gamepad API support) and
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

This is plain browser code (`public/gamepad.js`) hitting the same `/api/ptz/*`
routes the on-screen controls use — no separate driver or backend involved.
If you'd rather remap any of it, that file is short and the bindings are all
in one place (`pollButtons` for buttons, `pollMove`/`pollZoom`/`pollFocus` for
the sticks and triggers).

Any other browser-standard gamepad works the same way, not just the DS4 —
Xbox controllers, for instance, use the same button layout underneath.

## Troubleshooting

- **"Offline" / can't reach the camera** — double check the IP in Settings,
  and that both devices are on the same network/VLAN. "Test connection" in
  Settings will tell you what happened (timeout vs. connection refused vs.
  wrong credentials).
- **Preview never goes live** — if ffmpeg isn't installed, this is expected;
  you'll get the slower snapshot mode instead. Install ffmpeg
  (`brew install ffmpeg` / `apt install ffmpeg`) and restart the server for
  the smoother feed.
- **Everything 401s** — the camera's HTTP API may be set to a non-default
  username/password; update them in Settings here to match.

## Project layout

```
server.js              Express app + all API routes
lib/config.js           Reads/writes config.json
lib/cameraClient.js      Builds HTTP-CGI requests, handles Basic/Digest auth
lib/discovery.js         ONVIF WS-Discovery + HTTP-CGI subnet scan
lib/mjpegProxy.js        Optional ffmpeg RTSP → MJPEG relay for live preview
public/                  The browser UI (no build step — plain HTML/CSS/JS)
public/gamepad.js         Bluetooth/USB gamepad support (Gamepad API)
start.command            Double-clickable macOS launcher
```

This is a personal, single-user tool with no login of its own — it's meant
to stay on your local network. If you ever want to reach it remotely, put it
behind a VPN rather than exposing the port directly.
