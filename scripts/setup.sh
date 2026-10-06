#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for binary in bun node pnpm python3 timeout; do
  command -v "$binary" >/dev/null || { printf 'Missing prerequisite: %s\n' "$binary" >&2; exit 1; }
done
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
printf 'Source is ready. Next: bun integration/cli.ts init --workspace /absolute/workspace\n'
