#!/usr/bin/env bash
# Hermetic tests: adapter translation both ways, shadow and live modes, the mode CLI, and the installer.
# Canny is a stub; HOME and every state root point into a temp dir, so nothing outside it is touched.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
unset ZOUROBOROS_STATE_DIR ZOUROBOROS_DATA_DIR HERMES_ZOUROBOROS_HOME XDG_DATA_HOME CANNY_DIR CANNY_HOME VERITY_HOME VERITY_LOG VERITY_MODE VERITY_CHECKS VERITY_DISABLE
export HOME="$T/home"; mkdir -p "$HOME"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
adapt() { printf '%s' "$2" | node "$ROOT/scripts/adapter.mjs" "$1"; }

o=$(adapt kimi '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Write","tool_input":{"path":"/p/a.ts","content":"x"}}')
check "kimi path->file_path" "$(jq -r .tool_input.file_path <<<"$o")" "/p/a.ts"
check "kimi session prefix" "$(jq -r .session_id <<<"$o")" "kimi-s1"
o=$(adapt kimi '{"hook_event_name":"PostToolUseFailure","session_id":"s1","tool_name":"Bash","error":{"message":"Command exited with code 3"}}')
check "kimi exit code kept" "$(jq -r .error <<<"$o" | head -1)" "Exit code 3"
o=$(adapt gemini '{"hook_event_name":"BeforeTool","session_id":"g","tool_name":"replace","tool_input":{"file_path":"/p/b.ts","old_string":"a","new_string":"b"}}')
check "gemini BeforeTool->PreToolUse" "$(jq -r .hook_event_name <<<"$o")" "PreToolUse"
check "gemini replace->Edit" "$(jq -r .tool_name <<<"$o")" "Edit"
o=$(adapt gemini '{"hook_event_name":"AfterTool","session_id":"g","tool_name":"run_shell_command","tool_input":{"command":"npm test","dir_path":"/p"},"tool_response":{"llmContent":"Output: ok\nExit Code: 1"}}')
check "gemini exit code parsed" "$(jq -r .tool_response.exit_code <<<"$o")" "1"
check "gemini dir_path->cwd" "$(jq -r .cwd <<<"$o")" "/p"
o=$(adapt gemini '{"hook_event_name":"AfterAgent","session_id":"g","prompt_response":"Done."}')
check "gemini AfterAgent->Stop" "$(jq -r .hook_event_name,.last_assistant_message <<<"$o" | paste -sd' ')" "Stop Done."

# Hermes shell-hook events in, Claude-shaped events out.
o=$(adapt hermes '{"hook_event_name":"pre_tool_call","session_id":"h1","cwd":"/w","tool_name":"terminal","tool_input":{"command":"npm test","workdir":"/w/app"},"extra":{}}')
check "hermes pre_tool_call->PreToolUse" "$(jq -r .hook_event_name,.tool_name,.tool_input.command <<<"$o" | paste -sd'|')" "PreToolUse|Bash|npm test"
check "hermes workdir->cwd" "$(jq -r .cwd <<<"$o")" "/w/app"
check "hermes session prefix" "$(jq -r .session_id <<<"$o")" "hermes-h1"
o=$(adapt hermes '{"hook_event_name":"pre_tool_call","tool_name":"write_file","tool_input":{"path":"/w/a.ts","content":"x"}}')
check "hermes write_file->Write" "$(jq -r .tool_name,.tool_input.file_path,.tool_input.content <<<"$o" | paste -sd'|')" "Write|/w/a.ts|x"
o=$(adapt hermes '{"hook_event_name":"pre_tool_call","tool_name":"patch","tool_input":{"path":"/w/a.ts","old_string":"a","new_string":"b"}}')
check "hermes patch->Edit" "$(jq -r .tool_name,.tool_input.file_path,.tool_input.new_string <<<"$o" | paste -sd'|')" "Edit|/w/a.ts|b"
o=$(adapt hermes '{"hook_event_name":"pre_tool_call","tool_name":"patch","tool_input":{"mode":"patch","patch":"*** Begin Patch\n*** Update File: src/b.ts\n+y\n*** End Patch"}}')
check "hermes V4A patch target" "$(jq -r .tool_input.file_path <<<"$o")" "src/b.ts"
o=$(adapt hermes '{"hook_event_name":"post_tool_call","tool_name":"terminal","tool_input":{"command":"npm test"},"extra":{"result":"{\"output\":\"1 failed\",\"exit_code\":2,\"error\":null}","status":"ok"}}')
check "hermes post exit code" "$(jq -r .hook_event_name,.tool_response.exit_code,.tool_response.stdout <<<"$o" | paste -sd'|')" "PostToolUse|2|1 failed"
o=$(adapt hermes '{"hook_event_name":"post_tool_call","tool_name":"write_file","tool_input":{"path":"/w/a.ts"},"extra":{"result":"permission denied","status":"error"}}')
check "hermes post error status" "$(jq -r .tool_response.exit_code <<<"$o")" "1"
o=$(adapt hermes '{"hook_event_name":"pre_verify","session_id":"h1","extra":{"attempt":0,"final_response":"Done."}}')
check "hermes pre_verify->Stop" "$(jq -r .hook_event_name,.last_assistant_message,.stop_hook_active <<<"$o" | paste -sd'|')" "Stop|Done.|false"
check "hermes later nudge marks stop_hook_active" "$(adapt hermes '{"hook_event_name":"pre_verify","extra":{"attempt":1}}' | jq -r .stop_hook_active)" "true"
check "hermes on_session_start->SessionStart" "$(adapt hermes '{"hook_event_name":"on_session_start","extra":{}}' | jq -r .hook_event_name)" "SessionStart"

