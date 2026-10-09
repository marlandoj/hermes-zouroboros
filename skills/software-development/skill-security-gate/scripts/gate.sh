#!/usr/bin/env bash
# Skill Security Gate — thin wrapper over NVIDIA SkillSpector (external tool, not vendored).
# Usage:
#   gate.sh <path-or-git-url>       Pre-adoption scan of one skill (terminal + JSON report)
#   gate.sh --skills [DIR]          Recursive baseline scan of DIR (default: this checkout's skills/)
#   gate.sh --hermes-skills         Recursive baseline scan of the Hermes profile skills dir
#   gate.sh --llm <target>          Include LLM semantic analysis (needs a provider key for SkillSpector)
#   gate.sh --lifecycle-mode <off|shadow|enforce> --lifecycle-manifest <json> <target>
#   gate.sh --help
#
# JSON reports: ${SKILL_SECURITY_GATE_SCAN_DIR:-$ZOUROBOROS_STATE_DIR/skill-security-gate/scans}
# (ZOUROBOROS_STATE_DIR falls back to state/ in the hermes-zouroboros profile data directory).
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SKILLS_DIR="$(cd -- "$HERE/../../.." && pwd)"
DATA="${HERMES_ZOUROBOROS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hermes-zouroboros}"
REPORT_DIR="${SKILL_SECURITY_GATE_SCAN_DIR:-${ZOUROBOROS_STATE_DIR:-$DATA/state}/skill-security-gate/scans}"
DATE="$(date +%F)"

# `uv tool install` puts executables in its tool bin dir (default ~/.local/bin); look there
# after the regular PATH.
export PATH="$PATH:${UV_TOOL_BIN_DIR:-$HOME/.local/bin}"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

install_guidance() {
  echo "error: skillspector not found on PATH. Install NVIDIA SkillSpector (Apache-2.0) from its" >&2
  echo "upstream repository with uv, for example:" >&2
  echo "  uv tool install --python 3.12 git+<NVIDIA SkillSpector upstream git URL>" >&2
  echo "  # or, from a local clone:  uv tool install --python 3.12 /path/to/SkillSpector" >&2
  echo "Then make sure \$(uv tool dir --bin) is on PATH." >&2
}

LIFECYCLE_MODE="${ZOUROBOROS_SKILL_LIFECYCLE_MODE:-off}"
LIFECYCLE_MANIFEST=""
PASSTHROUGH_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --lifecycle-mode)
      if [ "$#" -lt 2 ]; then
        echo "error: --lifecycle-mode requires off, shadow, or enforce" >&2
        exit 2
      fi
      LIFECYCLE_MODE="$2"
      shift 2
      ;;
    --lifecycle-mode=*)
      LIFECYCLE_MODE="${1#*=}"
      shift
      ;;
    --lifecycle-manifest)
      if [ "$#" -lt 2 ]; then
        echo "error: --lifecycle-manifest requires a JSON file" >&2
        exit 2
      fi
      LIFECYCLE_MANIFEST="$2"
      shift 2
      ;;
    --lifecycle-manifest=*)
      LIFECYCLE_MANIFEST="${1#*=}"
      shift
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done
set -- ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}

case "$LIFECYCLE_MODE" in
  off|shadow|enforce) ;;
  *)
    echo "error: lifecycle mode must be off, shadow, or enforce (got: $LIFECYCLE_MODE)" >&2
    exit 2
    ;;
esac

run_lifecycle_gate() {
  local subject="$1"
  local lifecycle_output
  local lifecycle_status

  if [ "$LIFECYCLE_MODE" = "off" ]; then
    return 0
  fi

  if [ -z "$LIFECYCLE_MANIFEST" ]; then
    if [ "$LIFECYCLE_MODE" = "shadow" ]; then
      echo "Lifecycle: WOULD_HOLD (shadow advisory; --lifecycle-manifest was not provided)"
      return 0
    fi
    echo "error: lifecycle enforce mode requires --lifecycle-manifest <json>" >&2
    return 4
  fi

  if lifecycle_output="$(bun "$HERE/lifecycle/gate.ts" --manifest "$LIFECYCLE_MANIFEST" --subject "$subject" 2>&1)"; then
    lifecycle_status=0
  else
    lifecycle_status=$?
  fi

  if [ "$LIFECYCLE_MODE" = "shadow" ]; then
    if [ "$lifecycle_status" -eq 0 ]; then
      echo "=== Lifecycle advisory: PASS (shadow; non-blocking) ==="
    else
      echo "=== Lifecycle advisory: WOULD_HOLD (shadow; non-blocking) ==="
    fi
    printf '%s\n' "$lifecycle_output"
    return 0
  fi

  if [ "$lifecycle_status" -eq 0 ]; then
    echo "=== Lifecycle gate: PASS (enforce) ==="
    printf '%s\n' "$lifecycle_output"
    return 0
  fi

  echo "=== Lifecycle gate: BLOCKED (enforce) ==="
  printf '%s\n' "$lifecycle_output"
  if [ "$lifecycle_status" -eq 3 ]; then
    return 3
  fi
  return 4
}

LLM_FLAG="--no-llm"
if [ "${1:-}" = "--llm" ]; then
  LLM_FLAG=""
  shift
fi

TARGET=""
BASELINE=0
case "${1:-}" in
  --skills)
    BASELINE=1
    if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then
      TARGET="$2"
    else
      TARGET="$DEFAULT_SKILLS_DIR"
    fi
    ;;
  --hermes-skills)
    BASELINE=1
    TARGET="${HERMES_HOME:-$HOME/.hermes}/skills"
    ;;
  "")
    echo "usage: gate.sh <path-or-git-url> | --skills [DIR] | --hermes-skills | --llm <target> | --help" >&2
    exit 2
    ;;
  *)
    TARGET="$1"
    ;;
esac

if [ "$BASELINE" -eq 1 ] && [ ! -d "$TARGET" ]; then
  echo "error: skills directory not found: $TARGET" >&2
  exit 2
fi

if ! command -v skillspector >/dev/null 2>&1; then
  install_guidance
  exit 127
fi

mkdir -p "$REPORT_DIR"

if [ "$BASELINE" -eq 1 ]; then
  OUT="$REPORT_DIR/skills-scan-${DATE}.json"
  echo "Baseline recursive scan of $TARGET -> $OUT"
  skillspector scan "$TARGET" --recursive $LLM_FLAG --format json -o "$OUT"
  echo "Report: $OUT"
  run_lifecycle_gate "$TARGET"
  exit 0
fi

SLUG="$(echo "$TARGET" | sed -E 's#[^a-zA-Z0-9._-]+#-#g' | sed -E 's#^-+|-+$##g' | tail -c 60)"
OUT="$REPORT_DIR/adopt-${SLUG}-${DATE}.json"

echo "=== Pre-adoption scan: $TARGET ==="
skillspector scan "$TARGET" $LLM_FLAG --format terminal
echo "=== Saving JSON report -> $OUT ==="
skillspector scan "$TARGET" $LLM_FLAG --format json -o "$OUT"
echo "Report: $OUT"
run_lifecycle_gate "$TARGET"
