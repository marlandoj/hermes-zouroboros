#!/usr/bin/env bash
# One operator entrypoint; Python uses the supported Hermes configuration CLI.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  printf 'Missing prerequisite: Python 3.10+ on PATH.\n' >&2
  exit 1
fi
exec python3 "$root/scripts/install.py" "$@"
