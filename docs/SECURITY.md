# Security model

## Trust boundary

By default, ports 8080 and 4822 both bind to `127.0.0.1`. SSH provides
authentication and encryption from the workstation to the Pi. Optional VPN
mode moves only port 8080 to one exact RFC1918/CGNAT address already assigned
to the Pi and requires HTTP Basic Auth for pages, API calls, and WebSockets.
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
- Port, display dimensions, DPI, and text-field lengths are bounded.
- Token requests require same-origin when a browser supplies an `Origin`.
- The Host header must be loopback, a `.localhost` name, or an explicitly
  configured private VPN address.
- A non-loopback bind fails at startup unless its exact address is allowed and
  valid Basic Auth configuration is present.
- WebSocket tokens are validated before a connection reaches `guacd`.
- One session is accepted at a time, and WebSocket payloads are limited to
  256 KiB.

## Credentials and tokens

The browser sends target credentials over loopback inside the SSH tunnel or
through the encrypted private VPN. The gateway creates a 300-second token
using AES-256-CBC with a random IV and authenticates the complete envelope
with HMAC-SHA256. HKDF derives the MAC key from the encryption key. The MAC is
checked with a constant-time comparison before decryption.

VPN web credentials are generated from 144 random bits. Only the SHA-256
digest of `username:password` is stored in the root-only environment file, and
comparison uses constant time. The password is displayed once. Basic Auth by
itself is not encryption, so the private VPN remains part of the trust model.

A token briefly exists in browser memory and in the WebSocket URL. Do not
share DevTools screenshots or proxy logs that include query strings. The
runtime secret is generated during installation and is never stored in this
repository.

## Explicit limitations

- Port 8080 does not provide TLS itself; encryption for workstation-to-Pi web
  traffic comes from the SSH tunnel or the pre-existing private VPN.
- The gateway sets `ignore-cert=true` for RDP so self-signed certificates
  work. It therefore does not authenticate the RDP server through its
  certificate. VNC transport may be unencrypted depending on the server.
  These risks apply to the Pi-to-target leg.
- SSH host identity is verified only when a valid OpenSSH `known_hosts` line is
  supplied for the session (or an administrator provisions Guacamole's global
  known-hosts file). Without one, `guacd` logs a warning and continues.
- There is no multi-user authorization, audit trail, or credential storage.
- The project does not automatically patch the OS or upgrade dependencies.
- A private-address allowlist does not replace an egress firewall when the Pi
  runs on an untrusted network.

When reporting a vulnerability, never attach tokens, passwords, private keys,
or the contents of `/etc/guacamole-lite/env`.
