# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-network control panel for a PTZOptics Move SE PTZ camera —
pan/tilt/zoom, focus, presets with thumbnails, and live preview. It's a
personal, single-user tool meant to stay on a local network (no auth of its
own). It talks to the camera over PTZOptics' documented HTTP-CGI interface,
the same one the vendor's own joystick controllers use.

It's split into two independent apps, each with its own `package.json`:

- **`server/`** — talks to the camera, owns all state (settings, presets,
  thumbnails), exposes the `/api/*` HTTP API. This is the piece that needs
  to be on the same network as the camera.
- **`client/`** — the UI (browser/PWA, no framework), talks to `server/`'s
  API over `fetch`. Can run on a different machine than the server.

Both can also be packaged as native macOS apps via Tauri (`src-tauri/` in
each folder) — see "Tauri builds" below — but the plain Node path is the
primary way to run and develop both.

## Commands

```bash
# server (camera-facing API)
cd server && npm install && npm start   # :4790, override with PORT=xxxx

# client (UI)
cd client && npm install && npm start   # :4791, override with PORT=xxxx
```

No build step, lint config, or test suite in either folder — `client/public/`
is served as-is (plain HTML/CSS/JS, no bundler). Both `start` scripts are the
only automated entry points.

## Architecture

**`server/server.js`** is an Express app exposing `/api/*` routes, with CORS
enabled (`app.use(cors())`) since the client is a separate origin/port. It no
longer serves any static files — that's the client's job now. Camera
interaction is delegated to `server/lib/`:

- `lib/config.js` — reads/writes `config.json` (git-ignored, created on
  first run) holding camera IP, credentials, speeds, and preset labels.
  `readConfigSafe()` strips the password before anything goes to the
  client. Every route re-reads config fresh rather than caching it, since
  Settings can change it at any time.
- `lib/cameraClient.js` — builds HTTP-CGI requests
  (`ptzctrl.cgi?ptzcmd&...`, `param.cgi?...`). Requests are tried
  unauthenticated first, then retried with Basic or Digest auth only if the
  camera responds 401 — different firmware versions enforce auth
  differently, so this avoids hardcoding an assumption either way.
- `lib/discovery.js` — finds the camera's current IP via ONVIF
  WS-Discovery (multicast, near-instant) plus an HTTP-CGI subnet scan
  (slower fallback, skipped above a /23). This exists because the camera is
  usually on DHCP, so its IP can change on any reboot; the client calls
  `/api/discover` on every load rather than trusting the saved IP. The
  camera's MAC (`knownMac` in config) is used to recognize it again after
  its IP changes.
- `lib/mjpegProxy.js` — relays the camera's RTSP stream to MJPEG over HTTP
  via the bundled `@ffmpeg-installer/ffmpeg` binary, for the live preview.
  Falls back to slower still-snapshot polling if ffmpeg isn't available. Its
  ffmpeg path can be overridden via `PTZ_FFMPEG_PATH` — needed by the Tauri
  sidecar build, which can't rely on the npm package being present.
- `lib/thumbnails.js` — reads/writes JPEG thumbnails at
  `server/data/thumbnails/preset-<id>.jpg` (git-ignored). One flat file per
  preset slot, overwritten on every save — no cleanup logic needed. A
  file's `mtimeMs` doubles as its cache-busting version, returned as
  `thumbnailVersion` from `/api/presets`.

**`client/public/`** has no build step or framework:

- `app.js` — main UI logic. Every backend call is prefixed with
  `getServerBase()` (from `serverBase.js`) rather than being same-origin —
  this is what lets the client be served from anywhere and still reach the
  server. `renderPresets()` also renders each preset's thumbnail `<img>`.
- `gamepad.js` — Bluetooth/USB gamepad support (Gamepad API), hitting the
  same `/api/ptz/*` routes as the on-screen controls via `fireAndForget()`,
  also prefixed with `getServerBase()`.
- `serverBase.js` — the only piece of client-side persisted state: the PTZ
  server's address, stored in `localStorage` (works the same in a plain
  browser and inside a Tauri webview, which has no server session to fall
  back on).
- `manifest.json` / `sw.js` — PWA install support. The service worker
  caches the static app shell only; its `fetch` handler explicitly skips
  `/api/*` and any cross-origin request, since camera control must always
  hit the live server.

**Known camera API constraints** (see also the README's "How it talks to
the camera" section):
- Absolute/relative pan-tilt position recall is documented as Move 4K/Link
  4K only and isn't supported on the Move SE, so it's intentionally not
  wired up — presets cover that need instead.
- Preset IDs are 0–89 and 100–254 (validated in `server.js` via
  `validatePresetId`, reused by both the preset-CRUD and thumbnail routes).

## Tauri builds (native macOS)

`client/src-tauri/` wraps the same `client/public/` assets in a windowed
native app (`frontendDist` points straight at `../public`, no bundler). CSP
is disabled since the client needs to `fetch()` whatever LAN server address
the user configures at runtime.

`server/src-tauri/` is a menu-bar-only app (`LSUIElement` in `Info.plist`,
`app.windows: []`) that runs the actual Node server as a Tauri *sidecar*
process rather than reimplementing it in Rust. `server/scripts/build-sidecar.js`
compiles `server.js` into a standalone executable via `@yao-pkg/pkg` and
copies the local bundled ffmpeg binary alongside it, both named per Rust's
target-triple convention (`ptz-server-<triple>`, `ffmpeg-<triple>`) so
Tauri's `externalBin` can find them; this script must run on a Mac to
produce the ffmpeg half (the pkg cross-compile step itself works from any
OS). Both `src-tauri/icons/` folders start empty — see the `README.md`
inside each for the one-time `npx tauri icon` step required before
`tauri build` will succeed.

This repo's dev/build environment may not be macOS — Tauri's `cargo
build`/`tauri build`/`tauri dev` can only be verified on an actual Mac.

## Notes for changes

- `server/config.json` holds the camera password in plaintext by design
  (it's a personal local tool); never log it or send it to the client
  un-stripped — follow the existing `readConfigSafe()` pattern.
- Routes that hit the camera return `502` on failure (camera unreachable)
  vs `400` for invalid input — keep that distinction when adding routes.
- `server.js` installs top-level `uncaughtException`/`unhandledRejection`
  handlers because this is meant to run indefinitely unattended; don't let
  new code reintroduce a path that could crash the process on a routine
  network hiccup.
- Any new backend call added to `client/public/app.js` or `gamepad.js` must
  be prefixed with `getServerBase()` — a bare `fetch('/api/...')` will
  silently break once the client isn't same-origin with the server (the
  common case).
