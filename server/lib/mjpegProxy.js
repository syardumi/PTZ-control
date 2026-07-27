// Relays the camera's RTSP feed into the browser as a Motion-JPEG stream.
//
// Browsers can't play RTSP directly, so we spawn ffmpeg to pull the
// camera's RTSP stream and re-encode it as a stream of JPEG frames, which
// we hand-wrap into a standard multipart/x-mixed-replace HTTP response —
// the same trick most DIY IP camera dashboards use. An <img> tag can
// display that directly.
//
// ffmpeg itself comes from the @ffmpeg-installer/ffmpeg npm package, which
// `npm install` downloads automatically for whatever OS/architecture this
// machine is — nothing to install separately. If that package somehow
// isn't available (e.g. an unsupported platform), this falls back to a
// system `ffmpeg` on PATH if there is one; failing that, the frontend
// automatically falls back further to polling the camera's own
// /snapshot.jpg endpoint instead (see app.js and server.js's /api/snapshot
// route) — slower, but always available.

const { spawn } = require('child_process');
const { rtspUrl } = require('./cameraClient');

const BOUNDARY = 'ptzframe';
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function resolveFfmpegPath() {
  // Sidecar builds (see the Tauri server app) bundle ffmpeg as a separate
  // binary alongside the packaged server and point us at it via this env
  // var, since @ffmpeg-installer/ffmpeg isn't available inside a pkg binary.
  if (process.env.PTZ_FFMPEG_PATH) return process.env.PTZ_FFMPEG_PATH;
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch (_) {
    return 'ffmpeg'; // hope for one on PATH instead
  }
}

const FFMPEG_PATH = resolveFfmpegPath();

let ffmpegAvailableCache = null;

function checkFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return Promise.resolve(ffmpegAvailableCache);
  return new Promise((resolve) => {
    const probe = spawn(FFMPEG_PATH, ['-version']);
    probe.on('error', () => {
      ffmpegAvailableCache = false;
      resolve(false);
    });
    probe.on('close', (code) => {
      ffmpegAvailableCache = code === 0;
      resolve(ffmpegAvailableCache);
    });
  });
}

// Streams MJPEG frames to an HTTP response for as long as the client stays
// connected. Kills ffmpeg the moment the browser disconnects.
function streamMjpeg(config, req, res) {
  const source = rtspUrl(config, config.previewStream || 2);

  let buffer = Buffer.alloc(0);
  let closed = false;

  const ffmpeg = spawn(FFMPEG_PATH, [
    '-rtsp_transport', 'tcp',
    '-timeout', '5000000', // microseconds; fail fast if the camera is unreachable
    '-i', source,
    '-an',
    '-f', 'mjpeg',
    '-q:v', '5',
    '-r', '10',
    '-vf', 'scale=1024:-2',
    'pipe:1'
  ]);

  function stop() {
    if (closed) return;
    closed = true;
    try { ffmpeg.kill('SIGKILL'); } catch (_) { /* already gone */ }
    try { res.end(); } catch (_) { /* client already gone */ }
  }

  // A stale connection (laptop went to sleep, browser throttled a
  // background tab, a router hiccup) surfaces here as a write error. The
  // default behavior for an unhandled error on a stream is to crash the
  // process, so this listener is what keeps that from taking the whole
  // server down.
  res.on('error', stop);

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close'
  });

  ffmpeg.stdout.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);

    // A well-formed MJPEG stream should never accumulate more than one
    // frame's worth of unmatched data; if it does (a corrupt stream, or a
    // JPEG marker that never resolves), drop it rather than growing this
    // buffer without bound.
    if (buffer.length > 8 * 1024 * 1024) {
      buffer = Buffer.alloc(0);
      return;
    }

    // Pull out every complete JPEG frame currently sitting in the buffer.
    for (;;) {
      const start = buffer.indexOf(JPEG_SOI);
      if (start === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      const end = buffer.indexOf(JPEG_EOI, start + 2);
      if (end === -1) break; // frame not fully received yet

      const frame = buffer.subarray(start, end + 2);
      buffer = buffer.subarray(end + 2);

      if (closed) break;
      try {
        res.write(
          `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
        );
        res.write(frame);
        res.write('\r\n');
      } catch (_) {
        stop();
        break;
      }
    }
  });

  // ffmpeg logs its normal progress output to stderr; only surface it if
  // the process actually fails, to keep the server's console readable.
  let stderrTail = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`ffmpeg preview process exited with code ${code}:\n${stderrTail}`);
    }
    stop();
  });

  ffmpeg.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err.message);
    stop();
  });

  req.on('close', stop);
}

module.exports = { checkFfmpegAvailable, streamMjpeg };
