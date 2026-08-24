'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const GuacamoleLite = require('guacamole-lite');

const WEB_HOST = process.env.GUAC_WEB_HOST || '127.0.0.1';
const WEB_PORT = parsePort(process.env.GUAC_WEB_PORT, 8080);
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = parsePort(process.env.GUACD_PORT, 4822);
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_SESSIONS = 1;
const MAX_WEBSOCKET_PAYLOAD = 256 * 1024;
const VPN_BIND_RETRY_MS = 5 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_KEY = loadTokenKey();
const ALLOWED_WEB_HOSTS = loadAllowedWebHosts();
const BASIC_AUTH = loadBasicAuth();
const ACCESS_MODE = isLoopbackBind(WEB_HOST) ? 'ssh-tunnel' : 'vpn';
const TOKEN_MAC_KEY = crypto.hkdfSync(
  'sha256', TOKEN_KEY, Buffer.alloc(0), Buffer.from('guacamole-lite-token-mac'), 32
);

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/guacamole/all.min.js', ['guacamole/all.min.js', 'application/javascript; charset=utf-8']]
]);

function parsePort(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function loadTokenKey() {
  const encoded = process.env.GUAC_TOKEN_KEY;
  if (!encoded) throw new Error('GUAC_TOKEN_KEY is required');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('GUAC_TOKEN_KEY must be exactly 32 bytes encoded as base64');
  }
  return key;
}

function isLoopbackBind(hostname) {
  return hostname === '127.0.0.1';
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1'
    || hostname === 'localhost'
    || hostname.endsWith('.localhost');
}

function loadAllowedWebHosts() {
  const configured = process.env.GUAC_ALLOWED_WEB_HOSTS || '127.0.0.1,localhost';
  const hosts = configured.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0 || hosts.length > 16) {
    throw new Error('GUAC_ALLOWED_WEB_HOSTS must contain between 1 and 16 hosts');
  }
  for (const host of hosts) {
    if (!isLoopbackHostname(host) && !isPrivateIPv4(host)) {
      throw new Error(`Invalid allowed web host: ${host}`);
    }
  }
  return new Set(hosts);
}

function loadBasicAuth() {
  const username = process.env.GUAC_BASIC_AUTH_USER || '';
  const digestHex = process.env.GUAC_BASIC_AUTH_SHA256 || '';
  if (!username && !digestHex) return null;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(username) || !/^[a-fA-F0-9]{64}$/.test(digestHex)) {
    throw new Error('GUAC_BASIC_AUTH_USER and GUAC_BASIC_AUTH_SHA256 must both be valid');
  }
  return { username, digest: Buffer.from(digestHex, 'hex') };
}

function validateAccessConfiguration() {
  if (!isLoopbackBind(WEB_HOST)) {
    if (!isPrivateIPv4(WEB_HOST)) {
      throw new Error('GUAC_WEB_HOST must be loopback or one exact private/CGNAT IPv4 address');
    }
    if (!ALLOWED_WEB_HOSTS.has(WEB_HOST.toLowerCase())) {
      throw new Error('GUAC_ALLOWED_WEB_HOSTS must include GUAC_WEB_HOST');
    }
    if (!BASIC_AUTH) {
      throw new Error('Basic authentication is required when GUAC_WEB_HOST is not loopback');
    }
  }
}

function isPrivateIPv4(hostname) {
  if (net.isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split('.').map(Number);
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('Invalid text field');
  }
  return text;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function encryptToken(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', TOKEN_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(asciiSafeJson(payload), 'utf8'),
    cipher.final()
  ]);

  const ivBase64 = iv.toString('base64');
  const valueBase64 = encrypted.toString('base64');

  return Buffer.from(JSON.stringify({
    iv: ivBase64,
    value: valueBase64,
    mac: tokenMac(ivBase64, valueBase64).toString('base64')
  })).toString('base64');
}

function asciiSafeJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uFFFF]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

function tokenMac(iv, value) {
  return crypto.createHmac('sha256', TOKEN_MAC_KEY).update(`${iv}.${value}`).digest();
}

function decryptToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 16 * 1024) {
    throw new Error('Invalid token');
  }

  const envelope = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  if (!envelope || typeof envelope.iv !== 'string'
      || typeof envelope.value !== 'string' || typeof envelope.mac !== 'string') {
    throw new Error('Invalid token envelope');
  }

  const iv = Buffer.from(envelope.iv, 'base64');
  const encrypted = Buffer.from(envelope.value, 'base64');
  const receivedMac = Buffer.from(envelope.mac, 'base64');
  const expectedMac = tokenMac(envelope.iv, envelope.value);
  if (iv.length !== 16 || encrypted.length === 0 || encrypted.length % 16 !== 0
      || receivedMac.length !== expectedMac.length
      || !crypto.timingSafeEqual(receivedMac, expectedMac)) {
    throw new Error('Invalid token authentication');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', TOKEN_KEY, iv);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isAllowedHostHeader(req) {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/'
        || parsed.search || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase();
    return isLoopbackHostname(hostname) || ALLOWED_WEB_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  if (!BASIC_AUTH) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 4096) return false;
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header);
  if (!match) return false;
  let credentials;
  try {
    credentials = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  if (!credentials.startsWith(`${BASIC_AUTH.username}:`)) return false;
  const digest = crypto.createHash('sha256').update(credentials).digest();
  return crypto.timingSafeEqual(digest, BASIC_AUTH.digest);
}

function requireAuthorization(req, res) {
  if (isAuthorized(req)) return true;
  const body = Buffer.from(JSON.stringify({ error: 'Authentication required' }));
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="PI Remote", charset="UTF-8"',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
  return false;
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildConnection(body) {
  const protocol = ['rdp', 'vnc', 'ssh'].includes(body.protocol) ? body.protocol : null;
  if (!protocol) throw new Error('Protocol must be rdp, vnc, or ssh');

  const hostname = cleanText(body.hostname, 64).trim();
  if (!isPrivateIPv4(hostname)) {
    throw new Error('Target must be a private IPv4 address');
  }

  const defaultPorts = { rdp: 3389, vnc: 5900, ssh: 22 };
  const port = parsePort(body.port, defaultPorts[protocol]);
  const width = clampInteger(body.width, 1280, 640, 2560);
  const height = clampInteger(body.height, 720, 480, 1600);
  const dpi = clampInteger(body.dpi, 96, 72, 192);
  const username = cleanText(body.username, 128);
  const password = cleanText(body.password, 512);

  const settings = {
    hostname,
    port: String(port),
    username,
    password,
    width: String(width),
    height: String(height),
    dpi: String(dpi),
    audio: [],
    video: null,
    image: ['image/png', 'image/jpeg']
  };

  if (protocol === 'rdp') {
    settings.domain = cleanText(body.domain, 128);
    settings.security = ['any', 'nla', 'tls', 'rdp'].includes(body.security)
      ? body.security
      : 'any';
    settings['ignore-cert'] = true;
    settings['enable-wallpaper'] = false;
    settings['enable-font-smoothing'] = true;
    settings['disable-audio'] = true;
  } else if (protocol === 'vnc') {
    settings['color-depth'] = '16';
    settings['disable-audio'] = true;
  } else {
    settings['host-key'] = cleanText(body.hostKey, 8192).trim();
    settings['font-name'] = 'monospace';
    settings['font-size'] = '12';
    settings['color-scheme'] = 'gray-black';
    settings['terminal-type'] = 'xterm-256color';
    settings.scrollback = '1000';
    settings['server-alive-interval'] = '60';
    settings['enable-sftp'] = false;
  }

  return {
    expiration: Date.now() + TOKEN_TTL_MS,
    connection: { type: protocol, settings }
  };
}

function validateConnectionSettings(settings) {
  const now = Date.now();
  if (!settings || !Number.isSafeInteger(settings.expiration)
      || settings.expiration <= now + 1000 || settings.expiration > now + TOKEN_TTL_MS + 5000) {
    throw new Error('Token expired or has an invalid expiration');
  }
  const connection = settings.connection;
  if (!connection || !['rdp', 'vnc', 'ssh'].includes(connection.type)) {
    throw new Error('Unsupported protocol');
  }
  if (!connection.settings || !isPrivateIPv4(connection.settings.hostname)) {
    throw new Error('Target is outside the private network');
  }
  const defaultPorts = { rdp: 3389, vnc: 5900, ssh: 22 };
  parsePort(connection.settings.port, defaultPorts[connection.type]);
  delete connection.guacdHost;
  delete connection.guacdPort;
  return settings;
}

function validateDecryptedSettings(settings, callback) {
  try {
    callback(null, validateConnectionSettings(settings));
  } catch (error) {
    callback(error);
  }
}

async function guacdHealth() {
  if (GUACD_HOST !== '127.0.0.1') return false;
  const address = `0100007F:${GUACD_PORT.toString(16).toUpperCase().padStart(4, '0')}`;
  try {
    const sockets = await fs.promises.readFile('/proc/net/tcp', 'utf8');
    return sockets.split('\n').slice(1).some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1] === address && fields[3] === '0A';
    });
  } catch {
    return false;
  }
}

