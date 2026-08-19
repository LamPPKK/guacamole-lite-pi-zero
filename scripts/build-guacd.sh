#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FORCE=0
INSTALL_PACKAGES=1

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/build-guacd.sh [--force] [--no-apt]

Build the pinned Apache guacd source with RDP/VNC support only.
  --force   rebuild even if the pinned installation is already present
  --no-apt  do not install Debian build dependencies
EOF
}

while (($#)); do
  case "$1" in
    --force) FORCE=1 ;;
    --no-apt) INSTALL_PACKAGES=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_root
require_arm64

if [[ ${FORCE} -eq 0 && -x "${GUACD_PREFIX}/sbin/guacd" \
      && -f "${GUACD_PREFIX}/BUILD-MANIFEST" ]] \
      && grep -qx "commit=${GUACD_COMMIT}" "${GUACD_PREFIX}/BUILD-MANIFEST"; then
  log "pinned guacd build is already installed"
  exit 0
fi

if [[ ${INSTALL_PACKAGES} -eq 1 ]]; then
  log "installing minimal RDP/VNC build dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    autoconf automake build-essential ca-certificates curl git libtool libtool-bin \
    pkg-config libcairo2-dev libfreerdp3-dev libgcrypt20-dev libjpeg62-turbo-dev \
    libpng-dev libssl-dev libvncserver-dev uuid-dev
fi

for command_name in autoreconf git make pkg-config; do
  command -v "${command_name}" >/dev/null 2>&1 \
    || die "missing build command: ${command_name}"
done

BUILD_DIR="$(mktemp -d /tmp/guacamole-server-build.XXXXXX)"
OLD_PREFIX=""
PREFIX_TOUCHED=0
INSTALL_SUCCEEDED=0
cleanup() {
  rm -rf -- "${BUILD_DIR}"
  if [[ ${PREFIX_TOUCHED} -eq 1 && ${INSTALL_SUCCEEDED} -eq 0 ]]; then
    rm -rf -- "${GUACD_PREFIX}"
    if [[ -n ${OLD_PREFIX} && -e ${OLD_PREFIX} ]]; then
      mv -- "${OLD_PREFIX}" "${GUACD_PREFIX}"
      ldconfig || true
      printf '[guacamole-lite-pi] Restored previous guacd prefix after build failure.\n' >&2
    fi
  fi
}
trap cleanup EXIT

log "fetching Apache Guacamole ${GUACD_COMMIT}"
git -C "${BUILD_DIR}" init -q
git -C "${BUILD_DIR}" remote add origin https://github.com/apache/guacamole-server.git
git -C "${BUILD_DIR}" fetch --depth 1 origin "${GUACD_COMMIT}"
git -C "${BUILD_DIR}" checkout -q --detach FETCH_HEAD
[[ $(git -C "${BUILD_DIR}" rev-parse HEAD) == "${GUACD_COMMIT}" ]] \
  || die "downloaded source does not match the pinned commit"

if [[ -e ${GUACD_PREFIX} ]]; then
  [[ ${FORCE} -eq 1 ]] || die "${GUACD_PREFIX} exists but does not match the pinned build; use --force"
  OLD_PREFIX="${GUACD_PREFIX}.backup-$(timestamp_utc)"
  log "moving the previous prefix to ${OLD_PREFIX}"
  mv -- "${GUACD_PREFIX}" "${OLD_PREFIX}"
  PREFIX_TOUCHED=1
fi

log "configuring a minimal RDP/VNC build"
cd -- "${BUILD_DIR}"
autoreconf -fi
CFLAGS='-O2 -Wno-deprecated-declarations' ./configure \
  --prefix="${GUACD_PREFIX}" \
  --with-rdp \
  --with-vnc \
  --without-vorbis \
  --without-pulse \
  --without-pango \
  --without-terminal \
  --without-ssh \
  --disable-ssh-agent \
  --without-telnet \
  --without-webp \
  --without-websockets \
  --disable-kubernetes \
  --disable-guacenc \
  --disable-guaclog

make -j1 CFLAGS='-O2 -Wno-deprecated-declarations'
PREFIX_TOUCHED=1
make install
ldconfig

[[ -x "${GUACD_PREFIX}/sbin/guacd" ]] || die "guacd was not installed"
for client in rdp vnc; do
  library="${GUACD_PREFIX}/lib/freerdp3/libguac-client-${client}.so"
  if [[ ! -e ${library} ]]; then
    library="$(find "${GUACD_PREFIX}/lib" -name "libguac-client-${client}.so*" -type f -print -quit)"
  fi
  [[ -n ${library} && -e ${library} ]] || die "${client} client library was not built"
  if ! LDD_OUTPUT="$(ldd "${library}" 2>&1)"; then
    die "${client} client library could not be inspected by ldd"
  fi
  if grep -q 'not found' <<< "${LDD_OUTPUT}"; then
    die "${client} client library has unresolved dependencies"
  fi
done

FREERDP_VERSION="$(pkg-config --modversion freerdp3 2>/dev/null || printf 'unknown')"
install -m 0644 "${SCRIPT_DIR}/../deploy/GUACD-BUILD-MANIFEST" \
  "${GUACD_PREFIX}/BUILD-MANIFEST"
printf 'built_at=%s\nfreerdp_detected=%s\n' "$(date -u +%FT%TZ)" "${FREERDP_VERSION}" \
  >> "${GUACD_PREFIX}/BUILD-MANIFEST"
INSTALL_SUCCEEDED=1

log "guacd installed at ${GUACD_PREFIX}"