# Canny verdicts out, Hermes wire shape back.
out() { printf '%s' "$2" | node "$ROOT/scripts/adapter.mjs" --out "$1"; }
BLOCK='{"decision":"block","reason":"no passing check"}'
DENYV='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"secret"}}'
check "hermes out pre_verify block" "$(out hermes "{\"event\":{\"hook_event_name\":\"pre_verify\"},\"verdict\":$BLOCK}" | jq -c .)" '{"decision":"block","reason":"no passing check"}'
check "hermes out deny -> block" "$(out hermes "{\"event\":{\"hook_event_name\":\"pre_tool_call\",\"tool_name\":\"write_file\"},\"verdict\":$DENYV}" | jq -c .)" '{"decision":"block","reason":"secret"}'
check "hermes out ask -> block" "$(out hermes '{"event":{"hook_event_name":"pre_tool_call"},"verdict":{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"sure?"}}}' | jq -r .decision)" "block"
o=$(out hermes '{"event":{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"npm test | tail","workdir":"/w"}},"verdict":{"hookSpecificOutput":{"updatedInput":{"command":"set -o pipefail; npm test | tail"}}}}')
check "hermes out rewrite -> modify" "$(jq -r .action,.args.command,.args.workdir <<<"$o" | paste -sd'|')" "modify|set -o pipefail; npm test | tail|/w"
check "hermes out note dropped" "$(out hermes '{"event":{"hook_event_name":"pre_tool_call"},"verdict":{"hookSpecificOutput":{"additionalContext":"fyi"}}}')" "{}"
check "hermes out post_tool_call dropped" "$(out hermes "{\"event\":{\"hook_event_name\":\"post_tool_call\"},\"verdict\":$BLOCK}")" "{}"

# Shadow mode (default): a blocking verdict is logged but the hook still answers {}.
cat > "$T/cli.js" <<'JS'
if (process.env.TYPESAFE_API_KEY) { process.stdout.write('{"leak":true}'); process.exit(0); }
process.stdout.write(process.env.FAKE_VERDICT || '{"decision":"block","reason":"no passing check"}');
JS
export CANNY_CLI="$T/cli.js" VERITY_HOME="$T/v" TYPESAFE_API_KEY=should-not-pass
hook() { printf '%s' "$2" | bash "$ROOT/scripts/verity-hook.sh" "$1"; }
STOP='{"hook_event_name":"Stop","session_id":"x"}'
for h in claude codex kimi gemini; do check "$h shadow answers {}" "$(hook $h "$STOP")" "{}"; done
check "hermes shadow answers {}" "$(hook hermes '{"hook_event_name":"pre_verify","session_id":"h","extra":{"attempt":0}}')" "{}"
check "verdicts logged" "$(wc -l < "$T/v/verdicts.jsonl" | tr -d ' ')" "5"
check "jev key stripped" "$(jq -r .verdict.decision "$T/v/verdicts.jsonl" | sort -u)" "block"
check "shadow not applied" "$(jq -r .applied "$T/v/verdicts.jsonl" | sort -u)" "false"
check "kind classified" "$(jq -r .kind "$T/v/verdicts.jsonl" | sort -u)" "done"
check "kill switch answers {}" "$(printf 'not json' | VERITY_DISABLE=1 bash "$ROOT/scripts/verity-hook.sh")" "{}"

