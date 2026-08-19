#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_systemd

if [[ $# -gt 1 ]]; then
  die "usage: sudo ./scripts/rollback.sh [backup-directory]"
fi

if [[ $# -eq 1 ]]; then
  REQUESTED_BACKUP="$1"
else
  [[ -f ${STATE_DIR}/last-backup ]] || die "no installer backup was recorded"
  REQUESTED_BACKUP="$(<"${STATE_DIR}/last-backup")"
fi

BACKUP_DIR="$(realpath -e -- "${REQUESTED_BACKUP}")"
CANONICAL_ROOT="$(realpath -e -- "${BACKUP_ROOT}")"
[[ ${BACKUP_DIR} == "${CANONICAL_ROOT}"/* ]] || die "backup must be below ${BACKUP_ROOT}"
[[ -f ${BACKUP_DIR}/present.list && -f ${BACKUP_DIR}/absent.list ]] \
  || die "invalid backup directory"

allowed_target() {
  case "$1" in
    "${GATEWAY_PREFIX}"|"${ENV_FILE}"|/etc/systemd/system/guacd.service|/etc/systemd/system/guacamole-lite.service)
      return 0 ;;
    *) return 1 ;;
  esac
}

systemctl disable --now guacamole-lite.service guacd.service 2>/dev/null || true

while IFS= read -r target; do
  [[ -n ${target} ]] || continue
  allowed_target "${target}" || die "backup contains an unexpected target: ${target}"
  source_path="${BACKUP_DIR}/rootfs/${target#/}"
  [[ -e ${source_path} || -L ${source_path} ]] || die "backup payload is missing: ${target}"
  rm -rf -- "${target}"
  install -d -m 0755 "$(dirname -- "${target}")"
  cp -a -- "${source_path}" "${target}"
done < "${BACKUP_DIR}/present.list"

while IFS= read -r target; do
  [[ -n ${target} ]] || continue
  allowed_target "${target}" || die "backup contains an unexpected target: ${target}"
  rm -rf -- "${target}"
done < "${BACKUP_DIR}/absent.list"

systemctl daemon-reload
if [[ -f /etc/systemd/system/guacd.service && -f /etc/systemd/system/guacamole-lite.service ]]; then
  systemctl enable --now guacd.service guacamole-lite.service
fi
log "restored ${BACKUP_DIR}; the versioned guacd prefix was preserved"
