#!/usr/bin/env sh
# observer-hook.sh — Generic coding-agent lifecycle hook for zouroboros memory-gate
#
# Adopted from rohitg00/agentmemory's hook design: agents emit lifecycle events
# (PostToolUse, UserPromptSubmit, SessionStart/End...) as JSON on stdin; this
# script forwards a compact observation to the memory-gate daemon's /observe
# endpoint. The gate applies privacy redaction + SHA-256 dedup before storage.
#
# Wire it into any agent whose hook protocol delivers a JSON payload on stdin
# (Claude Code, Codex CLI, OpenCode, etc.):
#
#   {
#     "type": "command",
#     "command": "/path/to/observer-hook.sh post-tool-use",
#     "timeout": 5
#   }
#
# argv[1] = event name (recorded as the observation source). The hook NEVER
# fails the agent: any error exits 0 after logging to stderr.
#
# Env:
#   ZO_GATE_URL    gate daemon URL      (default http://127.0.0.1:7820)
#   ZO_GATE_TOKEN  bearer token         (unset + non-insecure daemon => 401, swallowed)

set -u

EVENT="${1:-unknown}"
ZO_GATE_URL="${ZO_GATE_URL:-http://127.0.0.1:7820}"
ZO_GATE_TOKEN="${ZO_GATE_TOKEN:-}"

PAYLOAD="$(cat 2>/dev/null || true)"
[ -z "$PAYLOAD" ] && exit 0

# Compact the payload: take session id and a bounded text field when present.
# jq is preferred; fall back to bun for extraction so the hook works on hosts
# without jq.
if command -v jq >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // .sessionId // empty' 2>/dev/null || true)"
  TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // .toolName // .tool // empty' 2>/dev/null || true)"
  TEXT="$(printf '%s' "$PAYLOAD" | jq -r -c 'tostring' 2>/dev/null | head -c 4000 || true)"
elif command -v bun >/dev/null 2>&1; then
  EXTRACTED="$(printf '%s' "$PAYLOAD" | bun -e 'const d=await new Response(Bun.stdin.stream()).text(); try{const j=JSON.parse(d); console.log(JSON.stringify({s:j.session_id||j.sessionId||"",t:j.tool_name||j.toolName||j.tool||"",x:JSON.stringify(j).slice(0,4000)}))}catch{console.log(JSON.stringify({s:"",t:"",x:d.slice(0,4000)}))}' 2>/dev/null || true)"
  SESSION_ID="$(printf '%s' "$EXTRACTED" | jq -r '.s' 2>/dev/null || true)"
  TOOL_NAME="$(printf '%s' "$EXTRACTED" | jq -r '.t' 2>/dev/null || true)"
  TEXT="$(printf '%s' "$EXTRACTED" | jq -r '.x' 2>/dev/null || true)"
else
  # No jq and no bun: ship the raw payload bounded; the gate redacts + dedups.
  SESSION_ID=""
  TOOL_NAME=""
  TEXT="$(printf '%s' "$PAYLOAD" | head -c 4000)"
fi

[ -z "$TEXT" ] && exit 0

# Build the request body with jq so JSON escaping is always correct. Without
# jq we cannot safely construct JSON — skip this delivery (never fail agent).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

BODY="$(jq -n \
  --arg text "$TEXT" \
  --arg source "hook:$EVENT" \
  --arg sid "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  '{text: $text, source: $source}
   + (if $sid == "" then {} else {sessionId: $sid} end)
   + (if $tool == "" then {} else {tool: $tool} end)')"

AUTH_HEADER=""
if [ -n "$ZO_GATE_TOKEN" ]; then
  AUTH_HEADER="Authorization: Bearer $ZO_GATE_TOKEN"
fi

# Best-effort POST; never block or fail the agent.
if [ -n "$AUTH_HEADER" ]; then
  curl -s -m 5 -o /dev/null -X POST "$ZO_GATE_URL/observe" \
    -H 'Content-Type: application/json' -H "$AUTH_HEADER" \
    -d "$BODY" 2>/dev/null || true
else
  curl -s -m 5 -o /dev/null -X POST "$ZO_GATE_URL/observe" \
    -H 'Content-Type: application/json' \
    -d "$BODY" 2>/dev/null || true
fi

exit 0
