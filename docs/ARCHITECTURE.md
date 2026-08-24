# Architecture

```text
Browser on the workstation or private VPN peer
    | Default: HTTP + WebSocket carried inside an SSH local forward
    | Optional: exact private VPN IP over an encrypted VPN
    | Passwordless TOTP session in both modes
    v
configured-IP:8080  Node.js gateway / guacamole-lite
    | Guacamole protocol over loopback
    v
127.0.0.1:4822  guacd
    | SSH, RDP, or VNC to a private target
    | or SSH only to this Pi at 127.0.0.1:22
    v
Private IPv4 target on the network / local Pi SSH service
```

The gateway serves four static assets, the `/healthz` endpoint, TOTP
authentication endpoints, the `/api/token` token endpoint, and a WebSocket
managed by `guacamole-lite`. The same process applies Host/Origin validation,
TOTP replay/rate controls, in-memory web sessions, body and WebSocket size
limits, the target allowlist, and the single-session limit.
The browser carries its opaque login session in an `Authorization` header from
origin-scoped `sessionStorage`. A generated connection token is one-use, bound
to that login session in server memory, and cannot outlive session revocation.
Active WebSockets are tracked so logout, expiry, or eviction closes them.
The local-Pi shortcut is normalized and revalidated as SSH on exact loopback
port 22; it does not expose other services bound to the Pi's loopback interface.
The default listener is loopback. VPN mode refuses wildcard/public binds and
requires an exact assigned private/CGNAT address. TOTP login remains mandatory.
If the configured VPN address is temporarily absent during boot, the Node.js
process remains active and retries the bind every five seconds. Other listener
errors still fail normally and are handled by systemd's bounded restart policy.

## Pinned components

| Component | Version or commit |
|---|---|
| Node.js | System Node.js 20 or newer |
| guacamole-lite | 1.2.0 through `package-lock.json` |
| guacamole-common-js | 1.6.0 with its digest recorded in the manifest |
| guacamole-server | `staging/1.6.1` / `f22a2df129d9ecf279466e9bcf44cd026e23e6bd` |

`guacd` is built with SSH, RDP, and VNC support. Pango and Guacamole's terminal
emulator are included for SSH. Audio, Telnet, SSH agent forwarding, Kubernetes,
WebP, guacenc, and guaclog are disabled. The
`-Wno-deprecated-declarations` flag is required because this commit enables
`-Werror` during its FreeRDP 3 feature probes while Debian 13's FreeRDP 3.15
headers still contain deprecated declarations.

## Data and permissions

- The gateway uses a systemd `DynamicUser` and reads only its source and
  configuration.
- `guacd` runs as the dedicated system user `guacd`, with `/var/lib/guacd` as
  its home directory.
- The runtime secret exists only in `/etc/guacamole-lite/env`, owned by
  `root:root` with mode `0600`. systemd reads it before launching the service.
- The same file holds the random 160-bit TOTP enrollment secret. The installer
  prints its QR/manual representation only when enrollment is created in an
  interactive terminal; a root administrator can deliberately display it
  again. Non-interactive output is refused unless explicitly overridden.
- Both units use `ProtectSystem=strict`, `NoNewPrivileges`, an empty capability
  set, and Unix/IPv4/IPv6 address-family restrictions.

There is no database. Web sessions, connection settings, and target credentials
are not persisted.
