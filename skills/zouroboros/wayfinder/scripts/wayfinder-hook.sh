#!/usr/bin/env bash
# Prompt-submit hook for every supported harness: wayfinder-hook.sh <harness>
# Reads the harness's raw prompt event on stdin.
#   shadow (default): ranks in a detached process, logs, and prints the harness no-op at once.
#   live: ranks synchronously (bounded by WAYFINDER_TIMEOUT) and prints the context injection.
# Never blocks a prompt: any failure or timeout prints the no-op.
case "${1:-}" in -h|--help) sed -n '2,6p' "$0"; exit 0 ;; esac
umask 077
harness="${1:-claude}"
# State: WAYFINDER_HOME, else $ZOUROBOROS_STATE_DIR/wayfinder, else ~/.wayfinder.
state="${WAYFINDER_HOME:-${ZOUROBOROS_STATE_DIR:+$ZOUROBOROS_STATE_DIR/wayfinder}}"
state="${state:-$HOME/.wayfinder}"
export WAYFINDER_HOME="$state"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${WAYFINDER_ENGINE:-$here/../engine/run.py}"

noop() {
  case "$harness" in
    kimi|opencode|pi|hermes) printf '' ;;
    *) printf '{}' ;;
  esac
}

if [ "${WAYFINDER:-1}" = "0" ] || [ -e "$state/disabled" ]; then
  noop; exit 0
fi
mkdir -p "$state" && chmod 700 "$state" 2>/dev/null

mode="shadow"
for f in "$state/mode" "$state/mode.$harness"; do
  [ -f "$f" ] && mode="$(tr -d '[:space:]' < "$f")"
done
[ -n "$WAYFINDER_MODE" ] && mode="$WAYFINDER_MODE"

payload="$(head -c 200000)"

if [ "$mode" = "live" ]; then
  out="$(printf '%s' "$payload" | timeout "${WAYFINDER_TIMEOUT:-4}" python3 "$engine" live --harness "$harness" 2>>"$state/errors.log")"
  if [ $? -eq 0 ] && [ -n "$out" ]; then
    printf '%s' "$out"
  else
    noop
  fi
  exit 0
fi

( printf '%s' "$payload" | nohup timeout "${WAYFINDER_SHADOW_TIMEOUT:-15}" python3 "$engine" log --harness "$harness" >/dev/null 2>>"$state/errors.log" & ) >/dev/null 2>&1
noop
exit 0
