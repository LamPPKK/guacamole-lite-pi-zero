'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const tokenKey = Buffer.alloc(32, 7);
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const totpKey = Buffer.from('12345678901234567890');

function totpCodeForCounter(counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', totpKey).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(binary).padStart(6, '0');
}

function totpCode(now = Date.now()) {
  return totpCodeForCounter(Math.floor(now / 30000));
}

function definitelyInvalidTotp(now = Date.now()) {
  const counter = Math.floor(now / 30000);
  const accepted = new Set([-2, -1, 0, 1, 2].map(
    (offset) => totpCodeForCounter(counter + offset)
  ));
  for (let candidate = 0; candidate < 1000000; candidate += 1) {
    const code = String(candidate).padStart(6, '0');
    if (!accepted.has(code)) return code;
  }
  throw new Error('Unable to construct an invalid TOTP fixture');
}

test('TOTP fixture matches the RFC 6238 SHA-1 truncation vector', () => {
  assert.equal(totpCode(59000), '287082');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { Host: `127.0.0.1:${port}`, ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startGateway(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      GUAC_WEB_HOST: '127.0.0.1',
      GUAC_WEB_PORT: String(port),
      GUACD_HOST: '127.0.0.1',
      GUACD_PORT: '65534',
      GUAC_TOKEN_KEY: tokenKey.toString('base64'),
      GUAC_TOTP_SECRET: totpSecret,
      GUAC_ALLOWED_WEB_HOSTS: '127.0.0.1,localhost',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (${child.exitCode}): ${stderr}`);
    }
    try {
      const response = await request(port);
      return { child, port, output: () => ({ stdout, stderr }) };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill('SIGTERM');
  throw new Error(`gateway did not start: ${stderr}`);
}

async function authenticate(port, code = totpCode()) {
  const response = await request(port, {
    method: 'POST',
    pathname: '/api/auth',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`
    },
    body: JSON.stringify({ code })
  });
  assert.equal(response.status, 200, response.body);
  assert.equal(response.headers['set-cookie'], undefined);
  const result = JSON.parse(response.body);
  assert.equal(result.authenticated, true);
  assert.equal(result.expiresIn, 43200);
  assert.match(result.session, /^[A-Za-z0-9_-]{43}$/);
  return result.session;
}

function stopGateway(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function decryptToken(token) {
  const envelope = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc', tokenKey, Buffer.from(envelope.iv, 'base64')
  );
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.value, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function websocketResult(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket result timed out'));
    }, 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve({ opened: true });
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve({ opened: false, status: response.statusCode });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket open timed out'));
    }, 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForSocketClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket was not closed when its login session was revoked'));
    }, 3000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startTcpSink() {
  const port = await freePort();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    })
  };
}

test('gateway issues a bounded SSH token and rejects unsafe targets and hosts', async (t) => {
  const gateway = await startGateway();
  t.after(() => stopGateway(gateway.child));
  const session = await authenticate(gateway.port);

  const tokenResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'ssh',
      hostname: '192.168.1.20',
      port: '',
      username: 'developer',
      password: 'temporary-secret',
      hostKey: '192.168.1.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest'
    })
  });
  assert.equal(tokenResponse.status, 200);
  const tokenBody = JSON.parse(tokenResponse.body);
  assert.equal(tokenBody.expiresIn, 300);

  const payload = decryptToken(tokenBody.token);
  assert.equal(payload.connection.type, 'ssh');
  assert.equal(payload.connection.settings.hostname, '192.168.1.20');
  assert.equal(payload.connection.settings.port, '22');
  assert.equal(payload.connection.settings['terminal-type'], 'xterm-256color');
  assert.equal(payload.connection.settings['server-alive-interval'], '60');
  assert.match(payload.connection.settings['host-key'], /^192\.168\.1\.20 ssh-ed25519 /);
  assert.ok(payload.expiration > Date.now());
  assert.ok(payload.expiration <= Date.now() + 305000);

  const publicTarget = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'ssh', hostname: '8.8.8.8' })
  });
  assert.equal(publicTarget.status, 400);

  const thisPiResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'ssh', self: true, hostname: '8.8.8.8', port: '65535', username: 'pi'
    })
  });
  assert.equal(thisPiResponse.status, 200);
  const thisPiPayload = decryptToken(JSON.parse(thisPiResponse.body).token);
  assert.equal(thisPiPayload.connection.type, 'ssh');
  assert.equal(thisPiPayload.connection.settings.hostname, '127.0.0.1');
  assert.equal(thisPiPayload.connection.settings.port, '22');

  for (const unsafeLoopback of [
    { protocol: 'rdp', hostname: '127.0.0.1', port: '3389' },
    { protocol: 'vnc', hostname: '127.0.0.1', port: '5900' },
    { protocol: 'ssh', hostname: '127.0.0.1', port: '2222' }
  ]) {
    const response = await request(gateway.port, {
      method: 'POST',
      pathname: '/api/token',
      headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(unsafeLoopback)
    });
    assert.equal(response.status, 400);
  }

  const badHost = await request(gateway.port, { headers: { Host: 'evil.example' } });
  assert.equal(badHost.status, 421);
  const userinfoHost = await request(gateway.port, { headers: { Host: 'attacker@127.0.0.1' } });
  assert.equal(userinfoHost.status, 421);
  const output = gateway.output();
  assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /temporary-secret/);
});