# Mode CLI.
V="bash $ROOT/scripts/verity.sh"
$V mode live >/dev/null
check "cli global live" "$(jq -r .mode "$T/v/config.json")" "live"
$V mode shadow --harness kimi >/dev/null
check "cli harness override" "$(jq -r .harness.kimi.mode "$T/v/config.json")" "shadow"
$V mode live --checks nope >/dev/null 2>&1; check "cli rejects unknown check" "$?" "2"

# Live mode: Claude and Codex get Canny's verdict verbatim; Kimi and Gemini get it translated.
check "claude live passes verdict" "$(hook claude "$STOP" | jq -r .decision)" "block"
check "codex live passes verdict" "$(hook codex "$STOP" | jq -r .decision)" "block"
check "kimi override stays shadow" "$(hook kimi "$STOP")" "{}"
$V reset --harness kimi >/dev/null
check "kimi live stop -> deny" "$(hook kimi "$STOP" | jq -r .hookSpecificOutput.permissionDecision)" "deny"
check "gemini live stop -> block" "$(hook gemini '{"hook_event_name":"AfterAgent","session_id":"g"}' | jq -r .decision,.reason | paste -sd' ')" "block no passing check"
DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"secret"}}'
check "gemini live deny" "$(FAKE_VERDICT=$DENY hook gemini '{"hook_event_name":"BeforeTool","tool_name":"write_file","tool_input":{}}' | jq -r .decision)" "deny"
check "hermes live pre_verify -> block" "$(hook hermes '{"hook_event_name":"pre_verify","session_id":"h","extra":{"attempt":0}}' | jq -c .)" '{"decision":"block","reason":"no passing check"}'
check "hermes live deny -> block" "$(FAKE_VERDICT=$DENY hook hermes '{"hook_event_name":"pre_tool_call","tool_name":"write_file","tool_input":{"path":"/w/a.ts","content":"k"}}' | jq -r .decision,.reason | paste -sd' ')" "block secret"
check "hermes live post_tool_call answers {}" "$(hook hermes '{"hook_event_name":"post_tool_call","tool_name":"terminal","tool_input":{"command":"ls"},"extra":{"result":"{}"}}')" "{}"
check "hermes ledger has no text" "$(jq -r 'select(.harness=="hermes" and .target=="/w/a.ts") | (.bytes|tostring) + " " + (tostring|test("\"k\"")|tostring)' "$T/v/verdicts.jsonl")" "1 false"
check "kimi live deny" "$(FAKE_VERDICT=$DENY hook kimi '{"hook_event_name":"PreToolUse","tool_name":"Write"}' | jq -r .hookSpecificOutput.permissionDecisionReason)" "secret"
RW='{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"set -o pipefail; npm test | tail"},"additionalContext":"added pipefail"}}'
o=$(FAKE_VERDICT=$RW hook gemini '{"hook_event_name":"BeforeTool","tool_name":"run_shell_command","tool_input":{"command":"npm test | tail","dir_path":"/p"}}')
check "gemini rewrite keeps dir_path" "$(jq -r .hookSpecificOutput.tool_input.dir_path <<<"$o")" "/p"
check "gemini rewrite command" "$(jq -r .hookSpecificOutput.tool_input.command <<<"$o")" "set -o pipefail; npm test | tail"
check "kimi rewrite is advisory" "$(FAKE_VERDICT=$RW hook kimi '{"hook_event_name":"PreToolUse","tool_name":"Bash"}' | jq -r .message)" "added pipefail"
$V mode live --checks deny >/dev/null
check "check filter shadows other kinds" "$(hook claude "$STOP")" "{}"
check "check filter applies listed kind" "$(FAKE_VERDICT=$DENY hook claude '{"hook_event_name":"PreToolUse"}' | jq -r .hookSpecificOutput.permissionDecision)" "deny"
check "env overrides config" "$(VERITY_MODE=shadow FAKE_VERDICT=$DENY hook claude '{"hook_event_name":"PreToolUse"}')" "{}"
check "live applied logged" "$(jq -s 'map(select(.applied)) | length > 0' "$T/v/verdicts.jsonl")" "true"
check "bad verdict fails closed in live" "$(FAKE_VERDICT='not json' hook claude "$STOP" | jq -r .decision)" "block"
$V reset >/dev/null
check "reset to shadow" "$(hook claude "$STOP")" "{}"
# Fail closed: live mode with no analyzer refuses, in each harness's own shape.
$V mode live >/dev/null
check "hermes live missing analyzer blocks finish" "$(CANNY_CLI="$T/missing.js" hook hermes '{"hook_event_name":"pre_verify","extra":{"attempt":0}}' | jq -r .decision)" "block"
check "hermes live missing analyzer blocks tool" "$(CANNY_CLI="$T/missing.js" hook hermes '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"ls"}}' | jq -r .decision)" "block"
check "gemini live missing analyzer blocks finish" "$(CANNY_CLI="$T/missing.js" hook gemini '{"hook_event_name":"AfterAgent"}' | jq -r .decision)" "block"
check "gate_unavailable alarm logged" "$(jq -s 'map(select(.kind=="gate_unavailable")) | length' "$T/v/verdicts.jsonl")" "4"
$V reset >/dev/null
check "shadow missing analyzer answers {}" "$(CANNY_CLI="$T/missing.js" hook hermes '{"hook_event_name":"pre_verify"}')" "{}"
unset CANNY_CLI TYPESAFE_API_KEY VERITY_HOME

