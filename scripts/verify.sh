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

check_loopback_listener() {
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

for client in rdp vnc; do
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
check_loopback_listener 4822 127.0.0.1:4822
check_loopback_listener 8080 127.0.0.1:8080

HEALTH="$(curl --fail --silent --show-error --max-time 5 \
  --header 'Host: 127.0.0.1:8080' http://127.0.0.1:8080/healthz 2>/dev/null || true)"
if [[ ${HEALTH} == '{"status":"ok","guacd":true}' ]]; then
  pass "gateway health endpoint reports guacd ready"
else
  fail "unexpected health response: ${HEALTH:-none}"
fi

if [[ ${FAILURES} -ne 0 ]]; then
  printf '\n%d verification check(s) failed.\n' "${FAILURES}" >&2
  exit 1
fi
printf '\nAll runtime checks passed.\n'