test('passwordless TOTP login protects token and WebSocket access', async (t) => {
  const guacd = await startTcpSink();
  t.after(() => guacd.close());
  const gateway = await startGateway({ GUACD_PORT: String(guacd.port) });
  t.after(() => stopGateway(gateway.child));

  const page = await request(gateway.port);
  assert.equal(page.status, 200);
  assert.match(page.body, /Enter your access code/);
  assert.doesNotMatch(page.body, /name="username"[^>]*auth/i);

  const statusBefore = await request(gateway.port, { pathname: '/api/auth/status' });
  assert.deepEqual(JSON.parse(statusBefore.body), { authenticated: false });
  const unauthenticatedToken = await request(gateway.port, {
    method: 'POST', pathname: '/api/token', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'rdp', hostname: '10.0.0.10' })
  });
  assert.equal(unauthenticatedToken.status, 401);

  const validCode = totpCode();
  const wrongCode = definitelyInvalidTotp();
  const crossOrigin = await request(gateway.port, {
    method: 'POST', pathname: '/api/auth',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ code: validCode })
  });
  assert.equal(crossOrigin.status, 403);
  const wrong = await request(gateway.port, {
    method: 'POST', pathname: '/api/auth', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: wrongCode })
  });
  assert.equal(wrong.status, 401);

  const session = await authenticate(gateway.port, validCode);
  const statusAfter = await request(gateway.port, {
    pathname: '/api/auth/status', headers: { Authorization: `Bearer ${session}` }
  });
  assert.deepEqual(JSON.parse(statusAfter.body), { authenticated: true });

  const replay = await request(gateway.port, {
    method: 'POST', pathname: '/api/auth', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: validCode })
  });
  assert.equal(replay.status, 401);

  const tokenResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'rdp', hostname: '10.0.0.10' })
  });
  assert.equal(tokenResponse.status, 200);
  const token = JSON.parse(tokenResponse.body).token;

  const unauthenticatedSocket = await websocketResult(
    `ws://127.0.0.1:${gateway.port}/?token=not-a-server-authorized-token`
  );
  assert.deepEqual(unauthenticatedSocket, { opened: false, status: 401 });

  const authenticatedSocket = await openWebSocket(
    `ws://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(token)}`
  );
  const socketClosed = waitForSocketClose(authenticatedSocket);

  const pendingResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'vnc', hostname: '10.0.0.11' })
  });
  assert.equal(pendingResponse.status, 200);
  const pendingToken = JSON.parse(pendingResponse.body).token;

  const logout = await request(gateway.port, {
    method: 'POST', pathname: '/api/logout',
    headers: { Authorization: `Bearer ${session}` }
  });
  assert.equal(logout.status, 200);
  await socketClosed;

  const consumedToken = await websocketResult(
    `ws://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(token)}`
  );
  assert.deepEqual(consumedToken, { opened: false, status: 401 });
  const revokedPendingToken = await websocketResult(
    `ws://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(pendingToken)}`
  );
  assert.deepEqual(revokedPendingToken, { opened: false, status: 401 });
  const expiredSession = await request(gateway.port, {
    method: 'POST', pathname: '/api/token',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'rdp', hostname: '10.0.0.10' })
  });
  assert.equal(expiredSession.status, 401);
});

test('gateway fails closed without a valid TOTP enrollment secret', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      GUAC_WEB_HOST: '192.168.123.45',
      GUAC_WEB_PORT: String(await freePort()),
      GUAC_ALLOWED_WEB_HOSTS: '127.0.0.1,localhost,192.168.123.45',
      GUAC_TOKEN_KEY: tokenKey.toString('base64'),
      GUAC_TOTP_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /GUAC_TOTP_SECRET must be a 20-byte secret/);
});

test('TOTP login rate limits repeated invalid codes', async (t) => {
  const gateway = await startGateway();
  t.after(() => stopGateway(gateway.child));
  const wrongCode = definitelyInvalidTotp();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(gateway.port, {
      method: 'POST', pathname: '/api/auth', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode })
    });
    assert.equal(response.status, 401);
  }
  const limited = await request(gateway.port, {
    method: 'POST', pathname: '/api/auth', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: wrongCode })
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('authenticated VPN mode waits for a late bind address instead of exiting', async (t) => {
  const assigned = new Set(Object.values(os.networkInterfaces()).flat()
    .filter((address) => address?.family === 'IPv4')
    .map((address) => address.address));
  const vpnAddress = ['10.255.255.254', '172.31.255.254', '192.168.255.254', '100.127.255.254']
    .find((address) => !assigned.has(address));
  assert.ok(vpnAddress, 'expected an unassigned private test address');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      GUAC_WEB_HOST: vpnAddress,
      GUAC_WEB_PORT: String(await freePort()),
      GUAC_ALLOWED_WEB_HOSTS: `127.0.0.1,localhost,${vpnAddress}`,
      GUAC_TOKEN_KEY: tokenKey.toString('base64'),
      GUAC_TOTP_SECRET: totpSecret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => stopGateway(child));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 3000;
  while (!stderr.includes('Configured VPN address is unavailable') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(child.exitCode, null);
  assert.match(stderr, /Configured VPN address is unavailable; retrying in 5 seconds/);
});
