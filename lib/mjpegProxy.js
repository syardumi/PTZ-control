// Relays the camera's RTSP feed into the browser as a Motion-JPEG stream.
//
// Browsers can't play RTSP directly, so if ffmpeg is installed on this
// machine we spawn it to pull the camera's RTSP stream and re-encode it as
// a stream of JPEG frames, which we hand-wrap into a standard
// multipart/x-mixed-replace HTTP response — the same trick most DIY IP
// camera dashboards use. An <img> tag can display that directly.
//
// If ffmpeg isn't available, the frontend automatically falls back to
// polling the camera's own /snapshot.jpg endpoint instead (see app.js and
// server.js's /api/snapshot route) — slower, but needs nothing extra
// installed.

const { spawn } = require('child_process');
const { rtspUrl } = require('./cameraClient');

const BOUNDARY = 'ptzframe';
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

let ffmpegAvailableCache = null;

function checkFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return Promise.resolve(ffmpegAvailableCache);
  return new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version']);
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

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close'
  });

  const ffmpeg = spawn('ffmpeg', [
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

  let buffer = Buffer.alloc(0);
  let closed = false;

  ffmpeg.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

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

      if (!closed) {
        res.write(
          `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
        );
        res.write(frame);
        res.write('\r\n');
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
    if (!closed) {
      closed = true;
      try { res.end(); } catch (_) { /* client already gone */ }
    }
  });

  ffmpeg.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err.message);
    if (!closed) {
      closed = true;
      try { res.end(); } catch (_) { /* client already gone */ }
    }
  });

  req.on('close', () => {
    closed = true;
    ffmpeg.kill('SIGKILL');
  });
}

module.exports = { checkFfmpegAvailable, streamMjpeg };
