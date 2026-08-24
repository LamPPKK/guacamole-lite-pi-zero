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
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAILURE_LIMIT = 5;
const MAX_AUTH_SESSIONS = 8;
const MAX_AUTH_FAILURE_IDENTITIES = 256;
const MAX_PENDING_CONNECTIONS = 16;
const MAX_CONCURRENT_SESSIONS = 1;
const MAX_WEBSOCKET_PAYLOAD = 256 * 1024;
const VPN_BIND_RETRY_MS = 5 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_KEY = loadTokenKey();
const TOTP_SECRET = loadTotpSecret();
const ALLOWED_WEB_HOSTS = loadAllowedWebHosts();
const ACCESS_MODE = isLoopbackBind(WEB_HOST) ? 'ssh-tunnel' : 'vpn';
const TOKEN_MAC_KEY = crypto.hkdfSync(
  'sha256', TOKEN_KEY, Buffer.alloc(0), Buffer.from('guacamole-lite-token-mac'), 32
);
const SESSION_HASH_KEY = crypto.hkdfSync(
  'sha256', TOKEN_KEY, Buffer.alloc(0), Buffer.from('guacamole-lite-web-session'), 32
);
const authSessions = new Map();
const authFailures = new Map();
const pendingConnections = new Map();
const activeSessionSockets = new Map();
let lastAcceptedTotpCounter = -1;

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

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index === -1) throw new Error('GUAC_TOTP_SECRET must use unpadded Base32');
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

