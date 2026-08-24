#!/usr/bin/env bash
# shellcheck disable=SC2034

GUACD_BRANCH="staging/1.6.1"
GUACD_COMMIT="f22a2df129d9ecf279466e9bcf44cd026e23e6bd"
GUACD_PREFIX="/opt/guacamole-server/1.6.1-staging"
GATEWAY_VERSION="1.2.0"
GATEWAY_PREFIX="/opt/guacamole-lite/${GATEWAY_VERSION}"
CONFIG_DIR="/etc/guacamole-lite"
ENV_FILE="${CONFIG_DIR}/env"
STATE_DIR="/var/lib/guacamole-lite-installer"
BACKUP_ROOT="/var/backups/guacamole-lite-pi"

log() {
  printf '[guacamole-lite-pi] %s\n' "$*"
}

die() {
  printf '[guacamole-lite-pi] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || die "run this script with sudo"
}

require_arm64() {
  local machine
  machine="$(uname -m)"
  [[ ${machine} == "aarch64" || ${machine} == "arm64" ]] \
    || die "this installer supports ARM64 only (detected ${machine})"
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
  [[ -d /run/systemd/system ]] || die "systemd is not running"
}

repo_root() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd
}

timestamp_utc() {
  date -u +%Y%m%dT%H%M%SZ
}

node_major() {
  /usr/bin/node -p "Number(process.versions.node.split('.')[0])"
}

is_private_ipv4() {
  local value="$1" a b c d
  [[ ${value} =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]}))
  b=$((10#${BASH_REMATCH[2]}))
  c=$((10#${BASH_REMATCH[3]}))
  d=$((10#${BASH_REMATCH[4]}))
  ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
  ((a == 10)) \
    || ((a == 172 && b >= 16 && b <= 31)) \
    || ((a == 192 && b == 168)) \
    || ((a == 100 && b >= 64 && b <= 127))
}
