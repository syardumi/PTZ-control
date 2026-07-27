// Loads, validates, and persists camera connection settings to config.json
// so the person can change the camera's IP/credentials from the Settings
// panel in the browser without touching any code.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  ip: '',
  httpPort: 80,
  rtspPort: 554,
  username: 'admin',
  password: 'admin',
  previewStream: 2, // 1 = HD stream, 2 = SD stream (lower latency, easier to preview)
  knownMac: null, // MAC address of the camera last selected, so discovery can recognize it after its IP changes
  panSpeed: 12, // 1-24
  tiltSpeed: 10, // 1-20
  zoomSpeed: 4, // 1-7
  focusSpeed: 4, // 1-7
  presets: [
    { id: 1, label: 'Preset 1' },
    { id: 2, label: 'Preset 2' },
    { id: 3, label: 'Preset 3' },
    { id: 4, label: 'Preset 4' },
    { id: 5, label: 'Preset 5' },
    { id: 6, label: 'Preset 6' },
    { id: 7, label: 'Preset 7' },
    { id: 8, label: 'Preset 8' }
  ]
};

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
  }
}

function readConfig() {
  ensureConfigFile();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    console.error('Failed to read config.json, falling back to defaults:', err.message);
    return { ...DEFAULTS };
  }
}

function writeConfig(next) {
  const current = readConfig();
  const merged = { ...current, ...next };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Returns config with the password removed and replaced with a boolean flag,
// so the browser never has to display (or re-submit) the stored secret.
function readConfigSafe() {
  const cfg = readConfig();
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: Boolean(password) };
}

module.exports = { readConfig, writeConfig, readConfigSafe, CONFIG_PATH };
