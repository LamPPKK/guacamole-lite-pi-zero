#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

PURGE=0
if [[ ${1:-} == "--purge" ]]; then
  PURGE=1
  shift
fi
[[ $# -eq 0 ]] || die "usage: sudo ./scripts/uninstall.sh [--purge]"

require_root
require_systemd

systemctl disable --now guacamole-lite.service guacd.service 2>/dev/null || true
rm -f -- /etc/systemd/system/guacamole-lite.service /etc/systemd/system/guacd.service
rm -rf -- "${GATEWAY_PREFIX}"
systemctl daemon-reload

if [[ ${PURGE} -eq 1 ]]; then
  rm -rf -- "${CONFIG_DIR}" "${GUACD_PREFIX}"
  ldconfig
  log "gateway, secrets, and versioned guacd prefix removed"
  log "guacd account/data and installer backups were preserved"
else
  log "gateway removed; ${CONFIG_DIR}, ${GUACD_PREFIX}, data, and backups were preserved"
  log "run again with --purge to remove the preserved config and versioned guacd prefix"
fi
