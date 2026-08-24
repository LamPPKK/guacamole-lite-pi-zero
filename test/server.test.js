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

test('gateway issues a bounded SSH token and rejects unsafe targets and hosts', async (t) => {
  const gateway = await startGateway();
  t.after(() => stopGateway(gateway.child));

  const tokenResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'ssh', hostname: '8.8.8.8' })
  });
  assert.equal(publicTarget.status, 400);

  const thisPiResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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

test('HTTP Basic Auth protects pages and API requests when configured', async (t) => {
  const username = 'pi-remote';
  const password = 'correct-horse-battery-staple';
  const digest = crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
  const gateway = await startGateway({
    GUAC_BASIC_AUTH_USER: username,
    GUAC_BASIC_AUTH_SHA256: digest
  });
  t.after(() => stopGateway(gateway.child));

  const challenge = await request(gateway.port);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers['www-authenticate'], /^Basic realm="PI Remote"/);

  const wrong = await request(gateway.port, {
    headers: { Authorization: `Basic ${Buffer.from(`${username}:wrong`).toString('base64')}` }
  });
  assert.equal(wrong.status, 401);

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const page = await request(gateway.port, { headers: { Authorization: authorization } });
  assert.equal(page.status, 200);
  assert.match(page.body, /SSH — Terminal/);

  const tokenResponse = await request(gateway.port, {
    method: 'POST',
    pathname: '/api/token',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'rdp', hostname: '10.0.0.10' })
  });
  assert.equal(tokenResponse.status, 200);
  const token = JSON.parse(tokenResponse.body).token;

  const unauthenticatedSocket = await websocketResult(
    `ws://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(token)}`
  );
  assert.deepEqual(unauthenticatedSocket, { opened: false, status: 401 });

  const authenticatedSocket = await websocketResult(
    `ws://127.0.0.1:${gateway.port}/?token=${encodeURIComponent(token)}`,
    { Authorization: authorization }
  );
  assert.equal(authenticatedSocket.opened, true);
});

test('non-loopback web binding fails closed without Basic Auth', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      GUAC_WEB_HOST: '192.168.123.45',
      GUAC_WEB_PORT: String(await freePort()),
      GUAC_ALLOWED_WEB_HOSTS: '127.0.0.1,localhost,192.168.123.45',
      GUAC_TOKEN_KEY: tokenKey.toString('base64'),
      GUAC_BASIC_AUTH_USER: '',
      GUAC_BASIC_AUTH_SHA256: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Basic authentication is required/);
});

test('authenticated VPN mode waits for a late bind address instead of exiting', async (t) => {
  const assigned = new Set(Object.values(os.networkInterfaces()).flat()
    .filter((address) => address?.family === 'IPv4')
    .map((address) => address.address));
  const vpnAddress = ['10.255.255.254', '172.31.255.254', '192.168.255.254', '100.127.255.254']
    .find((address) => !assigned.has(address));
  assert.ok(vpnAddress, 'expected an unassigned private test address');

  const username = 'pi-remote';
  const password = 'boot-wait-test-password';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      GUAC_WEB_HOST: vpnAddress,
      GUAC_WEB_PORT: String(await freePort()),
      GUAC_ALLOWED_WEB_HOSTS: `127.0.0.1,localhost,${vpnAddress}`,
      GUAC_TOKEN_KEY: tokenKey.toString('base64'),
      GUAC_BASIC_AUTH_USER: username,
      GUAC_BASIC_AUTH_SHA256: crypto.createHash('sha256')
        .update(`${username}:${password}`).digest('hex')
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
