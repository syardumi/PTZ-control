// Finds PTZOptics (and other ONVIF) cameras on the local network, since a
// camera on DHCP can land on a different address every time it reboots or
// its lease renews. Two methods run in parallel and get merged:
//
//  1. ONVIF WS-Discovery — a standard UDP multicast probe
//     (239.255.255.250:3702) that ONVIF-compliant devices answer directly.
//     This camera line is ONVIF Profile S certified, so this is the
//     "real" broadcast discovery mechanism and works instantly regardless
//     of subnet size.
//
//  2. An HTTP-CGI subnet scan — asks every host on this machine's local
//     /24-or-smaller subnet for `get_device_conf`, which only a
//     PTZOptics-family camera will answer meaningfully. Slower, and capped
//     to reasonably-sized subnets, but doesn't depend on multicast making
//     it across switches/routers the way WS-Discovery does.
//
// Either method alone can miss a camera in some network setups, so results
// from both are merged and de-duplicated by IP.

const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { fetchFromCamera } = require('./cameraClient');

const HTTP_SCAN_CONCURRENCY = 40;
const HTTP_SCAN_TIMEOUT_MS = 600;
const HTTP_SCAN_MAX_HOSTS = 512; // skip the HTTP scan on anything bigger than a /23
const ONVIF_WAIT_MS = 2500;
const ONVIF_MULTICAST_ADDR = '239.255.255.250';
const ONVIF_MULTICAST_PORT = 3702;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

function getLocalIPv4Subnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  for (const ifaceList of Object.values(nets)) {
    for (const net of ifaceList || []) {
      if (net.family === 'IPv4' && !net.internal) {
        subnets.push({ address: net.address, netmask: net.netmask });
      }
    }
  }
  return subnets;
}

// Every usable host address in a subnet, excluding the network and
// broadcast addresses. Returns [] for subnets too large to scan by brute
// force in a few seconds (ONVIF discovery still covers those).
function hostsInSubnet(address, netmask) {
  const addrInt = ipToInt(address);
  const maskInt = ipToInt(netmask);
  const network = addrInt & maskInt;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  const hostCount = broadcast - network - 1;
  if (hostCount <= 0 || hostCount > HTTP_SCAN_MAX_HOSTS) return [];
  const hosts = [];
  for (let i = network + 1; i < broadcast; i++) hosts.push(intToIp(i));
  return hosts;
}

function parseKeyValueText(text) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

async function probeHttpHost(ip, credentials) {
  try {
    const res = await fetchFromCamera(
      `http://${ip}/cgi-bin/param.cgi?get_device_conf`,
      credentials,
      {},
      HTTP_SCAN_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const info = parseKeyValueText(await res.text());
    if (!info.devname && !info.device_model && !info.versioninfo) return null;

    let mac = null;
    try {
      const netRes = await fetchFromCamera(
        `http://${ip}/cgi-bin/param.cgi?get_network_conf`,
        credentials,
        {},
        HTTP_SCAN_TIMEOUT_MS
      );
      if (netRes.ok) mac = parseKeyValueText(await netRes.text()).macaddr || null;
    } catch (_) { /* mac is a nice-to-have, not required */ }

    return {
      ip,
      mac,
      devname: info.devname || null,
      deviceModel: info.device_model ? info.device_model.trim() : null,
      onvifService: null,
      source: 'http-scan'
    };
  } catch (_) {
    return null;
  }
}

async function scanHttp(credentials) {
  const subnets = getLocalIPv4Subnets();
  const ownAddresses = new Set(subnets.map((s) => s.address));
  const allHosts = [...new Set(subnets.flatMap((s) => hostsInSubnet(s.address, s.netmask)))]
    .filter((ip) => !ownAddresses.has(ip));

  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < allHosts.length) {
      const ip = allHosts[cursor++];
      const result = await probeHttpHost(ip, credentials);
      if (result) found.push(result);
    }
  }
  const workerCount = Math.min(HTTP_SCAN_CONCURRENCY, allHosts.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return found;
}

function buildProbeMessage() {
  const uuid = crypto.randomUUID();
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>uuid:${uuid}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>' +
    '</e:Envelope>'
  );
}

function extractTag(text, tag) {
  const match = text.match(new RegExp(`<[\\w:]*${tag}>([^<]*)</[\\w:]*${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

function scanOnvif() {
  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch (_) {
      resolve([]);
      return;
    }

    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      const xaddrsField = extractTag(text, 'XAddrs');
      if (!xaddrsField) return;
      const xaddr = xaddrsField.split(/\s+/)[0];
      let ip;
      try { ip = new URL(xaddr).hostname; } catch (_) { return; }

      const scopes = extractTag(text, 'Scopes') || '';
      const nameMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/name\/(\S+)/i);
      const hwMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/hardware\/(\S+)/i);
      const label = nameMatch?.[1] || hwMatch?.[1] || null;

      found.set(ip, {
        ip,
        mac: null,
        devname: label ? decodeURIComponent(label.replace(/_/g, ' ')) : null,
        deviceModel: null,
        onvifService: xaddr,
        source: 'onvif'
      });
    });

    socket.on('error', () => resolve(Array.from(found.values())));

    socket.bind(() => {
      try {
        socket.send(buildProbeMessage(), ONVIF_MULTICAST_PORT, ONVIF_MULTICAST_ADDR);
      } catch (_) { /* still wait for the timeout below in case bind alone surfaces something */ }
    });

    setTimeout(() => {
      try { socket.close(); } catch (_) { /* already closed */ }
      resolve(Array.from(found.values()));
    }, ONVIF_WAIT_MS);
  });
}

function mergeResults(resultsList) {
  const merged = new Map();
  for (const r of resultsList) {
    const prev = merged.get(r.ip);
    if (!prev) {
      merged.set(r.ip, { ...r, sources: [r.source] });
      continue;
    }
    merged.set(r.ip, {
      ip: r.ip,
      mac: prev.mac || r.mac || null,
      devname: prev.devname || r.devname || null,
      deviceModel: prev.deviceModel || r.deviceModel || null,
      onvifService: prev.onvifService || r.onvifService || null,
      sources: [...new Set([...prev.sources, r.source])]
    });
  }
  return Array.from(merged.values());
}

// credentials: { username, password } tried against candidate hosts during
// the HTTP scan (falls back to the camera default admin/admin via the
// caller's config defaults). knownMac: the MAC of the camera last used, so
// results can be flagged as "this is probably your camera" across IP changes.
async function discoverCameras(credentials, knownMac) {
  const [onvifResults, httpResults] = await Promise.all([
    scanOnvif(),
    scanHttp(credentials)
  ]);

  return mergeResults([...onvifResults, ...httpResults]).map((cam) => ({
    ...cam,
    knownDevice: Boolean(knownMac && cam.mac && cam.mac.toLowerCase() === knownMac.toLowerCase())
  }));
}

module.exports = { discoverCameras };
