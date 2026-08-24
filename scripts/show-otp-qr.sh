#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ALLOW_NONINTERACTIVE=0
case "${1:-}" in
  "") ;;
  --allow-noninteractive) ALLOW_NONINTERACTIVE=1 ;;
  *) die "usage: sudo ./scripts/show-otp-qr.sh [--allow-noninteractive]" ;;
esac

require_root
if [[ ! -t 1 && ${ALLOW_NONINTERACTIVE} -ne 1 ]]; then
  die "refusing to print the enrollment secret to non-interactive output; use a private terminal or pass --allow-noninteractive"
fi
[[ -f ${ENV_FILE} ]] || die "${ENV_FILE} does not exist; run install.sh first"
command -v qrencode >/dev/null 2>&1 || die "qrencode is required"

TOTP_SECRET="$(awk -F= '$1 == "GUAC_TOTP_SECRET" { print $2; exit }' "${ENV_FILE}")"
[[ ${TOTP_SECRET} =~ ^[A-Z2-7]{32}$ ]] \
  || die "GUAC_TOTP_SECRET is missing or invalid"

OTP_URI="otpauth://totp/PI%20Remote%3AConsole?secret=${TOTP_SECRET}&issuer=PI%20Remote&algorithm=SHA1&digits=6&period=30"

printf '\nPI Remote authenticator enrollment\n'
printf 'Scan this QR code with Google Authenticator, Microsoft Authenticator, Authy, or another TOTP app.\n\n'
printf '%s' "${OTP_URI}" | qrencode -t ANSIUTF8 -m 1
printf '\nManual setup key: %s\n' "${TOTP_SECRET}"
printf 'Type: TOTP   Algorithm: SHA-1   Digits: 6   Period: 30 seconds\n'
printf 'Keep this terminal output private. Anyone with the setup key can generate login codes.\n\n'
