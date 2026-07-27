const express = require('express');
const cors = require('cors');
const fs = require('fs');

const { readConfig, readConfigSafe, writeConfig } = require('./lib/config');
const { sendPtzCmd, sendParamCmd, getSnapshot, baseUrl } = require('./lib/cameraClient');
const { checkFfmpegAvailable, streamMjpeg } = require('./lib/mjpegProxy');
const { discoverCameras } = require('./lib/discovery');
const { ensureThumbnailsDir, thumbnailPath, thumbnailInfo } = require('./lib/thumbnails');

// This server is meant to stay running indefinitely on someone's Mac, so a
// single unexpected error anywhere (a stale connection while the preview is
// open, a network hiccup during discovery, etc.) should never be allowed to
// take the whole thing down. Node's default behavior for an uncaught
// exception or unhandled promise rejection is to exit the process — these
// log the problem instead and keep serving. Individual routes below still
// handle their own expected errors properly; this is just the last-resort
// net for anything that slips through.
process.on('uncaughtException', (err) => {
  console.error('Unexpected error (server staying up):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server staying up):', reason);
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4790;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json(readConfigSafe());
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  const update = {};

  if (typeof body.ip === 'string') update.ip = body.ip.trim();
  if (body.httpPort) update.httpPort = clamp(Number(body.httpPort), 1, 65535, 80);
  if (body.rtspPort) update.rtspPort = clamp(Number(body.rtspPort), 1, 65535, 554);
  if (typeof body.username === 'string') update.username = body.username;
  if (typeof body.password === 'string' && body.password.length > 0) update.password = body.password;
  if (body.previewStream) update.previewStream = body.previewStream === 1 ? 1 : 2;
  if (typeof body.knownMac === 'string') update.knownMac = body.knownMac;
  if (body.panSpeed) update.panSpeed = clamp(Number(body.panSpeed), 1, 24, 12);
  if (body.tiltSpeed) update.tiltSpeed = clamp(Number(body.tiltSpeed), 1, 20, 10);
  if (body.zoomSpeed) update.zoomSpeed = clamp(Number(body.zoomSpeed), 1, 7, 4);
  if (body.focusSpeed) update.focusSpeed = clamp(Number(body.focusSpeed), 1, 7, 4);

  const saved = writeConfig(update);
  const { password, ...safe } = saved;
  res.json({ ...safe, hasPassword: Boolean(password) });
});

