'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const collectFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(absolute) : [absolute];
  });

test('every app selector has a matching HTML id', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  const selectorPattern = /querySelector\(['"]#([^'"]+)['"]\)/g;
  const selectors = [...app.matchAll(selectorPattern)].map((match) => match[1]);

  assert.ok(selectors.length >= 15, 'expected the production UI selectors');
  for (const id of selectors) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('HTML ids are unique', () => {
  const ids = [...read('public/index.html').matchAll(/\sid=["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('vendored Guacamole client matches the reviewed asset', () => {
  const asset = fs.readFileSync(path.join(root, 'public/guacamole/all.min.js'));
  assert.equal(
    crypto.createHash('sha256').update(asset).digest('hex'),
    'cc89f710ecc544477dbe6bfea453fab752dafa1b1ab9770f523676e7b744b44a'
  );
});

test('gateway retains its loopback and token security controls', () => {
  const server = read('server.js');
  assert.match(server, /GUAC_WEB_HOST \|\| '127\.0\.0\.1'/);
  assert.match(server, /MAX_CONCURRENT_SESSIONS = 1/);
  assert.match(server, /MAX_WEBSOCKET_PAYLOAD = 256 \* 1024/);
  assert.match(server, /createHmac\('sha256'/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /hostname\.endsWith\('\.localhost'\)/);
  assert.match(server, /isPrivateIPv4/);
});

test('systemd units bind both services to loopback', () => {
  assert.match(read('deploy/guacd.service'), /-b 127\.0\.0\.1 -l 4822/);
  assert.match(read('deploy/guacamole-lite.service'), /--max-old-space-size=80/);
});

test('repository does not contain deployment-specific secrets or addresses', () => {
  const content = collectFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const deploymentAddress = ['192', '168', '1', '35'].join('.');
  const deploymentPassword = ['25', '02'].join('');

  assert.ok(!content.includes(deploymentAddress));
  assert.ok(!content.includes(deploymentPassword));
  assert.doesNotMatch(content, /\/Users\//);
  assert.doesNotMatch(content, /GUAC_TOKEN_KEY=[A-Za-z0-9+/]{20,}/);
  assert.doesNotMatch(content, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(content, /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/);
});

test('repository-facing text uses the English locale and no Vietnamese diacritics', () => {
  const content = collectFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const accentedLatin = /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u1e00-\u1eff]/u;
  const html = read('public/index.html');

  assert.match(html, /<html lang="en">/);
  assert.match(html, /styles\.css\?v=edge-2/);
  assert.match(html, /app\.js\?v=edge-2/);
  assert.doesNotMatch(content, accentedLatin);
});
