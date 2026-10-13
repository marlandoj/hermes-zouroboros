#!/usr/bin/env bash
# Run the repository's own regression suite in a loop worktree or export and emit JSON.
# Usage: local-suite.sh <dir> <out.json>
# Steps: frozen install + build (repo.sh build), typecheck, bun tests, python installer tests,
# python factory tests, portable verification — each with exit code, duration and a log path.
# Never runs in the deployed checkout (repo.sh refuses). Exit 0 only if every step exits 0.
set -uo pipefail
DIR="${1:?dir}"; OUT="${2:?out.json}"
LOOP_SCRIPTS="$(cd "$(dirname "$0")/../../zouroboros-loop/scripts" && pwd)"
source "$LOOP_SCRIPTS/loop-env.sh"
LOGS="$LOOP/logs"; mkdir -p "$LOGS"
NODE="$(ls -d "$REAL_HOME"/.hermes/tools/node-*/bin 2>/dev/null | tail -1 || true)"
# Isolated tool dir: only bun, node and pnpm. ~/.local/bin is NOT on PATH, because it also holds the real
# hermes/claude/codex launchers, which tests must never reach (they expect fakes or absence).
TOOLS="$(mktemp -d /tmp/zo-task-tools-XXXXXX)"
ln -s "$REAL_HOME/.bun/bin/bun" "$TOOLS/bun"; [[ -n "$NODE" ]] && ln -s "$NODE/node" "$TOOLS/node"
PNPM="$(command -v pnpm || echo "$REAL_HOME/.local/bin/pnpm")"; ln -s "$(realpath "$PNPM")" "$TOOLS/pnpm"
export PATH="$TOOLS:/usr/bin:/bin" CI=1
# Pin the caller's pnpm store before isolating HOME, so installs stay offline-first.
npm_config_store_dir="$(pnpm store path 2>/dev/null || true)"; export npm_config_store_dir
# Private (0700) scratch outside /tmp: the installer tests refuse a workshop hierarchy containing a
# world-writable directory, and /tmp is world-writable (GitHub runners use a private $HOME).
PRIV="$LOOP/tmp"; mkdir -p "$PRIV"; chmod 700 "$PRIV"
SCR="$(mktemp -d "$PRIV/suite-XXXXXX")"; export HOME="$SCR/home" TMPDIR="$SCR"; mkdir -p "$HOME"
tag="$(basename "$DIR")-$(date +%Y%m%d%H%M%S)"; results=(); all=0
step() { local name="$1"; shift; local log="$LOGS/suite-$tag-$name.log" s e
  s=$(date +%s); ( cd "$DIR" && "$@" ) > "$log" 2>&1; e=$?
  # Failing test names (Bun "(fail) …", unittest "ERROR:/FAIL: …") for test-level base/head comparison.
  local fails; fails="$(python3 - "$log" <<'PY'
import json, re, sys
names = []
for l in open(sys.argv[1], errors="replace"):
    m = re.match(r"^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$", l.rstrip()) or re.match(r"^(?:ERROR|FAIL): (.+)$", l.rstrip())
    if m: names.append(m.group(1).strip())
print(json.dumps(sorted(set(names))))
PY
)"
  results+=("{\"step\":\"$name\",\"exit\":$e,\"seconds\":$(( $(date +%s) - s )),\"log\":\"$log\",\"failing_tests\":$fails}"); [[ $e -eq 0 ]] || all=1; }
step build bash "$LOOP_SCRIPTS/repo.sh" build "$DIR"
step typecheck pnpm run typecheck
step bun-tests bun test tests
[[ -f "$DIR/tests/test_installer.py" ]] && step py-installer python3 -m unittest discover -s tests -p 'test_installer.py'
[[ -d "$DIR/factory" ]] && step py-factory python3 -m unittest discover -s factory -p 'test_*.py'
[[ -f "$DIR/scripts/ci/verify-portable-runtime.ts" ]] && step portable bun scripts/ci/verify-portable-runtime.ts
sha="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
printf '{"dir":"%s","sha":"%s","ok":%s,"steps":[%s]}\n' "$DIR" "$sha" "$([[ $all -eq 0 ]] && echo true || echo false)" "$(IFS=,; echo "${results[*]}")" > "$OUT"
cat "$OUT"; rm -rf "$SCR" "$TOOLS"; exit $all