// Lightweight reachability check for the "Online / Offline" pill in the header.
app.get('/api/status', async (req, res) => {
  const config = readConfig();
  if (!config.ip) {
    return res.json({ reachable: false, reason: 'not-configured' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const started = Date.now();
  try {
    const url = `${baseUrl(config)}/snapshot.jpg`;
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    res.json({ reachable: r.ok || r.status === 401, status: r.status, latencyMs: Date.now() - started });
  } catch (err) {
    clearTimeout(timeout);
    res.json({ reachable: false, reason: err.name === 'AbortError' ? 'timeout' : err.message });
  }
});

// Scans the local network for cameras — ONVIF WS-Discovery plus an
// HTTP-CGI subnet scan, merged together. Takes a few seconds; the camera's
// DHCP-assigned IP can change on its own, so the frontend calls this on
// every load rather than trusting the saved address blindly.
app.get('/api/discover', async (req, res) => {
  const config = readConfig();
  try {
    const cameras = await discoverCameras(
      { username: config.username, password: config.password },
      config.knownMac
    );
    res.json({ cameras });
  } catch (err) {
    res.status(500).json({ error: err.message, cameras: [] });
  }
});

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

app.get('/api/stream-info', async (req, res) => {
  res.json({ ffmpegAvailable: await checkFfmpegAvailable() });
});

app.get('/api/stream', async (req, res) => {
  const config = readConfig();
  if (!config.ip) return res.status(400).json({ error: 'Camera IP not configured.' });
  if (!(await checkFfmpegAvailable())) {
    return res.status(501).json({ error: 'ffmpeg is not installed on this server.' });
  }
  streamMjpeg(config, req, res);
});

app.get('/api/snapshot', async (req, res) => {
  const config = readConfig();
  try {
    const jpeg = await getSnapshot(config);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(jpeg);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pan / tilt
// ---------------------------------------------------------------------------

const MOVE_DIRECTIONS = new Set([
  'up', 'down', 'left', 'right', 'leftup', 'rightup', 'leftdown', 'rightdown'
]);

app.get('/api/ptz/move', async (req, res) => {
  const { direction } = req.query;
  if (!MOVE_DIRECTIONS.has(direction)) {
    return res.status(400).json({ error: `Unknown direction "${direction}".` });
  }
  const config = readConfig();
  const panSpeed = clamp(Number(req.query.panSpeed) || config.panSpeed, 1, 24, config.panSpeed);
  const tiltSpeed = clamp(Number(req.query.tiltSpeed) || config.tiltSpeed, 1, 20, config.tiltSpeed);
  try {
    await sendPtzCmd(config, [direction, panSpeed, tiltSpeed]);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ptz/stop', async (req, res) => {
  const config = readConfig();
  try {
    await sendPtzCmd(config, ['ptzstop']);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ptz/home', async (req, res) => {
  const config = readConfig();
  try {
    await sendPtzCmd(config, ['home']);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The camera's own "pan/tilt reset dance" — recalibrates its sense of center.
// Distinct from Home, which just moves to the home preset.
app.get('/api/ptz/reset', async (req, res) => {
  const config = readConfig();
  try {
    await sendParamCmd(config, 'pan_tiltdrive_reset');
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Zoom / focus
// ---------------------------------------------------------------------------

app.get('/api/ptz/zoom', async (req, res) => {
  const { direction } = req.query;
  if (!['in', 'out', 'stop'].includes(direction)) {
    return res.status(400).json({ error: `Unknown zoom direction "${direction}".` });
  }
  const config = readConfig();
  const speed = clamp(Number(req.query.speed) || config.zoomSpeed, 1, 7, config.zoomSpeed);
  const action = direction === 'stop' ? 'zoomstop' : `zoom${direction}`;
  const parts = direction === 'stop' ? [action] : [action, speed];
  try {
    await sendPtzCmd(config, parts);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ptz/focus', async (req, res) => {
  const { direction } = req.query;
  if (!['in', 'out', 'stop'].includes(direction)) {
    return res.status(400).json({ error: `Unknown focus direction "${direction}".` });
  }
  const config = readConfig();
  const speed = clamp(Number(req.query.speed) || config.focusSpeed, 1, 7, config.focusSpeed);
  const action = direction === 'stop' ? 'focusstop' : `focus${direction}`;
  const parts = direction === 'stop' ? [action] : [action, speed];
  try {
    await sendPtzCmd(config, parts);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ptz/focus-lock', async (req, res) => {
  const locked = req.query.locked === 'true';
  const config = readConfig();
  try {
    await sendParamCmd(config, `ptzcmd&${locked ? 'lock' : 'unlock'}_mfocus`);
    res.json({ ok: true, locked });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

app.get('/api/presets', (req, res) => {
  const presets = readConfig().presets || [];
  res.json(presets.map((p) => {
    const info = thumbnailInfo(p.id);
    return { ...p, hasThumbnail: info.exists, thumbnailVersion: info.mtimeMs };
  }));
});

app.post('/api/presets/:id', (req, res) => {
  const id = Number(req.params.id);
  const label = typeof req.body.label === 'string' ? req.body.label.slice(0, 40) : null;
  const config = readConfig();
  const presets = (config.presets || []).map((p) => (p.id === id ? { ...p, label: label ?? p.label } : p));
  writeConfig({ presets });
  res.json({ ok: true });
});

// Serves the JPEG captured the last time this preset was saved (see
// /api/ptz/preset/save below). Not embedded in /api/presets' JSON so that
// route stays cheap to poll.
app.get('/api/presets/:id/thumbnail', (req, res) => {
  const id = validatePresetId(req.params.id, res);
  if (id === null) return;
  const info = thumbnailInfo(id);
  if (!info.exists) {
    return res.status(404).json({ error: `No thumbnail saved for preset ${id} yet.` });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(thumbnailPath(id)).pipe(res);
});

app.get('/api/ptz/preset/save', async (req, res) => {
  const id = validatePresetId(req.query.id, res);
  if (id === null) return;
  const config = readConfig();
  try {
    await sendPtzCmd(config, ['posset', id]);
    let thumbnailSaved = false;
    try {
      const jpeg = await getSnapshot(config);
      ensureThumbnailsDir();
      fs.writeFileSync(thumbnailPath(id), jpeg);
      thumbnailSaved = true;
    } catch (thumbErr) {
      console.error(`Preset ${id} saved, but capturing its thumbnail failed:`, thumbErr.message);
    }
    res.json({ ok: true, thumbnailSaved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ptz/preset/recall', async (req, res) => {
  const id = validatePresetId(req.query.id, res);
  if (id === null) return;
  const config = readConfig();
  try {
    await sendPtzCmd(config, ['poscall', id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max, fallback) {
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function validatePresetId(raw, res) {
  const id = Number(raw);
  const inRange = (id >= 0 && id <= 89) || (id >= 100 && id <= 254);
  if (Number.isNaN(id) || !inRange) {
    res.status(400).json({ error: 'Preset id must be 0-89 or 100-254.' });
    return null;
  }
  return id;
}

app.listen(PORT, () => {
  console.log(`PTZ camera control panel running at http://localhost:${PORT}`);
  const config = readConfig();
  if (!config.ip) {
    console.log('No camera IP set yet — open the app and use Settings to add one.');
  }
});
