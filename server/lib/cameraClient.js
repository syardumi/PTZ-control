// Talks to the camera's built-in HTTP-CGI API (the same interface PTZOptics'
// own joystick controllers and video software use), documented at
// https://docs.ptzoptics.com/dev/http-api/
//
// Commands look like:
//   http://<camera-ip>/cgi-bin/ptzctrl.cgi?ptzcmd&right&12&10
//   http://<camera-ip>/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&3
//
// The camera's web UI can optionally require a login (default admin/admin).
// Some firmware versions ask for Basic auth, others for Digest auth, and
// many local setups don't enforce auth on the CGI endpoints at all. Rather
// than guess, we try the request unauthenticated first, and only build
// credentials if the camera actually challenges us with a 401.

const crypto = require('crypto');

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

function parseAuthHeader(headerValue) {
  const scheme = headerValue.split(' ')[0];
  const fields = {};
  const attrPattern = /(\w+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = attrPattern.exec(headerValue)) !== null) {
    fields[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return { scheme, fields };
}

function buildDigestHeader({ username, password, method, uri, fields }) {
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${fields.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response;
  let qopPart = '';
  if (fields.qop) {
    const qop = fields.qop.split(',')[0].trim();
    response = md5(`${ha1}:${fields.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    qopPart = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${fields.nonce}:${ha2}`);
  }

  const opaquePart = fields.opaque ? `, opaque="${fields.opaque}"` : '';

  return (
    `Digest username="${username}", realm="${fields.realm}", ` +
    `nonce="${fields.nonce}", uri="${uri}"${qopPart}, response="${response}"${opaquePart}`
  );
}

const DEFAULT_TIMEOUT_MS = 5000;

// A camera that's misconfigured, powered off, or on a different subnet
// should fail fast rather than leave a request (and a browser button)
// hanging indefinitely.
function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Fetches a URL, transparently retrying with Basic or Digest auth if the
// camera challenges the first, unauthenticated attempt with a 401.
// `timeoutMs` is overridable because discovery scans dozens of hosts and
// needs to fail fast on the ones that aren't there, rather than waiting the
// full default timeout for each.
async function fetchFromCamera(url, { username, password } = {}, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let first;
  try {
    first = await fetchWithTimeout(url, options, timeoutMs);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out reaching the camera at ${new URL(url).host}.`);
    }
    throw new Error(`Could not reach the camera: ${err.message}`);
  }
  if (first.status !== 401 || !username) {
    return first;
  }

  const challenge = first.headers.get('www-authenticate');
  if (!challenge) return first;

  const { scheme, fields } = parseAuthHeader(challenge);
  const urlObj = new URL(url);
  const uri = urlObj.pathname + urlObj.search;

  let authHeader;
  if (/^basic$/i.test(scheme)) {
    authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else if (/^digest$/i.test(scheme)) {
    authHeader = `Digest ${buildDigestHeader({
      username,
      password,
      method: options.method || 'GET',
      uri,
      fields
    }).replace(/^Digest /, '')}`;
  } else {
    return first; // Unknown auth scheme, nothing more we can do
  }

  return fetchWithTimeout(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: authHeader }
  }, timeoutMs);
}

function baseUrl(config) {
  const port = config.httpPort && config.httpPort !== 80 ? `:${config.httpPort}` : '';
  return `http://${config.ip}${port}`;
}

// Sends a ptzctrl.cgi command, e.g. sendPtzCmd(config, ['right', 12, 10])
async function sendPtzCmd(config, parts) {
  if (!config.ip) {
    throw new Error('No camera IP configured yet — open Settings and enter one.');
  }
  const cmd = ['ptzcmd', ...parts].join('&');
  const url = `${baseUrl(config)}/cgi-bin/ptzctrl.cgi?${cmd}`;
  const res = await fetchFromCamera(url, config);
  if (!res.ok) {
    throw new Error(`Camera returned HTTP ${res.status} for ${cmd}`);
  }
  return res;
}

// Sends a param.cgi command, e.g. sendParamCmd(config, 'pan_tiltdrive_reset')
async function sendParamCmd(config, query) {
  if (!config.ip) {
    throw new Error('No camera IP configured yet — open Settings and enter one.');
  }
  const url = `${baseUrl(config)}/cgi-bin/param.cgi?${query}`;
  const res = await fetchFromCamera(url, config);
  if (!res.ok) {
    throw new Error(`Camera returned HTTP ${res.status} for ${query}`);
  }
  return res;
}

async function getSnapshot(config) {
  if (!config.ip) {
    throw new Error('No camera IP configured yet — open Settings and enter one.');
  }
  const url = `${baseUrl(config)}/snapshot.jpg`;
  const res = await fetchFromCamera(url, config);
  if (!res.ok) {
    throw new Error(`Camera returned HTTP ${res.status} for snapshot.jpg`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function rtspUrl(config, streamNumber) {
  const auth = config.username ? `${config.username}:${config.password}@` : '';
  return `rtsp://${auth}${config.ip}:${config.rtspPort}/stream${streamNumber}`;
}

module.exports = { sendPtzCmd, sendParamCmd, getSnapshot, rtspUrl, baseUrl, fetchFromCamera };
