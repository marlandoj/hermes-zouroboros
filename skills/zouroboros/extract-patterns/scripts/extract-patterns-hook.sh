#!/usr/bin/env bash
# Extract-patterns discipline: a noise-free session pattern gate, as a Hermes shell hook.
#
# Register it for two events in the profile's config.yaml (see SKILL.md):
#
#   pre_llm_call        — once per session, after the conversation reaches
#                         EXTRACT_PATTERNS_MIN_MESSAGES messages (default 40), returns
#                         {"context": <gate prompt>} so the agent runs the four-criteria
#                         review before it concludes. Shorter conversations are silent
#                         (the session may still grow). One sentinel per session makes
#                         it a single nudge, never a loop.
#   on_session_finalize — never blocks; writes the session's final decision line if the
#                         agent never reached or never resolved the gate, so every session
#                         has exactly one recorded outcome.
#
# The four qualifying criteria (ALL required to extract):
#   1. project-specific  2. repeatedly applicable  3. non-obvious  4. trigger→action
# Otherwise the agent writes NOTHING and replies "No new patterns to extract."
#
# Paths live under the portable roots, never a shared tmpfs:
#   decision log  ${EXTRACT_PATTERNS_LOG:-$ZOUROBOROS_LOG_DIR/extract-patterns.log}
#   sentinels     $ZOUROBOROS_STATE_DIR/extract-patterns/
#   kill switch   $ZOUROBOROS_CONFIG_DIR/extract-patterns.off (or EXTRACT_PATTERNS_OFF=1)
# Each root falls back to the profile data directory. Fails open on any error.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${HERMES_ZOUROBOROS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hermes-zouroboros}"
STATE="${ZOUROBOROS_STATE_DIR:-$DATA/state}"
LOG="${EXTRACT_PATTERNS_LOG:-${ZOUROBOROS_LOG_DIR:-$DATA/logs}/extract-patterns.log}"
SENTINEL_DIR="$STATE/extract-patterns"
OFF_FILE="${ZOUROBOROS_CONFIG_DIR:-$DATA/config}/extract-patterns.off"
OBSERVER="$(cd "$HERE/../../instinct-harvester/scripts" 2>/dev/null && pwd)/observer.ts"
MIN_MESSAGES="${EXTRACT_PATTERNS_MIN_MESSAGES:-40}"

[[ "${EXTRACT_PATTERNS_OFF:-0}" == "1" || -f "$OFF_FILE" ]] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat 2>/dev/null) || exit 0
jqf() { printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; }

EVENT=$(jqf '.hook_event_name')
SID=$(jqf '.session_id')
[[ -z "$SID" ]] && exit 0
# Session ids become file names: refuse anything outside a conservative alphabet.
[[ "$SID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || exit 0

mkdir -p "$SENTINEL_DIR" "$(dirname "$LOG")" 2>/dev/null || exit 0
PROMPTED="$SENTINEL_DIR/$SID.prompted"
NOW=$(date -u +%FT%TZ)

if [[ "$EVENT" == "on_session_finalize" ]]; then
  if grep -q "session=$SID decision=\(extracted\|none\)" "$LOG" 2>/dev/null; then
    :
  elif [[ -f "$PROMPTED" ]]; then
    echo "$NOW session=$SID decision=prompted-unresolved" >> "$LOG" 2>/dev/null
  else
    echo "$NOW session=$SID decision=no-review reason=below-threshold" >> "$LOG" 2>/dev/null
  fi
  rm -f "$PROMPTED" 2>/dev/null
  exit 0
fi

[[ "$EVENT" == "pre_llm_call" ]] || exit 0
[[ -f "$PROMPTED" ]] && exit 0               # once per session

MESSAGES=$(printf '%s' "$INPUT" | jq -r '(.extra.conversation_history // []) | length' 2>/dev/null || echo 0)
[[ "$MESSAGES" =~ ^[0-9]+$ ]] || MESSAGES=0
[[ "$MESSAGES" -lt "$MIN_MESSAGES" ]] && exit 0    # too small to review yet; may cross later

touch "$PROMPTED" 2>/dev/null
echo "$NOW session=$SID decision=prompted messages=$MESSAGES" >> "$LOG" 2>/dev/null

ROUTE="run: bun \"$OBSERVER\" add --trigger \"<when doing X in context Y>\" --action \"<prefer Z>\" --domain <domain> --confidence <0.5-0.9> --source session-observation"

REASON="Extract-patterns gate — one-time session review before you conclude this session. If this session surfaced a pattern that is ALL FOUR of: (1) specific to this project/codebase, not generic best practice; (2) likely to recur in future sessions on this repo; (3) non-obvious to a senior engineer on this codebase; (4) expressible as trigger→action — then ${ROUTE}, and append one line to ${LOG}: '<ISO8601-UTC> session=${SID} decision=extracted domain=<domain>'. If NO pattern meets all four criteria: append '<ISO8601-UTC> session=${SID} decision=none' to that log, write NOTHING to any memory or instinct store (not even a 'checked' entry), and say only: No new patterns to extract. Do not force extraction. Handle the user's current request first."

jq -cn --arg r "$REASON" '{context:$r}' 2>/dev/null
exit 0
