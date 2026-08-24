# Troubleshooting

## The UI does not open

Run `sudo ./scripts/verify.sh` on the Pi. If both services are healthy, open
the tunnel with `-o ExitOnForwardFailure=yes` or use
`scripts/open-tunnel.sh`. Check whether another process already uses local port
8080; pass 9080 as the script's second argument if needed.

For VPN mode, inspect the exact configured bind without exposing secrets:

```sh
sudo ./scripts/configure-access.sh status
ip -4 -brief address
```

The configured VPN IP must still exist on a live interface. The UI will show
the same six-digit authenticator login used in SSH-tunnel mode.
During boot, `guacamole-lite` logs a retry every five seconds while it waits for
that address. If retries continue after the VPN is online, reconfigure the
gateway with the Pi's current exact VPN address.

## The authenticator code is rejected

Confirm the phone and Pi clocks are synchronized. TOTP depends on Unix time;
the gateway allows one 30-second step of clock drift in either direction.
Each successfully used code is accepted only once, so wait for the next code
before opening another browser session.

After five failed attempts from the same address, wait up to five minutes. If
the authenticator entry was lost, a root administrator can display the original
QR and manual setup key again:

```sh
sudo ./scripts/show-otp-qr.sh
timedatectl status
```

The installer deliberately skips QR output when stdout is not an interactive
terminal. Run `show-otp-qr.sh` from a private interactive terminal after an
automated installation; do not redirect its output into a shared log.

Restarting `guacamole-lite` signs out every browser but does not change the
enrollment secret.

## Health reports `degraded`

```sh
sudo systemctl status guacd
sudo journalctl -u guacd -n 100 --no-pager
sudo ss -ltnp | grep ':4822'
```

`guacd` must bind to `127.0.0.1:4822`. Inspect the native libraries:

```sh
ldd /opt/guacamole-server/1.6.1-staging/lib/libguac-client-rdp.so.0
ldd /opt/guacamole-server/1.6.1-staging/lib/libguac-client-vnc.so.0
ldd /opt/guacamole-server/1.6.1-staging/lib/libguac-client-ssh.so.0
```

Neither command should report `not found`.

## SSH, RDP, or VNC cannot connect

Confirm that the target is a literal private IPv4 address, the port is
correct, and the Pi can reach it. For RDP, try `NLA`, `TLS`, or `Automatic`
security. A domain account may require the Domain field. For VNC, confirm that
the server supports password authentication and 16-bit color depth.

For SSH, confirm port 22 (or your custom port) is reachable from the Pi and the
account allows password authentication. A malformed or mismatched known-host
entry intentionally prevents the connection. Obtain a trusted entry out of
band, for example from a workstation that already trusts the host.

For **This Pi**, the target is always `127.0.0.1:22`. Check that the Pi's SSH
service is running with `systemctl status ssh` and that the selected local
account is allowed to sign in with a password. Custom local SSH ports are not
accepted by this shortcut; enter the Pi's private address as a normal SSH target
instead.

## Switch back to the safe default

If VPN routing changes or you no longer need direct VPN access:

```sh
sudo ./scripts/configure-access.sh ssh-tunnel
./scripts/open-tunnel.sh pi@pi-host
```

The first command binds the web gateway back to loopback, restarts it, and
verifies the result. TOTP login remains enabled and the command does not stop
the VPN.

Gateway logs intentionally omit credentials and tokens:

```sh
sudo journalctl -u guacamole-lite -u guacd -f
```

## The guacd build fails

Confirm that the Pi is running ARM64, Debian 13 repositories are available,
and `/opt` and `/tmp` have enough free space:

```sh
uname -m
df -h /opt /tmp
free -h
```

The build uses `make -j1`. If the kernel kills it for running out of memory,
enable swap and retry. With `--force`, the previous prefix is renamed to
`.backup-<timestamp>` beside the active prefix. The failure trap restores that
prefix if the new build does not finish.

## MemoryMax is not enforced

Inspect the available controller and the unit properties:

```sh
cat /sys/fs/cgroup/cgroup.controllers
systemctl show guacamole-lite -p MemoryCurrent -p MemoryMax
```

If `memory` is absent from the controller list, the kernel or boot
configuration must change before systemd can enforce the limit. This is not a
unit-file error; the 80 MiB V8 heap cap and the one-session limit still apply.
