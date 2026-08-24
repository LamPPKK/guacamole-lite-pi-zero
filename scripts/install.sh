#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

BUILD_GUACD=1
INSTALL_BUILD_PACKAGES=1
VPN_ADDRESS=""
TOTP_ENROLLMENT_CREATED=0

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/install.sh [options]

Options:
  --skip-guacd-build  require an existing pinned guacd build
  --no-apt            do not install required system packages
  --vpn-address IP    bind to one existing private VPN IP with TOTP login
  -h, --help          show this help

The gateway uses loopback/SSH tunnel access by default. VPN mode binds only to
the exact supplied IP. On first installation, this script prints a QR code for
the passwordless authenticator login. This script does
not configure a firewall or modify SSH, WARP, Tailscale, Cloudflared, Samba,
or Pi Connect.
EOF
}

while (($#)); do
  case "$1" in
    --skip-guacd-build) BUILD_GUACD=0 ;;
    --no-apt) INSTALL_BUILD_PACKAGES=0 ;;
    --vpn-address)
      [[ $# -ge 2 ]] || die "--vpn-address requires an IPv4 address"
      VPN_ADDRESS="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_root
require_arm64
require_systemd
[[ -x /usr/bin/node ]] || die "Node.js 20 or newer is required at /usr/bin/node"
command -v npm >/dev/null 2>&1 || die "npm is required"
[[ $(node_major) -ge 20 ]] || die "Node.js 20 or newer is required"

ROOT_DIR="$(repo_root)"
[[ -f "${ROOT_DIR}/package-lock.json" && -f "${ROOT_DIR}/server.js" ]] \
  || die "run this script from a complete repository checkout"

if [[ ${BUILD_GUACD} -eq 1 ]]; then
  BUILD_ARGS=()
  [[ ${INSTALL_BUILD_PACKAGES} -eq 1 ]] || BUILD_ARGS+=(--no-apt)
  "${SCRIPT_DIR}/build-guacd.sh" "${BUILD_ARGS[@]}"
else
  [[ -x "${GUACD_PREFIX}/sbin/guacd" ]] \
    || die "pinned guacd is missing; remove --skip-guacd-build"
  [[ -f "${GUACD_PREFIX}/BUILD-MANIFEST" ]] \
    || die "guacd build manifest is missing"
  grep -qx "commit=${GUACD_COMMIT}" "${GUACD_PREFIX}/BUILD-MANIFEST" \
    || die "installed guacd does not match the pinned commit"
  grep -qx 'protocols=ssh,rdp,vnc' "${GUACD_PREFIX}/BUILD-MANIFEST" \
    || die "installed guacd does not provide SSH, RDP, and VNC"
fi

if ! grep -q '^GUAC_TOTP_SECRET=[A-Z2-7]\{32\}$' "${ENV_FILE}" 2>/dev/null \
    && ! command -v qrencode >/dev/null 2>&1; then
  [[ ${INSTALL_BUILD_PACKAGES} -eq 1 ]] \
    || die "qrencode is required for first-install enrollment; remove --no-apt or install it"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends qrencode
fi

install -d -m 0700 "${BACKUP_ROOT}" "${STATE_DIR}"
BACKUP_DIR="$(mktemp -d "${BACKUP_ROOT}/$(timestamp_utc).XXXXXX")"
install -d -m 0700 "${BACKUP_DIR}/rootfs"
: > "${BACKUP_DIR}/present.list"
: > "${BACKUP_DIR}/absent.list"
chmod 0600 "${BACKUP_DIR}/present.list" "${BACKUP_DIR}/absent.list"

backup_path() {
  local target="$1"
  local relative="${target#/}"
  if [[ -e ${target} || -L ${target} ]]; then
    install -d -m 0700 "${BACKUP_DIR}/rootfs/$(dirname -- "${relative}")"
    cp -a -- "${target}" "${BACKUP_DIR}/rootfs/${relative}"
    printf '%s\n' "${target}" >> "${BACKUP_DIR}/present.list"
  else
    printf '%s\n' "${target}" >> "${BACKUP_DIR}/absent.list"
  fi
}

for target in \
  "${GATEWAY_PREFIX}" \
  "${ENV_FILE}" \
  /etc/systemd/system/guacd.service \
  /etc/systemd/system/guacamole-lite.service; do
  backup_path "${target}"
done
printf '%s\n' "${BACKUP_DIR}" > "${STATE_DIR}/last-backup"
chmod 0600 "${STATE_DIR}/last-backup" "${BACKUP_DIR}"/*.list
log "backup saved to ${BACKUP_DIR}"

STAGE_DIR=""
TEMP_ENV=""
DEPLOYMENT_TOUCHED=0
INSTALL_SUCCEEDED=0

restore_install_backup() {
  local restore_failed=0
  log "installation failed after deployment began; restoring ${BACKUP_DIR}"
  systemctl disable --now guacamole-lite.service guacd.service 2>/dev/null || true

  while IFS= read -r target; do
    [[ -n ${target} ]] || continue
    rm -rf -- "${target}" || restore_failed=1
    install -d -m 0755 "$(dirname -- "${target}")" || restore_failed=1
    cp -a -- "${BACKUP_DIR}/rootfs/${target#/}" "${target}" || restore_failed=1
  done < "${BACKUP_DIR}/present.list"

  while IFS= read -r target; do
    [[ -n ${target} ]] || continue
    rm -rf -- "${target}" || restore_failed=1
  done < "${BACKUP_DIR}/absent.list"

  systemctl daemon-reload || restore_failed=1
  if [[ -f /etc/systemd/system/guacd.service \
        && -f /etc/systemd/system/guacamole-lite.service ]]; then
    systemctl enable --now guacd.service guacamole-lite.service || restore_failed=1
  fi
  if [[ ${restore_failed} -eq 0 ]]; then
    log "previous gateway installation restored; the compiled guacd prefix was preserved"
  else
    printf '[guacamole-lite-pi] ERROR: automatic restore was incomplete; run scripts/rollback.sh %q\n' \
      "${BACKUP_DIR}" >&2
  fi
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  set +e
  if [[ -n ${STAGE_DIR:-} && -d ${STAGE_DIR} ]]; then
    rm -rf -- "${STAGE_DIR}"
  fi
  if [[ -n ${TEMP_ENV:-} && -f ${TEMP_ENV} ]]; then
    rm -f -- "${TEMP_ENV}"
  fi
  if [[ ${exit_status} -ne 0 && ${DEPLOYMENT_TOUCHED} -eq 1 \
        && ${INSTALL_SUCCEEDED} -eq 0 ]]; then
    restore_install_backup
  fi
  exit "${exit_status}"
}
trap cleanup EXIT

if ! getent group guacd >/dev/null; then
  groupadd --system guacd
fi
if ! getent passwd guacd >/dev/null; then
  useradd --system --home-dir /var/lib/guacd --create-home \
    --gid guacd --shell /usr/sbin/nologin guacd
fi
install -d -o guacd -g guacd -m 0750 /var/lib/guacd

install -d -m 0755 /opt/guacamole-lite
STAGE_DIR="$(mktemp -d /opt/guacamole-lite/.install.XXXXXX)"

install -m 0644 "${ROOT_DIR}/package.json" "${STAGE_DIR}/package.json"
install -m 0644 "${ROOT_DIR}/package-lock.json" "${STAGE_DIR}/package-lock.json"
install -m 0644 "${ROOT_DIR}/server.js" "${STAGE_DIR}/server.js"
install -m 0644 "${ROOT_DIR}/deploy/GATEWAY-BUILD-MANIFEST" \
  "${STAGE_DIR}/GATEWAY-BUILD-MANIFEST"
printf 'installed_at=%s\nnode_detected=%s\narchitecture_detected=%s\n' \
  "$(date -u +%FT%TZ)" "$(/usr/bin/node --version)" "$(uname -m)" \
  >> "${STAGE_DIR}/GATEWAY-BUILD-MANIFEST"
install -d -m 0755 "${STAGE_DIR}/public/guacamole"
cp -a -- "${ROOT_DIR}/public/." "${STAGE_DIR}/public/"

log "installing pinned Node.js production dependencies"
npm --prefix "${STAGE_DIR}" ci --omit=dev --ignore-scripts
chmod -R a+rX,go-w "${STAGE_DIR}"

DEPLOYMENT_TOUCHED=1
rm -rf -- "${GATEWAY_PREFIX}"
mv -- "${STAGE_DIR}" "${GATEWAY_PREFIX}"
STAGE_DIR=""

install -d -m 0700 -o root -g root "${CONFIG_DIR}"
if [[ ! -f ${ENV_FILE} ]]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the token key"
  command -v base32 >/dev/null 2>&1 || die "base32 is required to generate the TOTP secret"
  umask 077
  TOKEN_KEY="$(openssl rand -base64 32)"
  TOTP_SECRET="$(openssl rand 20 | base32 | tr -d '=')"
  printf 'GUAC_WEB_HOST=127.0.0.1\nGUAC_WEB_PORT=8080\nGUAC_ALLOWED_WEB_HOSTS=127.0.0.1,localhost\nGUACD_HOST=127.0.0.1\nGUACD_PORT=4822\nGUAC_TOKEN_KEY=%s\nGUAC_TOTP_SECRET=%s\n' \
    "${TOKEN_KEY}" "${TOTP_SECRET}" > "${ENV_FILE}"
  TOTP_ENROLLMENT_CREATED=1
else
  TEMP_ENV="$(mktemp "${CONFIG_DIR}/.env.auth.XXXXXX")"
  EXISTING_TOTP_SECRET="$(awk -F= '$1 == "GUAC_TOTP_SECRET" { print $2; exit }' "${ENV_FILE}")"
  awk '!/^(GUAC_BASIC_AUTH_USER|GUAC_BASIC_AUTH_SHA256|GUAC_TOTP_SECRET)=/' \
    "${ENV_FILE}" > "${TEMP_ENV}"
  if [[ ${EXISTING_TOTP_SECRET} =~ ^[A-Z2-7]{32}$ ]]; then
    TOTP_SECRET="${EXISTING_TOTP_SECRET}"
  else
    command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the TOTP secret"
    command -v base32 >/dev/null 2>&1 || die "base32 is required to generate the TOTP secret"
    TOTP_SECRET="$(openssl rand 20 | base32 | tr -d '=')"
    TOTP_ENROLLMENT_CREATED=1
  fi
  printf 'GUAC_TOTP_SECRET=%s\n' "${TOTP_SECRET}" >> "${TEMP_ENV}"
  mv -f -- "${TEMP_ENV}" "${ENV_FILE}"
  TEMP_ENV=""
fi
chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

install -m 0644 "${ROOT_DIR}/deploy/guacd.service" /etc/systemd/system/guacd.service
install -m 0644 "${ROOT_DIR}/deploy/guacamole-lite.service" \
  /etc/systemd/system/guacamole-lite.service

systemctl daemon-reload
systemctl enable guacd.service guacamole-lite.service
systemctl restart guacd.service

if [[ -n ${VPN_ADDRESS} ]]; then
  "${SCRIPT_DIR}/configure-access.sh" vpn "${VPN_ADDRESS}"
  log "installation complete; VPN access is enabled on the exact configured address"
else
  systemctl restart guacamole-lite.service
  "${SCRIPT_DIR}/verify.sh"
  INSTALLED_WEB_HOST="$(awk -F= '$1 == "GUAC_WEB_HOST" { print $2; exit }' "${ENV_FILE}")"
  if [[ ${INSTALLED_WEB_HOST:-127.0.0.1} == "127.0.0.1" ]]; then
    log "installation complete; use scripts/open-tunnel.sh from your workstation"
  else
    log "installation complete; the existing protected VPN access mode was preserved"
  fi
fi
if [[ ${TOTP_ENROLLMENT_CREATED} -eq 1 && -t 1 ]]; then
  "${SCRIPT_DIR}/show-otp-qr.sh"
  log "scan the QR code now; rerun sudo ./scripts/show-otp-qr.sh to display it again"
elif [[ ${TOTP_ENROLLMENT_CREATED} -eq 1 ]]; then
  log "TOTP enrollment created, but the QR was not printed to non-interactive output"
  log "open a private terminal and run sudo ./scripts/show-otp-qr.sh"
fi
INSTALL_SUCCEEDED=1
