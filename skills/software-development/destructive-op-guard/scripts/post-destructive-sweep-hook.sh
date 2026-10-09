#!/usr/bin/env bash
# Destructive-op advisory, as a Hermes shell hook. Fail-open, never blocks, always exit 0.
#
# Register it for two events in the profile's config.yaml (see SKILL.md):
#
#   post_tool_call (matcher: terminal) — when the command that just ran matches a
#                  teardown/destructive pattern, record a per-session pending reminder.
#                  Hermes ignores post_tool_call output, so nothing is printed here.
#   pre_llm_call   — if a reminder is pending for the session, return it once as
#                  {"context": ...} and clear it, so the agent runs a reference sweep
#                  (sweep-refs.sh) before declaring "no orphaned resources".
#
# Pending reminders live under ${ZOUROBOROS_STATE_DIR:-<profile data>/state}/destructive-op-guard/.
# Kill switch: DESTRUCTIVE_OP_GUARD_OFF=1.
set +e

[ "${DESTRUCTIVE_OP_GUARD_OFF:-0}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${HERMES_ZOUROBOROS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hermes-zouroboros}"
PENDING_DIR="${ZOUROBOROS_STATE_DIR:-$DATA/state}/destructive-op-guard"

raw="$(cat 2>/dev/null)"
[ -z "$raw" ] && exit 0

event="$(printf '%s' "$raw" | jq -r '.hook_event_name // empty' 2>/dev/null)"
sid="$(printf '%s' "$raw" | jq -r '.session_id // empty' 2>/dev/null)"
# Session ids become file names: refuse anything outside a conservative alphabet.
printf '%s' "$sid" | grep -Eq '^[A-Za-z0-9._:-]{1,128}$' || exit 0
pending="$PENDING_DIR/$sid.pending"

if [ "$event" = "pre_llm_call" ]; then
  [ -f "$pending" ] || exit 0
  cmds="$(head -c 600 "$pending" 2>/dev/null)"
  rm -f "$pending" 2>/dev/null
  MSG="[destructive-op advisory] A command earlier in this session matched a teardown/destructive pattern (${cmds}). If it removed a NAMED resource (cloud server, service, IP, DB table, branch), run a workspace reference sweep BEFORE declaring \"no orphaned resources\": bash \"$HERE/sweep-refs.sh\" <identifier> [<identifier2> ...] (set SWEEP_ROOT to search a different tree). Live-config/code hits = review or fix; log/doc/reprovision-source hits = leave. \"No orphaned resources\" must cover workspace references, not just the provider side."
  jq -cn --arg m "$MSG" '{context:$m}' 2>/dev/null
  exit 0
fi

[ "$event" = "post_tool_call" ] || exit 0

# Fast pre-filter on the raw payload before parsing the command: the common (benign)
# case exits here, so the hook stays cheap on every terminal call.
printf '%s' "$raw" | grep -Eiq 'delete|destroy|drop|--force|[^a-z]rm |-f\b' || exit 0

cmd="$(printf '%s' "$raw" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# Genuinely destructive / hard-to-reverse actions on shared infra or data.
if printf '%s' "$cmd" | grep -Eiq \
  '(hcloud[[:space:]]+[a-z-]+[[:space:]]+delete)|(\brm[[:space:]]+-[a-zA-Z]*[rf])|(git[[:space:]]+push[[:space:]].*(--force|-f\b))|(terraform[[:space:]]+destroy)|(DROP[[:space:]]+(TABLE|DATABASE|SCHEMA))|(\bdropdb\b)|(\b(aws|gcloud|az|doctl|flyctl|kubectl)\b.*[[:space:]](delete|destroy|terminate-instances)\b)|(systemctl[[:space:]]+disable[[:space:]]+--now)'; then
  mkdir -p "$PENDING_DIR" 2>/dev/null || exit 0
  printf '%s; ' "$(printf '%s' "$cmd" | tr '\n' ' ' | head -c 160)" >> "$pending" 2>/dev/null
fi
exit 0
