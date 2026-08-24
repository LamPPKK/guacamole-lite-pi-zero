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
TOTP_SECRET="$(env_value GUAC_TOTP_SECRET)"
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

if [[ ${TOTP_SECRET} =~ ^[A-Z2-7]{32}$ ]]; then
  pass "passwordless TOTP authentication has a valid 160-bit enrollment secret"
else
  fail "GUAC_TOTP_SECRET must contain exactly 32 Base32 characters"
fi

if [[ ${WEB_HOST} != "127.0.0.1" ]] && ! is_private_ipv4 "${WEB_HOST}"; then
  fail "VPN mode must use one exact private address"
fi

BASE_URL="http://${WEB_HOST}:${WEB_PORT}"
HEALTH="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/healthz" 2>/dev/null || true)"
EXPECTED_MODE="ssh-tunnel"
[[ ${WEB_HOST} == "127.0.0.1" ]] || EXPECTED_MODE="vpn"
if /usr/bin/node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.status !== "ok" || health.guacd !== true || health.accessMode !== process.argv[2]) process.exit(1);
' "${HEALTH}" "${EXPECTED_MODE}" 2>/dev/null; then
  pass "gateway health endpoint reports guacd ready in ${EXPECTED_MODE} mode"
else
  fail "unexpected health response: ${HEALTH:-none}"
fi

AUTH_STATUS="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  "${BASE_URL}/api/auth/status" 2>/dev/null || true)"
if [[ ${AUTH_STATUS} == '{"authenticated":false}' ]]; then
  pass "unauthenticated browser starts at the TOTP login gate"
else
  fail "unexpected unauthenticated status response: ${AUTH_STATUS:-none}"
fi

TOKEN_STATUS="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 5 --header 'Content-Type: application/json' --data '{"protocol":"ssh","self":true}' \
  "${BASE_URL}/api/token" || true)"
if [[ ${TOKEN_STATUS} == "401" ]]; then
  pass "connection-token API rejects requests without a TOTP session"
else
  fail "connection-token API returned HTTP ${TOKEN_STATUS:-none} without a session, expected 401"
fi

if [[ ${FAILURES} -ne 0 ]]; then
  printf '\n%d verification check(s) failed.\n' "${FAILURES}" >&2
  exit 1
fi
printf '\nAll runtime checks passed.\n'
