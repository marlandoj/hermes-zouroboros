#!/usr/bin/env bash
# Held-out probe (shell-injection class): payload variants not used by the acceptance check.
# Usage: shell-payloads.sh <repo> <scratch>   → prints SAFE or INJECTED:<payload-id>; exit 0 SAFE, 1 injected, 97 setup.
set -u; R="$1"; S="$2"; BUN="${BUN:-bun}"
export HERMES_ZOUROBOROS_HOME="$S/h/data" HOME="$S/h"; mkdir -p "$S/h/data" "$S/h/work"
( cd "$R" && "$BUN" integration/cli.ts init --workspace "$S/h/work" >/dev/null ) || exit 97
i=0; bad=""
# Absolute marker paths: the CLI runs subcommands with the workspace as cwd (a relative marker would hide injection).
for p in "\$(touch $S/M1)" "\`touch $S/M2\`" "x && touch $S/M3" "x | touch $S/M4" $'x\n'"touch $S/M5" "x || touch $S/M6" "\"; touch $S/M7; \""; do
  i=$((i+1)); ( cd "$S" && "$BUN" "$R/integration/cli.ts" memory defense "$p" >/dev/null 2>&1 ) || true
  for m in "$S"/M*; do [[ -e "$m" ]] && { bad="$bad P$i"; rm -f "$m"; }; done
done
[[ -z "$bad" ]] && { echo SAFE; exit 0; } || { echo "INJECTED:$bad"; exit 1; }
