# Guacamole Lite for Raspberry Pi Zero 2 W

A minimal RDP/VNC web console for low-memory ARM64 Raspberry Pi systems. The
Node.js gateway and `guacd` listen on loopback only; users connect through SSH
local forwarding, so no web port is exposed to the LAN.

![PI//REMOTE interface preview](docs/ui-preview.svg)

## What is included

- A responsive UI down to 320 px with mouse, keyboard, touch, and fullscreen
  support.
- A `guacamole-lite` 1.2.0 gateway with five-minute tokens protected by
  AES-256-CBC encryption and HMAC-SHA256 authentication.
- RDP/VNC access to private IPv4 targets only (RFC1918 and CGNAT), limited to
  one concurrent session.
- Apache `guacd` pinned to commit
  `f22a2df129d9ecf279466e9bcf44cd026e23e6bd` from `staging/1.6.1`.
- Sandboxed systemd services, an 80 MiB V8 heap limit, and declarative cgroup
  memory limits.
- Build, install, verification, tunnel, rollback, and uninstall scripts.

The stack does not use Docker, Tomcat, Java, a database, or a reverse proxy.
The installer does not modify SSH, WARP, Cloudflared, Samba, or Pi Connect.

## Requirements

- Raspberry Pi OS or Debian 13 ARM64 (`aarch64`).
- Node.js and npm, with Node.js 20 or newer available at `/usr/bin/node`.
- systemd and Internet access for the initial build and installation.
- An SSH client on the workstation.

The Pi Zero 2 W builds `guacd` with one job to reduce peak memory use. The
build can take a while; enable swap and keep a backup SSH session open. Source
and npm dependencies are pinned by commit/version, while Debian packages come
from the repositories configured on the Pi.

## Installation

On the Pi:

```sh
git clone https://github.com/LamPPKK/guacamole-lite-pi-zero.git
cd guacamole-lite-pi-zero
sudo ./scripts/install.sh
```

If the correct `guacd` build is already installed:

```sh
sudo ./scripts/install.sh --skip-guacd-build
```

Use `--no-apt` to skip build dependency installation when the required
packages are already present. Before replacing the gateway, the installer
saves existing files under `/var/backups/guacamole-lite-pi/`.

## Access

From macOS, Linux, or WSL in a checkout of this repository:

```sh
./scripts/open-tunnel.sh pi@pi-host
```

Then open [http://127.0.0.1:8080](http://127.0.0.1:8080). Pass a second
argument to use another local port, for example
`./scripts/open-tunnel.sh pi@pi-host 9080`.

RDP/VNC targets must use a private IPv4 address. RDP defaults to port 3389 and
VNC defaults to port 5900. Credentials exist only in the browser tab's memory
and in a short-lived connection token; the gateway does not persist them or
write them to logs.

## Verification and operations

```sh
sudo ./scripts/verify.sh
sudo systemctl status guacd guacamole-lite
sudo journalctl -u guacd -u guacamole-lite --since today
curl http://127.0.0.1:8080/healthz
```

Validate a source checkout before committing:

```sh
npm ci --ignore-scripts
./scripts/check.sh
```

Installation paths:

| Component | Path |
|---|---|
| Gateway and UI | `/opt/guacamole-lite/1.2.0` |
| `guacd` | `/opt/guacamole-server/1.6.1-staging` |
| Runtime secret | `/etc/guacamole-lite/env` |
| Installer backups | `/var/backups/guacamole-lite-pi` |
| Web / guacd listeners | `127.0.0.1:8080` / `127.0.0.1:4822` |

## Rollback and uninstall

Restore the most recent installer backup:

```sh
sudo ./scripts/rollback.sh
```

You may instead pass a specific timestamped directory below
`/var/backups/guacamole-lite-pi/`. Rollback preserves the compiled `guacd`
prefix to avoid an unnecessary rebuild.

Remove the gateway while preserving its secret, `guacd`, and backups:

```sh
sudo ./scripts/uninstall.sh
```

Remove the secret and versioned `guacd` prefix as well:

```sh
sudo ./scripts/uninstall.sh --purge
```

Upstream `make install` places FreeRDP plugins in the system plugin directory.
The uninstaller intentionally leaves them in place because other software may
use them. A forced build can overwrite same-named plugins from another
Guacamole installation; use a dedicated Pi or back up those plugins before
running `--force`.

## Known limitations

This staging build is used because FreeRDP 3 on Debian 13 requires newer
compatibility code than the Guacamole 1.6.0 release provides. The source is a
staging branch and upstream marks its FreeRDP 3 support as experimental. Test
your target systems before relying on it for long-running access.

`MemoryHigh` and `MemoryMax` only take effect when the kernel exposes the
cgroup v2 memory controller. Without it, the gateway still uses an 80 MiB V8
heap limit and rejects a second concurrent session. See
[Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and
[Troubleshooting](docs/TROUBLESHOOTING.md) for details.

## License

Repository-specific code is MIT licensed. `guacamole-lite`, Apache Guacamole
Server, and the vendored browser client use Apache-2.0; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
