#!/usr/bin/env bash
# Hermes pre_verify shell hook — sends the agent back once to close out an armed plan.
#
# A plan is "armed" when `closeout.py --arm` has written the PLAN_ACTIVE sentinel for a
# repository (under $ZOUROBOROS_STATE_DIR/plan-closeout/<key>/). closeout.py removes it
# only after a run whose deterministic eval gate passed. So this hook converts the soft
# "remember to run the Definition of Done" rule into a mechanical gate.
#
# Hermes fires pre_verify once per turn when the agent edited files and is about to
# finish. This hook reads the payload on stdin, checks the repositories of the payload
# cwd and of every changed path, and emits {"decision":"block","reason":...} (Hermes
# turns that into a continue directive) with the closeout command. It answers only
# the first pre_verify of a turn (extra.attempt == 0), so it nudges once rather than
# trap the agent in a loop. Fails open: any error lets the turn finish.
set -u

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOSEOUT="$HERE/closeout.py"

INPUT="$(cat 2>/dev/null)"
[ -n "$INPUT" ] || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)" = pre_verify ] || exit 0

# Already nudged this turn → let it finish. Run closeout.py to clear the gate.
ATTEMPT="$(printf '%s' "$INPUT" | jq -r '(.extra.attempt // 0) | tostring' 2>/dev/null)"
if [ "$ATTEMPT" != 0 ]; then
  printf 'plan-closeout: PLAN_ACTIVE still set; not nudging again this turn. Run closeout.py to clear it.\n' >&2
  exit 0
fi

CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[ -d "$CWD" ] || CWD="$PWD"

# Candidate directories: the payload cwd, then the directory of each changed path.
DIRS="$(printf '%s' "$INPUT" | jq -r --arg cwd "$CWD" '
  [$cwd] + [(.extra.changed_paths // [])[] | strings
    | (if startswith("/") then . else "\($cwd)/\(.)" end) | sub("/[^/]*$"; "")]
  | map(select(length > 0)) | unique | .[:8][]' 2>/dev/null)"

seen=""
while IFS= read -r dir; do
  [ -d "$dir" ] || continue
  # Resolve from inside the directory, exactly as `closeout.py --arm` run there would.
  status="$(cd "$dir" && timeout 10 python3 -B "$CLOSEOUT" --status 2>/dev/null)" || continue
  [ "$(printf '%s' "$status" | jq -r '.armed' 2>/dev/null)" = true ] || continue
  root="$(printf '%s' "$status" | jq -r '.root' 2>/dev/null)"
  case " $seen " in *" $root "*) continue ;; esac
  seen="$seen $root"
  label="$(printf '%s' "$status" | jq -r '.label // "the active plan"' 2>/dev/null)"
  [ -z "$label" ] || [ "$label" = null ] && label="the active plan"
  REASON="A plan is still armed for closeout (\"${label}\") in ${root}. Before finishing, run the Definition of Done: python3 \"${CLOSEOUT}\" --cwd \"${root}\" --file <changed files> --eval \"<deterministic check>\". A passing run clears the gate. To abandon the plan without closing out, run: python3 \"${CLOSEOUT}\" --cwd \"${root}\" --disarm"
  jq -cn --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
done <<< "$DIRS"
exit 0
