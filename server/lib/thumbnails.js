// Stores one JPEG thumbnail per preset slot on disk, captured automatically
// whenever a preset is saved (see server.js's /api/ptz/preset/save route).
// Preset ids are fixed slots that get overwritten on every save, so there's
// never any cleanup to do here — a new save just replaces the old file.

const fs = require('fs');
const path = require('path');

const THUMBNAILS_DIR = path.join(__dirname, '..', 'data', 'thumbnails');

function ensureThumbnailsDir() {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

function thumbnailPath(id) {
  return path.join(THUMBNAILS_DIR, `preset-${id}.jpg`);
}

// mtimeMs doubles as a cache-busting version number for the client — no
// separate metadata file needed to track when a thumbnail last changed.
function thumbnailInfo(id) {
  try {
    const stat = fs.statSync(thumbnailPath(id));
    return { exists: true, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch (_) {
    return { exists: false, mtimeMs: null };
  }
}

module.exports = { THUMBNAILS_DIR, ensureThumbnailsDir, thumbnailPath, thumbnailInfo };