# Installer: wires all four harnesses, keeps existing hooks, and is idempotent.
# Canny needs Node 22+, so the installer refuses older Node; on older Node only that refusal is checked.
if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  mkdir -p "$T/home/.gemini" "$T/proj/.claude" "$T/canny/.git" "$T/canny/dist"
  echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$T/proj/.claude/settings.json"
  touch "$T/canny/dist/cli.js"
  git -C "$T/canny" init -q 2>/dev/null
  inst() { bash "$ROOT/scripts/install.sh" --harness claude,codex,kimi,gemini --project "$T/proj" --canny-dir "$T/canny" --backup-dir "$T/bk" >/dev/null 2>&1; }
  inst; check "installer exit" "$?" "0"; inst
  check "claude keeps existing hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$T/proj/.claude/settings.json")" "keep-me"
  check "claude wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.claude/settings.json")" "5"
  check "codex wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.codex/hooks.json")" "4"
  check "gemini wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/home/.gemini/settings.json")" "4"
  check "kimi wired once" "$(grep -c verity-hook "$T/home/.kimi-code/config.toml")" "5"
  check "custom canny dir passed" "$(grep -c "CANNY_DIR=$T/canny" "$T/home/.kimi-code/config.toml")" "5"
  check "backup written" "$(ls "$T/bk" | grep -c proj_.claude_settings)" "1"
  snippet=$(bash "$ROOT/scripts/install.sh" --canny-dir "$T/canny" --backup-dir "$T/bk" 2>&1)
  check "hermes installer exit" "$?" "0"
  check "hermes snippet has pre_verify" "$(grep -c '^  pre_verify:' <<<"$snippet")" "1"
  check "hermes snippet matcher" "$(grep -c 'matcher: "terminal|write_file|patch"' <<<"$snippet")" "2"
  check "hermes snippet passes canny dir" "$(grep -c "env CANNY_DIR=$T/canny bash .*verity-hook.sh hermes" <<<"$snippet")" "4"
  check "hermes installer writes no profile" "$(ls -A "$T/home" | grep -c hermes)" "0"
else
  echo "skip: installer wiring checks need Node 22 or newer (Canny's requirement); found $(node --version)"
  msg=$(bash "$ROOT/scripts/install.sh" --dry-run 2>&1); code=$?
  check "installer refuses old node" "$code|$(grep -c 'Canny needs Node 22 or newer' <<<"$msg")" "1|1"
fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