function serveStatic(req, res, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [filename, contentType] = entry;
  const absolutePath = path.join(PUBLIC_DIR, filename);

  fs.stat(absolutePath, (error, stat) => {
    if (error || !stat.isFile()) {
      writeJson(res, 404, { error: 'Asset not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': pathname === '/' ? 'no-store' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(absolutePath).pipe(res);
  });
  return true;
}

validateAccessConfiguration();

const server = http.createServer(async (req, res) => {
  if (!isAllowedHostHeader(req)) {
    writeJson(res, 421, { error: 'Allowed Host header required' });
    return;
  }
  if (!requireAuthorization(req, res)) {
    return;
  }
  const requestUrl = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
    const guacd = await guacdHealth();
    writeJson(res, guacd ? 200 : 503, {
      status: guacd ? 'ok' : 'degraded',
      guacd,
      accessMode: ACCESS_MODE
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/token') {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { error: 'Origin rejected' });
      return;
    }
    try {
      const payload = buildConnection(await readJson(req));
      writeJson(res, 200, { token: encryptToken(payload), expiresIn: TOKEN_TTL_MS / 1000 });
    } catch (error) {
      writeJson(res, 400, { error: error.message });
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, requestUrl.pathname)) return;
  writeJson(res, 404, { error: 'Not found' });
});

const websocketOptions = {
  server,
  clientTracking: false,
  maxPayload: MAX_WEBSOCKET_PAYLOAD,
  verifyClient: ({ origin, req }) => {
    if (!isAllowedHostHeader(req) || !isAuthorized(req)) return false;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch {
        return false;
      }
    }

    try {
      if (acceptedSessions >= MAX_CONCURRENT_SESSIONS) return false;
      const requestUrl = new URL(req.url, 'http://localhost');
      const tokens = requestUrl.searchParams.getAll('token');
      if (tokens.length !== 1) return false;
      validateConnectionSettings(decryptToken(tokens[0]));
      acceptedSessions += 1;
      let released = false;
      req.socket.once('close', () => {
        if (released) return;
        released = true;
        acceptedSessions = Math.max(0, acceptedSessions - 1);
      });
      return true;
    } catch {
      return false;
    }
  }
};

let acceptedSessions = 0;
const guacServer = new GuacamoleLite(
  websocketOptions,
  { host: GUACD_HOST, port: GUACD_PORT },
  {
    crypt: { cypher: 'AES-256-CBC', key: TOKEN_KEY },
    log: { level: 'NORMAL' },
    allowedUnencryptedConnectionSettings: { rdp: [], vnc: [], ssh: [], join: [] }
  },
  { processConnectionSettings: validateDecryptedSettings }
);

// ws mirrors HTTP listener errors onto its own server. Keep that mirror from
// becoming an uncaught EventEmitter error; the HTTP server handler below owns
// bind retry and fatal-listener behavior.
guacServer.webSocketServer.on('error', () => {});

guacServer.on('error', (_connection, error) => {
  console.error('Guacamole connection error:', error?.message || error);
});

let bindRetryTimer = null;
let shuttingDown = false;

function listenGateway() {
  if (!shuttingDown) server.listen(WEB_PORT, WEB_HOST);
}

server.on('listening', () => {
  console.log(`Guacamole Lite listening on http://${WEB_HOST}:${WEB_PORT}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRNOTAVAIL' && ACCESS_MODE === 'vpn' && !shuttingDown) {
    console.error(`Configured VPN address is unavailable; retrying in ${VPN_BIND_RETRY_MS / 1000} seconds`);
    bindRetryTimer = setTimeout(listenGateway, VPN_BIND_RETRY_MS);
    return;
  }
  console.error('Guacamole Lite listener error:', error?.message || error);
  process.exit(1);
});

listenGateway();

function shutdown() {
  shuttingDown = true;
  if (bindRetryTimer) clearTimeout(bindRetryTimer);
  if (server.listening) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { buildConnection, isPrivateIPv4, isLoopbackBind };