function loadTotpSecret() {
  const encoded = process.env.GUAC_TOTP_SECRET || '';
  if (!/^[A-Z2-7]{32}$/.test(encoded)) {
    throw new Error('GUAC_TOTP_SECRET must be a 20-byte secret encoded as 32 Base32 characters');
  }
  const secret = decodeBase32(encoded);
  if (secret.length !== 20) throw new Error('GUAC_TOTP_SECRET must decode to exactly 20 bytes');
  return secret;
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

function validateAccessConfiguration() {
  if (!isLoopbackBind(WEB_HOST)) {
    if (!isPrivateIPv4(WEB_HOST)) {
      throw new Error('GUAC_WEB_HOST must be loopback or one exact private/CGNAT IPv4 address');
    }
    if (!ALLOWED_WEB_HOSTS.has(WEB_HOST.toLowerCase())) {
      throw new Error('GUAC_ALLOWED_WEB_HOSTS must include GUAC_WEB_HOST');
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

function isAllowedTarget(protocol, hostname, port) {
  return isPrivateIPv4(hostname)
    || (protocol === 'ssh' && hostname === '127.0.0.1' && port === 22);
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

function totpCode(counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', TOTP_SECRET).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(binary).padStart(6, '0');
}

function verifyTotp(code, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const currentCounter = Math.floor(now / 30000);
  let matchingCounter = -1;
  const received = Buffer.from(code);
  for (let offset = -1; offset <= 1; offset += 1) {
    const counter = currentCounter + offset;
    const expected = Buffer.from(totpCode(counter));
    if (crypto.timingSafeEqual(received, expected)) matchingCounter = counter;
  }
  if (matchingCounter <= lastAcceptedTotpCounter) return false;
  lastAcceptedTotpCounter = matchingCounter;
  return matchingCounter >= 0;
}

function bearerValue(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 4096) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return match ? match[1] : null;
}

function sessionHash(value) {
  return crypto.createHmac('sha256', SESSION_HASH_KEY).update(value).digest('hex');
}

function pruneSessions(now = Date.now()) {
  for (const [hash, session] of authSessions) {
    if (session.expiration <= now) revokeSession(hash);
  }
}

function authorizedSessionHash(req, now = Date.now()) {
  const value = bearerValue(req);
  if (!value) return null;
  const hash = sessionHash(value);
  const session = authSessions.get(hash);
  if (!session || session.expiration <= now) {
    if (session) revokeSession(hash);
    return null;
  }
  return hash;
}

function isAuthorized(req, now = Date.now()) {
  return authorizedSessionHash(req, now) !== null;
}

function removeActiveSocket(sessionHashValue, socket) {
  const sockets = activeSessionSockets.get(sessionHashValue);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) activeSessionSockets.delete(sessionHashValue);
}

function revokeSession(hash) {
  const session = authSessions.get(hash);
  if (session) clearTimeout(session.expirationTimer);
  authSessions.delete(hash);
  for (const [tokenHashValue, grant] of pendingConnections) {
    if (grant.sessionHash === hash) pendingConnections.delete(tokenHashValue);
  }
  const sockets = activeSessionSockets.get(hash);
  activeSessionSockets.delete(hash);
  if (sockets) {
    for (const socket of sockets) socket.destroy();
  }
}

function issueSession(now = Date.now()) {
  pruneSessions(now);
  while (authSessions.size >= MAX_AUTH_SESSIONS) {
    revokeSession(authSessions.keys().next().value);
  }
  const value = crypto.randomBytes(32).toString('base64url');
  const hash = sessionHash(value);
  const expiration = now + AUTH_SESSION_TTL_MS;
  const expirationTimer = setTimeout(() => revokeSession(hash), AUTH_SESSION_TTL_MS);
  expirationTimer.unref();
  authSessions.set(hash, { expiration, expirationTimer });
  return value;
}

function destroySession(req) {
  const hash = authorizedSessionHash(req);
  if (hash) revokeSession(hash);
}

function connectionTokenHash(token) {
  return crypto.createHmac('sha256', SESSION_HASH_KEY).update(`connection.${token}`).digest('hex');
}

function authorizeConnectionToken(token, sessionHashValue, now = Date.now()) {
  for (const [hash, grant] of pendingConnections) {
    const session = authSessions.get(grant.sessionHash);
    if (grant.expiration <= now || !session || session.expiration <= now) {
      if (session?.expiration <= now) revokeSession(grant.sessionHash);
      pendingConnections.delete(hash);
    }
  }
  while (pendingConnections.size >= MAX_PENDING_CONNECTIONS) {
    pendingConnections.delete(pendingConnections.keys().next().value);
  }
  pendingConnections.set(connectionTokenHash(token), {
    sessionHash: sessionHashValue,
    expiration: now + TOKEN_TTL_MS
  });
}

function consumeConnectionAuthorization(token, now = Date.now()) {
  const hash = connectionTokenHash(token);
  const grant = pendingConnections.get(hash);
  const session = grant ? authSessions.get(grant.sessionHash) : null;
  if (!grant || grant.expiration <= now || !session || session.expiration <= now) {
    if (session?.expiration <= now) revokeSession(grant.sessionHash);
    pendingConnections.delete(hash);
    return null;
  }
  pendingConnections.delete(hash);
  return grant.sessionHash;
}

function requestIdentity(req) {
  return req.socket.remoteAddress || 'unknown';
}

function authThrottle(identity, now = Date.now()) {
  const recent = (authFailures.get(identity) || []).filter(
    (timestamp) => timestamp > now - AUTH_FAILURE_WINDOW_MS
  );
  if (recent.length === 0) authFailures.delete(identity);
  else authFailures.set(identity, recent);
  if (recent.length < AUTH_FAILURE_LIMIT) return 0;
  return Math.max(1, Math.ceil((recent[0] + AUTH_FAILURE_WINDOW_MS - now) / 1000));
}

function recordAuthFailure(identity, now = Date.now()) {
  const recent = (authFailures.get(identity) || []).filter(
    (timestamp) => timestamp > now - AUTH_FAILURE_WINDOW_MS
  );
  recent.push(now);
  if (!authFailures.has(identity) && authFailures.size >= MAX_AUTH_FAILURE_IDENTITIES) {
    authFailures.delete(authFailures.keys().next().value);
  }
  authFailures.set(identity, recent.slice(-AUTH_FAILURE_LIMIT));
}

function requireAuthorization(req, res) {
  const hash = authorizedSessionHash(req);
  if (hash) return hash;
  writeJson(res, 401, { error: 'Access code required' });
  return null;
}

function writeJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
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

  const defaultPorts = { rdp: 3389, vnc: 5900, ssh: 22 };
  const selfTarget = protocol === 'ssh' && (body.self === true || body.self === 'true');
  const hostname = selfTarget ? '127.0.0.1' : cleanText(body.hostname, 64).trim();
  const port = selfTarget ? 22 : parsePort(body.port, defaultPorts[protocol]);
  if (!isAllowedTarget(protocol, hostname, port)) {
    throw new Error('Target must be a private IPv4 address or This Pi SSH');
  }
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
  if (!connection.settings) {
    throw new Error('Target is outside the private network');
  }
  const defaultPorts = { rdp: 3389, vnc: 5900, ssh: 22 };
  const port = parsePort(connection.settings.port, defaultPorts[connection.type]);
  if (!isAllowedTarget(connection.type, connection.settings.hostname, port)) {
    throw new Error('Target is outside the private network');
  }
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

  if (req.method === 'GET' && requestUrl.pathname === '/api/auth/status') {
    writeJson(res, 200, { authenticated: isAuthorized(req) });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/auth') {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { error: 'Origin rejected' });
      return;
    }
    const identity = requestIdentity(req);
    const retryAfter = authThrottle(identity);
    if (retryAfter > 0) {
      writeJson(res, 429, { error: 'Too many attempts. Try again shortly.' }, {
        'Retry-After': String(retryAfter)
      });
      return;
    }
    try {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!verifyTotp(code)) {
        recordAuthFailure(identity);
        writeJson(res, 401, { error: 'Invalid or expired access code' });
        return;
      }
      authFailures.delete(identity);
      const session = issueSession();
      writeJson(res, 200, {
        authenticated: true,
        session,
        expiresIn: AUTH_SESSION_TTL_MS / 1000
      });
    } catch {
      recordAuthFailure(identity);
      writeJson(res, 400, { error: 'Invalid authentication request' });
    }
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/logout') {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { error: 'Origin rejected' });
      return;
    }
    destroySession(req);
    writeJson(res, 200, { authenticated: false });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/token') {
    const sessionHashValue = requireAuthorization(req, res);
    if (!sessionHashValue) return;
    if (!sameOrigin(req)) {
      writeJson(res, 403, { error: 'Origin rejected' });
      return;
    }
    try {
      const payload = buildConnection(await readJson(req));
      const token = encryptToken(payload);
      authorizeConnectionToken(token, sessionHashValue);
      writeJson(res, 200, { token, expiresIn: TOKEN_TTL_MS / 1000 });
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
    if (!isAllowedHostHeader(req)) return false;
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
      const sessionHashValue = consumeConnectionAuthorization(tokens[0]);
      if (!sessionHashValue) return false;
      acceptedSessions += 1;
      const sockets = activeSessionSockets.get(sessionHashValue) || new Set();
      sockets.add(req.socket);
      activeSessionSockets.set(sessionHashValue, sockets);
      let released = false;
      req.socket.once('close', () => {
        if (released) return;
        released = true;
        removeActiveSocket(sessionHashValue, req.socket);
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
