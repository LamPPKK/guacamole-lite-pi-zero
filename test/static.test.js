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

test('gateway retains its access, token, and target security controls', () => {
  const server = read('server.js');
  assert.match(server, /GUAC_WEB_HOST \|\| '127\.0\.0\.1'/);
  assert.match(server, /GUAC_ALLOWED_WEB_HOSTS/);
  assert.match(server, /GUAC_TOTP_SECRET/);
  assert.match(server, /AUTH_FAILURE_LIMIT = 5/);
  assert.match(server, /activeSessionSockets/);
  assert.match(server, /consumeConnectionAuthorization/);
  assert.match(server, /lastAcceptedTotpCounter/);
  assert.match(server, /MAX_CONCURRENT_SESSIONS = 1/);
  assert.match(server, /MAX_WEBSOCKET_PAYLOAD = 256 \* 1024/);
  assert.match(server, /createHmac\('sha256'/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /hostname\.endsWith\('\.localhost'\)/);
  assert.match(server, /isPrivateIPv4/);
  assert.match(server, /\['rdp', 'vnc', 'ssh'\]/);
});

test('systemd units bind both services to loopback', () => {
  assert.match(read('deploy/guacd.service'), /-b 127\.0\.0\.1 -l 4822/);
  assert.match(read('deploy/guacamole-lite.service'), /--max-old-space-size=80/);
  assert.match(read('scripts/install.sh'), /GUAC_WEB_HOST=127\.0\.0\.1/);
});

test('pinned guacd build and installer cover SSH, RDP, VNC, and protected VPN access', () => {
  const build = read('scripts/build-guacd.sh');
  const manifest = read('deploy/GUACD-BUILD-MANIFEST');
  const access = read('scripts/configure-access.sh');
  const install = read('scripts/install.sh');
  const enrollment = read('scripts/show-otp-qr.sh');
  const server = read('server.js');

  assert.match(build, /libpango1\.0-dev/);
  assert.match(build, /libssh2-1-dev/);
  assert.match(build, /freerdp3-dev/);
  assert.doesNotMatch(build, /libfreerdp3-dev/);
  assert.match(build, /fonts-dejavu-core/);
  assert.match(build, /--with-terminal/);
  assert.match(build, /--with-ssh/);
  assert.match(manifest, /protocols=ssh,rdp,vnc/);
  assert.match(access, /is_private_ipv4/);
  assert.match(access, /TOTP login/);
  assert.match(install, /openssl rand 20 \| base32/);
  assert.match(install, /show-otp-qr\.sh/);
  assert.doesNotMatch(install, /--vpn-user/);
  assert.match(enrollment, /otpauth:\/\/totp\/PI%20Remote%3AConsole/);
  assert.match(enrollment, /qrencode -t ANSIUTF8/);
  assert.match(enrollment, /printf '%s' "\$\{OTP_URI\}" \| qrencode/);
  assert.match(enrollment, /--allow-noninteractive/);
  assert.match(enrollment, /! -t 1/);
  assert.match(install, /TOTP_ENROLLMENT_CREATED.*-t 1/);
  assert.doesNotMatch(access, /GUAC_WEB_HOST=0\.0\.0\.0/);
  assert.match(install, /restore_install_backup/);
  assert.match(install, /DEPLOYMENT_TOUCHED/);
  assert.match(server, /Configured VPN address is unavailable; retrying/);
});

test('English UI exposes all protocols and responsive access states', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('public/styles.css');
  const loginForm = html.match(/<form id="login-form"[\s\S]*?<\/form>/)?.[0] || '';

  for (const protocol of ['ssh', 'rdp', 'vnc']) {
    assert.match(html, new RegExp(`<option value="${protocol}">`));
  }
  assert.match(html, /class="ssh-options ssh-only" hidden/);
  assert.match(html, /id="self-target" name="self" type="checkbox"/);
  assert.match(html, /This Pi/);
  assert.match(html, /name="hostKey"/);
  assert.match(loginForm, /name="code"/);
  assert.match(loginForm, /autocomplete="one-time-code"/);
  assert.doesNotMatch(loginForm, /name="username"|name="password"/);
  assert.match(app, /rdp: '3389', vnc: '5900', ssh: '22'/);
  assert.match(app, /values\.self = selfTargetInput\.checked/);
  assert.match(css, /\.self-target:focus-within/);
  assert.match(app, /VPN \+ TOTP/);
  assert.match(app, /sessionStorage\.setItem\(AUTH_STORAGE_KEY/);
  assert.match(app, /Authorization: `Bearer \$\{session\}`/);
  assert.match(app, /clearConnectionForm\(\)/);
  assert.match(css, /\.auth-submit:focus-visible/);
  assert.match(css, /@media \(max-width: 1040px\)/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /@media \(max-width: 380px\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('repository does not contain deployment-specific secrets or addresses', () => {
  const content = collectFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const deploymentAddress = ['192', '168', '1', '35'].join('.');
  const deploymentPassword = ['25', '02'].join('');

  assert.ok(!content.includes(deploymentAddress));
  assert.ok(!content.includes(deploymentPassword));
  assert.doesNotMatch(content, /\/Users\//);
  assert.doesNotMatch(content, /GUAC_TOKEN_KEY=[A-Za-z0-9+/]{20,}/);
  assert.doesNotMatch(content, /GUAC_TOTP_SECRET=[A-Z2-7]{32}/);
  assert.doesNotMatch(content, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(content, /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/);
});

test('repository-facing text uses the English locale and no Vietnamese diacritics', () => {
  const content = collectFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const accentedLatin = /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u1e00-\u1eff]/u;
  const html = read('public/index.html');

  assert.match(html, /<html lang="en">/);
  assert.match(html, /styles\.css\?v=edge-5/);
  assert.match(html, /app\.js\?v=edge-5/);
  assert.doesNotMatch(content, accentedLatin);
});
