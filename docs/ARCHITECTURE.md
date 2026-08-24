# Architecture

```text
Browser on the workstation or private VPN peer
    | Default: HTTP + WebSocket carried inside an SSH local forward
    | Optional: exact private VPN IP + HTTP Basic Auth
    v
configured-IP:8080  Node.js gateway / guacamole-lite
    | Guacamole protocol over loopback
    v
127.0.0.1:4822  guacd
    | SSH, RDP, or VNC
    v
Private IPv4 target on the network
```

The gateway serves four static assets, the `/healthz` endpoint, the
`/api/token` token endpoint, and a WebSocket managed by `guacamole-lite`. The
same process applies Host/Origin validation, optional Basic Auth, body and
WebSocket size limits, the target allowlist, and the single-session limit.
The default listener is loopback. VPN mode refuses wildcard/public binds and
requires both an exact assigned private/CGNAT address and Basic Auth.
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
- VPN mode stores only the SHA-256 digest of the generated high-entropy Basic
  Auth credential. The cleartext password is printed once and not persisted.
- Both units use `ProtectSystem=strict`, `NoNewPrivileges`, an empty capability
  set, and Unix/IPv4/IPv6 address-family restrictions.

There is no database. Connection settings and credentials are not persisted.
