#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s [user@]pi-host [local-port]\n' "$(basename -- "$0")"
}

[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 2; }
PI_HOST="$1"
LOCAL_PORT="${2:-8080}"

[[ ${PI_HOST} =~ ^[A-Za-z0-9_.@:-]+$ ]] || { printf 'Invalid SSH host.\n' >&2; exit 2; }
if [[ ! ${LOCAL_PORT} =~ ^[0-9]+$ ]] || ((LOCAL_PORT < 1 || LOCAL_PORT > 65535)); then
  printf 'Invalid local port.\n' >&2
  exit 2
fi

printf 'Open http://127.0.0.1:%s after SSH connects.\n' "${LOCAL_PORT}"
exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:8080" \
  "${PI_HOST}"
