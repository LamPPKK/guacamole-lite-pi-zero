#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage:
  sudo ./scripts/configure-access.sh ssh-tunnel
  sudo ./scripts/configure-access.sh vpn PRIVATE_IP
  sudo ./scripts/configure-access.sh status

ssh-tunnel  Bind the web gateway to 127.0.0.1 with TOTP login.
vpn         Bind to one existing private/CGNAT VPN address with TOTP login.
status      Show the configured mode without printing secrets.

This script never installs, starts, stops, or changes VPN and SSH software.
EOF
}

env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}"
}

show_status() {
  local web_host web_port
  web_host="$(env_value GUAC_WEB_HOST)"
  web_port="$(env_value GUAC_WEB_PORT)"
  web_host="${web_host:-127.0.0.1}"
  web_port="${web_port:-8080}"
  if [[ ${web_host} == "127.0.0.1" ]]; then
    printf 'Mode: SSH tunnel with TOTP login\nBind: %s:%s\n' "${web_host}" "${web_port}"
  else
    printf 'Mode: VPN with TOTP login\nBind: %s:%s\n' "${web_host}" "${web_port}"
  fi
}

write_access_config() {
  local web_host="$1" allowed_hosts="$2"
  local temporary
  temporary="$(mktemp "${CONFIG_DIR}/.env.XXXXXX")"
  awk '!/^(GUAC_WEB_HOST|GUAC_ALLOWED_WEB_HOSTS|GUAC_BASIC_AUTH_USER|GUAC_BASIC_AUTH_SHA256)=/' \
    "${ENV_FILE}" > "${temporary}"
  printf 'GUAC_WEB_HOST=%s\nGUAC_ALLOWED_WEB_HOSTS=%s\n' \
    "${web_host}" "${allowed_hosts}" >> "${temporary}"
  chown root:root "${temporary}"
  chmod 0600 "${temporary}"
  mv -f -- "${temporary}" "${ENV_FILE}"
}

restore_previous_config() {
  local backup="$1"
  cp -a -- "${backup}" "${ENV_FILE}"
  systemctl restart guacamole-lite.service 2>/dev/null || true
  die "new access configuration failed; the previous configuration was restored"
}

MODE="${1:-}"
case "${MODE}" in
  status)
    [[ $# -eq 1 ]] || { usage >&2; exit 2; }
    ;;
  ssh-tunnel)
    [[ $# -eq 1 ]] || { usage >&2; exit 2; }
    ;;
  vpn)
    [[ $# -eq 2 ]] || { usage >&2; exit 2; }
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

require_root
require_systemd
[[ -f ${ENV_FILE} ]] || die "${ENV_FILE} does not exist; run install.sh first"
if [[ ${MODE} == "status" ]]; then
  show_status
  exit 0
fi

if [[ ${MODE} == "ssh-tunnel" ]]; then
  BACKUP_FILE="${CONFIG_DIR}/env.access-backup-$(timestamp_utc)"
  cp -a -- "${ENV_FILE}" "${BACKUP_FILE}"
  write_access_config 127.0.0.1 127.0.0.1,localhost
  if ! systemctl restart guacamole-lite.service \
      || ! systemctl is-active --quiet guacamole-lite.service; then
    restore_previous_config "${BACKUP_FILE}"
  fi
  if ! "${SCRIPT_DIR}/verify.sh"; then
    restore_previous_config "${BACKUP_FILE}"
  fi
  log "web access now requires an SSH local forward and TOTP login at 127.0.0.1:8080"
  exit 0
fi

VPN_ADDRESS="$2"
is_private_ipv4 "${VPN_ADDRESS}" \
  || die "VPN address must be a literal RFC1918 or CGNAT IPv4 address"
command -v ip >/dev/null 2>&1 || die "iproute2 is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
if ! ip -4 -o address show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq -- "${VPN_ADDRESS}"; then
  die "${VPN_ADDRESS} is not currently assigned to this Pi"
fi

BACKUP_FILE="${CONFIG_DIR}/env.access-backup-$(timestamp_utc)"
cp -a -- "${ENV_FILE}" "${BACKUP_FILE}"
write_access_config "${VPN_ADDRESS}" "127.0.0.1,localhost,${VPN_ADDRESS}"

if ! systemctl restart guacamole-lite.service \
    || ! systemctl is-active --quiet guacamole-lite.service; then
  restore_previous_config "${BACKUP_FILE}"
fi

WEB_PORT="$(env_value GUAC_WEB_PORT)"
WEB_PORT="${WEB_PORT:-8080}"
HTTP_STATUS="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 5 "http://${VPN_ADDRESS}:${WEB_PORT}/healthz" || true)"
if [[ ${HTTP_STATUS} != "200" ]]; then
  restore_previous_config "${BACKUP_FILE}"
fi

if ! "${SCRIPT_DIR}/verify.sh"; then
  restore_previous_config "${BACKUP_FILE}"
fi
printf '\nVPN web access enabled at http://%s:%s\n' "${VPN_ADDRESS}" "${WEB_PORT}"
printf 'Sign in with the six-digit code from the enrolled authenticator app.\n'
printf 'Use this only through an encrypted private VPN; do not expose port %s publicly.\n' \
  "${WEB_PORT}"
