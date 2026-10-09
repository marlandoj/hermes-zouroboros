#!/usr/bin/env bash
# Selftest for extract-patterns-hook.sh. Runs against a temporary state root; never touches
# a profile. Exit 0 = all pass.
set -u
HOOK="$(dirname "$0")/extract-patterns-hook.sh"
ROOT=$(mktemp -d)
export ZOUROBOROS_STATE_DIR="$ROOT/state" ZOUROBOROS_LOG_DIR="$ROOT/logs" ZOUROBOROS_CONFIG_DIR="$ROOT/config"
unset EXTRACT_PATTERNS_LOG EXTRACT_PATTERNS_OFF EXTRACT_PATTERNS_MIN_MESSAGES
SID="selftest-$$"
LOG="$ROOT/logs/extract-patterns.log"
SDIR="$ROOT/state/extract-patterns"
PASS=0; FAIL=0
ck() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 (got: $2 | want: $3)"; fi; }

# payload EVENT SID MESSAGE_COUNT
payload() { jq -cn --arg e "$1" --arg s "$2" --argjson n "$3" '{hook_event_name:$e, session_id:$s, extra:{conversation_history:[range(0;$n)|{role:"user",content:"m"}]}}'; }

# 1. short conversation → silent, no sentinel
OUT=$(payload pre_llm_call "$SID" 3 | bash "$HOOK")
ck "below threshold silent" "$OUT" ""
ck "below threshold no sentinel" "$(ls "$SDIR/$SID.prompted" 2>/dev/null)" ""

# 2. threshold crossed → context JSON + sentinel + log line
OUT=$(payload pre_llm_call "$SID" 45 | bash "$HOOK")
ck "prompt injects context" "$(printf '%s' "$OUT" | jq -r '.context | startswith("Extract-patterns gate")' 2>/dev/null)" "true"
ck "prompt names the observer" "$(printf '%s' "$OUT" | jq -r '.context | contains("instinct-harvester/scripts/observer.ts")' 2>/dev/null)" "true"
ck "prompt writes sentinel" "$([[ -f "$SDIR/$SID.prompted" ]] && echo yes)" "yes"
ck "prompt logged" "$(grep -c "session=$SID decision=prompted" "$LOG" 2>/dev/null)" "1"

# 3. later call in the same session → silent (once per session)
OUT=$(payload pre_llm_call "$SID" 60 | bash "$HOOK")
ck "prompt-once" "$OUT" ""

# 4. finalize with prompted-but-unresolved → back-fill line, sentinel cleared
OUT=$(payload on_session_finalize "$SID" 0 | bash "$HOOK")
ck "finalize never injects" "$OUT" ""
ck "finalize unresolved" "$(grep -c "session=$SID decision=prompted-unresolved" "$LOG")" "1"
ck "finalize clears sentinel" "$(ls "$SDIR/$SID.prompted" 2>/dev/null)" ""

# 5. finalize for a never-reviewed session → below-threshold line
SID2="${SID}-b"
payload on_session_finalize "$SID2" 0 | bash "$HOOK" > /dev/null
ck "finalize below-threshold" "$(grep -c "session=$SID2 decision=no-review" "$LOG")" "1"

# 6. finalize after an agent-logged decision → no extra line
SID3="${SID}-c"
echo "$(date -u +%FT%TZ) session=$SID3 decision=none" >> "$LOG"
payload on_session_finalize "$SID3" 0 | bash "$HOOK" > /dev/null
ck "finalize respects resolved" "$(grep -c "session=$SID3" "$LOG")" "1"

# 7. kill switches (env and file)
OUT=$(payload pre_llm_call "${SID}-d" 50 | EXTRACT_PATTERNS_OFF=1 bash "$HOOK")
ck "kill switch env" "$OUT" ""
mkdir -p "$ROOT/config" && touch "$ROOT/config/extract-patterns.off"
OUT=$(payload pre_llm_call "${SID}-e" 50 | bash "$HOOK")
ck "kill switch file" "$OUT" ""
rm -f "$ROOT/config/extract-patterns.off"

# 8. malformed stdin and unsafe session ids → fail open, no output, no files
OUT=$(printf 'not json' | bash "$HOOK")
ck "fail open" "$OUT" ""
OUT=$(payload pre_llm_call "../escape" 50 | bash "$HOOK")
ck "unsafe session id ignored" "$OUT$(ls "$ROOT/state" | grep -c escape)" "0"

# 9. other events are ignored
OUT=$(payload post_llm_call "${SID}-f" 50 | bash "$HOOK")
ck "other events ignored" "$OUT" ""

rm -rf "$ROOT"
echo "extract-patterns selftest: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]]
