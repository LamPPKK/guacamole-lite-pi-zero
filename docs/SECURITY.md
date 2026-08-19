# Security model

## Trust boundary

The web gateway is not a LAN service: ports 8080 and 4822 both bind to
`127.0.0.1`. SSH provides authentication and encryption from the workstation
to the Pi. The Pi-to-target leg is a separate RDP/VNC connection and is not
inside the SSH tunnel. Do not change either unit to bind `0.0.0.0`. If the
gateway must be published, place an authenticated TLS reverse proxy in front
of it and reassess the Host and Origin policies.

## Connection controls

- Only `rdp` and `vnc` are accepted.
- A target must be a literal IPv4 address in `10/8`, `172.16/12`,
  `192.168/16`, or `100.64/10`. The gateway does not resolve hostnames, which
  reduces DNS-rebinding risk.
- Port, display dimensions, DPI, and text-field lengths are bounded.
- Token requests require same-origin when a browser supplies an `Origin`.
- The Host header must be loopback or a `.localhost` name.
- WebSocket tokens are validated before a connection reaches `guacd`.
- One session is accepted at a time, and WebSocket payloads are limited to
  256 KiB.

## Credentials and tokens

The browser sends credentials to the gateway over loopback inside the SSH
tunnel. The gateway creates a 300-second token using AES-256-CBC with a random
IV and authenticates the complete envelope with HMAC-SHA256. HKDF derives the
MAC key from the encryption key. The MAC is checked with a constant-time
comparison before decryption.

A token briefly exists in browser memory and in the WebSocket URL. Do not
share DevTools screenshots or proxy logs that include query strings. The
runtime secret is generated during installation and is never stored in this
repository.

## Explicit limitations

- Port 8080 does not provide TLS itself; encryption for workstation-to-Pi web
  traffic comes from the SSH tunnel.
- The gateway sets `ignore-cert=true` for RDP so self-signed certificates
  work. It therefore does not authenticate the RDP server through its
  certificate. VNC transport may be unencrypted depending on the server.
  These risks apply to the Pi-to-target leg.
- There is no multi-user authorization, audit trail, or credential storage.
- The project does not automatically patch the OS or upgrade dependencies.
- A private-address allowlist does not replace an egress firewall when the Pi
  runs on an untrusted network.

When reporting a vulnerability, never attach tokens, passwords, private keys,
or the contents of `/etc/guacamole-lite/env`.
