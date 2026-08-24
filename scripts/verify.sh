#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

FAILURES=0

pass() {
  printf 'PASS  %s\n' "$*"
}

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  FAILURES=$((FAILURES + 1))
}

check_service() {
  local service="$1"
  if systemctl is-active --quiet "${service}" && systemctl is-enabled --quiet "${service}"; then
    pass "${service} is active and enabled"
  else
    fail "${service} must be active and enabled"
  fi
}

check_listener() {
  local port="$1"
  local expected="$2"
  local listeners
  listeners="$(ss -H -ltn | awk -v suffix=":${port}" '$4 ~ suffix "$" {print $4}')"
  if [[ ${listeners} == "${expected}" ]]; then
    pass "port ${port} listens only on ${expected}"
  else
    fail "port ${port} listeners are '${listeners:-none}', expected ${expected}"
  fi
}

for command_name in curl ldd ss systemctl; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done
[[ -x /usr/bin/node ]] || fail "missing runtime: /usr/bin/node"
[[ ${FAILURES} -eq 0 ]] || exit 1
require_root
[[ -f ${ENV_FILE} ]] || die "${ENV_FILE} does not exist"

env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}"
}

WEB_HOST="$(env_value GUAC_WEB_HOST)"
WEB_PORT="$(env_value GUAC_WEB_PORT)"
GUACD_LISTEN_HOST="$(env_value GUACD_HOST)"
GUACD_LISTEN_PORT="$(env_value GUACD_PORT)"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-8080}"
GUACD_LISTEN_HOST="${GUACD_LISTEN_HOST:-127.0.0.1}"
GUACD_LISTEN_PORT="${GUACD_LISTEN_PORT:-4822}"

if [[ $(node_major) -ge 20 ]]; then
  pass "Node.js $(/usr/bin/node --version) at /usr/bin/node is supported"
else
  fail "Node.js 20 or newer is required"
fi

if [[ -f "${GUACD_PREFIX}/BUILD-MANIFEST" ]] \
    && grep -qx "commit=${GUACD_COMMIT}" "${GUACD_PREFIX}/BUILD-MANIFEST"; then
  pass "guacd matches pinned commit ${GUACD_COMMIT}"
else
  fail "guacd build manifest does not match the pinned commit"
fi

for client in rdp vnc ssh; do
  library="$(find "${GUACD_PREFIX}/lib" -name "libguac-client-${client}.so*" -type f -print -quit 2>/dev/null || true)"
  LDD_OUTPUT=""
  if [[ -n ${library} ]] && LDD_OUTPUT="$(ldd "${library}" 2>&1)" \
      && ! grep -q 'not found' <<< "${LDD_OUTPUT}"; then
    pass "${client} native client is present with resolved libraries"
  else
    fail "${client} native client is missing or has unresolved libraries"
  fi
done

check_service guacd.service
check_service guacamole-lite.service
check_listener "${GUACD_LISTEN_PORT}" "${GUACD_LISTEN_HOST}:${GUACD_LISTEN_PORT}"
check_listener "${WEB_PORT}" "${WEB_HOST}:${WEB_PORT}"

if [[ ${WEB_HOST} == "127.0.0.1" ]]; then
  HEALTH="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
    --header "Host: 127.0.0.1:${WEB_PORT}" \
    "http://127.0.0.1:${WEB_PORT}/healthz" 2>/dev/null || true)"
  if /usr/bin/node -e '
    const health = JSON.parse(process.argv[1]);
    if (health.status !== "ok" || health.guacd !== true || health.accessMode !== "ssh-tunnel") process.exit(1);
  ' "${HEALTH}" 2>/dev/null; then
    pass "gateway health endpoint reports guacd ready in SSH tunnel mode"
  else
    fail "unexpected health response: ${HEALTH:-none}"
  fi
else
  AUTH_USER="$(env_value GUAC_BASIC_AUTH_USER)"
  AUTH_DIGEST="$(env_value GUAC_BASIC_AUTH_SHA256)"
  if is_private_ipv4 "${WEB_HOST}" && [[ ${AUTH_USER} =~ ^[A-Za-z0-9._-]{1,32}$ ]] \
      && [[ ${AUTH_DIGEST} =~ ^[a-fA-F0-9]{64}$ ]]; then
    pass "VPN mode uses one exact private address with configured Basic Auth"
  else
    fail "VPN mode requires an exact private address and valid Basic Auth configuration"
  fi
  HTTP_STATUS="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 5 "http://${WEB_HOST}:${WEB_PORT}/healthz" || true)"
  if [[ ${HTTP_STATUS} == "401" ]]; then
    pass "VPN web access rejects unauthenticated requests"
  else
    fail "VPN web access returned HTTP ${HTTP_STATUS:-none} without credentials, expected 401"
  fi
fi

if [[ ${FAILURES} -ne 0 ]]; then
  printf '\n%d verification check(s) failed.\n' "${FAILURES}" >&2
  exit 1
fi
printf '\nAll runtime checks passed.\n'
