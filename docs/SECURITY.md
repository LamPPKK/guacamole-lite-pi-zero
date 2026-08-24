# Security model

## Trust boundary

By default, ports 8080 and 4822 both bind to `127.0.0.1`. SSH provides
authentication and encryption from the workstation to the Pi. Optional VPN
mode moves only port 8080 to one exact RFC1918/CGNAT address already assigned
to the Pi. Both modes require a passwordless TOTP session before token creation
or WebSocket access.
Port 4822 always remains on loopback. The Pi-to-target leg is a separate SSH,
RDP, or VNC connection and is not inside the workstation-to-Pi tunnel.

Do not change either unit or environment file to bind `0.0.0.0`. VPN mode has
no built-in TLS and is safe only when the underlying private VPN encrypts the
transport. It is not a substitute for an authenticated TLS reverse proxy when
publishing a service on the public Internet.

## Connection controls

- Only `ssh`, `rdp`, and `vnc` are accepted.
- A target must be a literal IPv4 address in `10/8`, `172.16/12`,
  `192.168/16`, or `100.64/10`. The gateway does not resolve hostnames, which
  reduces DNS-rebinding risk.
- The only loopback target exception is SSH on exactly `127.0.0.1:22`. The
  **This Pi** request is normalized server-side, so client-supplied host and
  port values cannot turn it into a general loopback proxy. RDP, VNC, and other
  SSH loopback ports remain blocked.
- Port, display dimensions, DPI, and text-field lengths are bounded.
- Token requests require same-origin when a browser supplies an `Origin`.
- The Host header must be loopback, a `.localhost` name, or an explicitly
  configured private VPN address.
- A non-loopback bind fails unless its exact private/CGNAT address is allowed.
- The token API requires a valid TOTP session. Each WebSocket connection token
  is bound server-side to that session and can be consumed only once. Static UI
  assets, authentication endpoints, and the minimal health endpoint remain
  reachable before login.
- WebSocket tokens are validated before a connection reaches `guacd`. Logout,
  fixed-lifetime expiry, or session eviction destroys any active socket and
  removes its unused connection tokens.
- One session is accepted at a time, and WebSocket payloads are limited to
  256 KiB.

## Authenticator login

The installer generates a random 160-bit TOTP secret and stores it in the
root-only environment file. An interactive first installation displays it once
as a standard `otpauth://` QR code plus a manual setup key. Non-interactive
output is refused by default so CI and provisioning logs do not capture the
credential. The login implements RFC 6238 using HMAC-SHA1, six digits, and a
30-second time step. It accepts one adjacent time step on either side for clock
drift, but a successfully used counter cannot log in a second time before the
service restarts.

Five failed attempts from one source address trigger a five-minute sliding
rate limit. A successful code creates a random 256-bit opaque session with a
12-hour fixed lifetime. At most eight login sessions are retained in memory.
The browser keeps its bearer value in the current tab's origin-scoped
`sessionStorage` and sends it only in an `Authorization` header. This avoids
the port-blind scope of HTTP cookies: another service on the same hostname but
a different port does not receive the session automatically. The strict CSP,
local-only scripts, no-referrer policy, and no third-party assets reduce script
exposure. All sessions disappear when the service restarts.

The code is the only web-login factor, not a second factor layered on a
password. It should therefore be described as passwordless TOTP rather than
true two-factor authentication.

## Target credentials and connection tokens

The browser sends target credentials over loopback inside the SSH tunnel or
through the encrypted private VPN. The gateway creates a 300-second token
using AES-256-CBC with a random IV and authenticates the complete envelope
with HMAC-SHA256. HKDF derives the MAC key from the encryption key. The MAC is
checked with a constant-time comparison before decryption.

A token briefly exists in browser memory and in the WebSocket URL. Do not
share DevTools screenshots or proxy logs that include query strings. The
runtime secret is generated during installation and is never stored in this
repository.

## Explicit limitations

- Port 8080 does not provide TLS itself; encryption for workstation-to-Pi web
  traffic comes from the SSH tunnel or the pre-existing private VPN. A script
  executing in this exact origin could read the tab session, so preserving the
  CSP and serving no untrusted or third-party scripts is part of the security
  boundary.
- The gateway sets `ignore-cert=true` for RDP so self-signed certificates
  work. It therefore does not authenticate the RDP server through its
  certificate. VNC transport may be unencrypted depending on the server.
  These risks apply to the Pi-to-target leg.
- SSH host identity is verified only when a valid OpenSSH `known_hosts` line is
  supplied for the session (or an administrator provisions Guacamole's global
  known-hosts file). Without one, `guacd` logs a warning and continues.
- There is no multi-user authorization, recovery-code system, audit trail, or
  target-credential storage. Every enrolled authenticator shares one web
  identity.
- The project does not automatically patch the OS or upgrade dependencies.
- A private-address allowlist does not replace an egress firewall when the Pi
  runs on an untrusted network.

When reporting a vulnerability, never attach tokens, passwords, QR codes,
manual setup keys, private keys, or the contents of `/etc/guacamole-lite/env`.
