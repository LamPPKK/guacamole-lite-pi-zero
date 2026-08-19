#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "${ROOT_DIR}"

npm run check
npm test

while IFS= read -r script; do
  bash -n "${script}"
done < <(find scripts -type f -name '*.sh' -print | sort)

printf 'Application tests and shell syntax checks passed.\n'
