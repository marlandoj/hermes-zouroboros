#!/usr/bin/env bash
# Portable Zouroboros bridge for Hermes Agent's final-response-only CLI.
set -euo pipefail

fail() { printf 'hermes-zouroboros: %s\n' "$1" >&2; exit "${2:-1}"; }
[[ $# -ge 1 && $# -le 2 && -n "$1" ]] || fail 'Usage: hermes-bridge.sh "prompt" [workdir]' 2
prompt="$1"
workdir="${2:-$PWD}"
[[ -d "$workdir" ]] || fail 'Working directory does not exist.' 2

# Resolve before changing directories; HERMES_BIN is one executable, never a
# shell command. Keep HOME/HERMES_HOME and credentials under caller control.
launcher="$(command -v -- "${HERMES_BIN:-hermes}" || true)"
[[ -n "$launcher" && -x "$launcher" ]] || fail 'Hermes executable is unavailable; set HERMES_BIN.' 127
if [[ "$launcher" != /* ]]; then launcher="$PWD/$launcher"; fi
command -v timeout >/dev/null || fail 'GNU timeout is required.' 127
duration="${HERMES_TIMEOUT:-300}"
[[ "$duration" =~ ^[1-9][0-9]{0,5}$ ]] || fail 'HERMES_TIMEOUT must be a positive integer in seconds (up to six digits).' 2

model="${SWARM_RESOLVED_MODEL:-${HERMES_MODEL:-${HERMES_INFERENCE_MODEL:-${LLM_MODEL:-}}}}"
provider="${SWARM_PROVIDER:-${HERMES_PROVIDER:-}}"
[[ -z "$provider" || -n "$model" ]] || fail 'A provider override requires a model override.' 2
args=()
[[ -z "$provider" ]] || args+=(--provider "$provider")
[[ -z "$model" ]] || args+=(--model "$model")

umask 077
scratch="$(mktemp -d "${TMPDIR:-/tmp}/hermes-zouroboros-XXXXXX")"
child=''
cleanup() {
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd -- "$workdir"
# A swarm child may consume the same MCP profile but must not recursively
# dispatch another swarm through that profile's MCP entrypoint.
export HERMES_ZOUROBOROS_ALLOW_SWARM=0
timeout --kill-after=5s "${duration}s" "$launcher" "${args[@]}" -z "$prompt" \
  >"$scratch/output" 2>"$scratch/error" &
child=$!
status=0
wait "$child" || status=$?
child=''
if [[ "$status" -ne 0 ]]; then
  # Provider stderr may contain credential values. Report status without
  # reflecting untrusted provider diagnostics into orchestrator logs.
  fail "Hermes failed (exit $status); inspect the private Hermes session logs." "$status"
fi
LC_ALL=C grep -q '[^[:space:]]' "$scratch/output" || fail 'Hermes produced no final response.'
cat -- "$scratch/output"
