#!/usr/bin/env bash
# Hermetic tests: adapters, the hook in shadow/live for all seven harnesses, the three plugins,
# the mode CLI, state/catalog resolution, the Hermes config editor, the installer, and the real
# engine on a temp catalog (only when flashrank is importable; skipped otherwise).
# Runs in a throwaway HOME and never writes inside the skill tree (no bytecode either).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# The real-engine checks read an already downloaded model from the caller's cache (never download).
MODEL_CACHE="$(PYTHONDONTWRITEBYTECODE=1 python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import local_rank; print(local_rank.model_cache())")"
export HOME="$T/h0" PYTHONDONTWRITEBYTECODE=1; mkdir -p "$HOME"
unset WAYFINDER WAYFINDER_MODE WAYFINDER_HOOK WAYFINDER_SKILLS_ROOTS WAYFINDER_NATIVE_SKILLS ZOUROBOROS_STATE_DIR ZOUROBOROS_CACHE_DIR FLASHRANK_CACHE_DIR HERMES_HOME
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
HARNESSES="claude codex kimi gemini opencode pi hermes"

# State, cache and catalog resolution (no flashrank needed).
W="bash $ROOT/scripts/wayfinder.sh"
check "state falls back to ~/.wayfinder" "$($W where)" "$HOME/.wayfinder"
check "state under ZOUROBOROS_STATE_DIR" "$(ZOUROBOROS_STATE_DIR="$T/zs" $W where)" "$T/zs/wayfinder"
check "WAYFINDER_HOME wins" "$(WAYFINDER_HOME="$T/wh" ZOUROBOROS_STATE_DIR="$T/zs" $W where)" "$T/wh"
check "where and --help write nothing" "$($W --help >/dev/null; ls -A "$HOME" | wc -l)" "0"
check "engine state matches the hook" "$(ZOUROBOROS_STATE_DIR="$T/zs" python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import run; print(run.STATE)")" "$T/zs/wayfinder"
check "model cache under ZOUROBOROS_CACHE_DIR" "$(ZOUROBOROS_CACHE_DIR="$T/zc" python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import local_rank; print(local_rank.model_cache())")" "$T/zc/wayfinder"
check "FLASHRANK_CACHE_DIR wins" "$(FLASHRANK_CACHE_DIR="$T/fc" ZOUROBOROS_CACHE_DIR="$T/zc" python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import local_rank; print(local_rank.model_cache())")" "$T/fc"
if [ "$(basename "$(dirname "$(dirname "$ROOT")")")" = "skills" ]; then
  SK="$(cd "$ROOT/../.." && pwd)"
  check "default catalog is the checkout skills tree" "$(python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import catalog; print(catalog.roots_for())")" "['$SK']"
  check "category layout: wayfinder finds itself" "$(python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import catalog; print(sum(1 for i in catalog.load(catalog.roots_for()) if i['id'] == 'wayfinder' and i['source'].endswith('/zouroboros/wayfinder/SKILL.md')))")" "1"
else
  echo "skip: not installed under a skills/<category>/ tree, distribution catalog checks not run"
fi
mkdir -p "$T/hh/skills/own" "$T/cat/a/dup"
printf -- '---\nname: dup\ndescription: profile copy\n---\n' > "$T/hh/skills/own/SKILL.md"
printf -- '---\nname: dup\ndescription: catalog copy\n---\n' > "$T/cat/a/dup/SKILL.md"
check "hermes native skills come first when enabled" "$(HERMES_HOME="$T/hh" WAYFINDER_NATIVE_SKILLS=1 WAYFINDER_SKILLS_ROOTS="$T/cat" python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import catalog; print(catalog.load(catalog.roots_for('hermes'))[0]['description'])")" "profile copy"
check "native skills are opt-in" "$(HERMES_HOME="$T/hh" WAYFINDER_SKILLS_ROOTS="$T/cat" python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import catalog; print(catalog.load(catalog.roots_for('hermes'))[0]['description'])")" "catalog copy"

# Adapters: prompt extraction and output shape per harness.
py() { python3 -c "import sys; sys.path.insert(0, '$ROOT/engine'); import adapters, json; $1"; }
check "hermes prompt from extra" "$(py 'print(adapters.normalize("hermes", {"extra": {"user_message": "hi there"}})["prompt"])')" "hi there"
check "session prefixed" "$(py 'print(adapters.normalize("kimi", {"session_id": "s1", "prompt": "x"})["session_id"])')" "kimi-s1"
check "kimi content parts joined" "$(py 'print(adapters.normalize("kimi", {"prompt": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]})["prompt"])' | paste -sd' ')" "a b"
check "non-dict event tolerated" "$(py 'print(repr(adapters.normalize("claude", ["x"])["prompt"]))')" "''"
check "claude render" "$(py 'print(json.loads(adapters.render("claude", "T"))["hookSpecificOutput"]["additionalContext"])')" "T"
check "codex render event" "$(py 'print(json.loads(adapters.render("codex", "T"))["hookSpecificOutput"]["hookEventName"])')" "UserPromptSubmit"
check "gemini render event" "$(py 'print(json.loads(adapters.render("gemini", "T"))["hookSpecificOutput"]["hookEventName"])')" "BeforeAgent"
check "kimi render message" "$(py 'print(json.loads(adapters.render("kimi", "T"))["message"])')" "T"
for h in opencode pi hermes; do check "$h render plain" "$(py "print(adapters.render('$h', 'T'))")" "T"; done
check "kimi noop is empty" "$(py 'print(repr(adapters.render("kimi", None)))')" "''"
check "gemini noop is {}" "$(py 'print(adapters.render("gemini", None))')" "{}"

# Hook with a stub engine: records the command, and in live mode prints a marker.
cat > "$T/engine.py" <<'PY'
import sys, os, json
data = sys.stdin.read()
with open(os.environ['STUB_LOG'], 'a') as f: f.write(sys.argv[1] + ' ' + sys.argv[3] + '\n')
if os.environ.get('STUB_SLEEP'): import time; time.sleep(float(os.environ['STUB_SLEEP']))
if os.environ.get('STUB_FAIL'): sys.exit(3)
if sys.argv[1] == 'live': sys.stdout.write('LIVE:' + sys.argv[3])
PY
export WAYFINDER_ENGINE="$T/engine.py" WAYFINDER_HOME="$T/w" STUB_LOG="$T/stub.log"
hook() { printf '%s' '{"prompt":"make a poster for launch day"}' | bash "$ROOT/scripts/wayfinder-hook.sh" "$1"; }
for h in claude codex gemini; do check "$h shadow answers {}" "$(hook $h)" "{}"; done
for h in kimi opencode pi hermes; do check "$h shadow answers nothing" "$(hook $h)" ""; done
for _ in $(seq 50); do [ "$(wc -l < "$T/stub.log" 2>/dev/null || echo 0)" -ge 7 ] && break; sleep 0.1; done
check "shadow ran detached log for all 7" "$(grep -c '^log ' "$T/stub.log")" "7"
check "state dir private" "$(stat -c %a "$T/w")" "700"

V="bash $ROOT/scripts/wayfinder.sh"
$V mode live >/dev/null
for h in $HARNESSES; do check "$h live passes engine output" "$(hook $h)" "LIVE:$h"; done
$V mode shadow --harness pi >/dev/null
check "per-harness override" "$(hook pi)" ""
check "status shows override" "$($V status | awk '$1=="pi"{print $2}')" "shadow"
check "status shows global" "$($V status | awk '$1=="kimi"{print $2}')" "live"
check "live engine failure -> noop" "$(STUB_FAIL=1 hook claude)" "{}"
check "live engine timeout -> noop" "$(STUB_SLEEP=3 WAYFINDER_TIMEOUT=1 hook kimi)" ""
$V mode bogus >/dev/null 2>&1; check "cli rejects unknown mode" "$?" "2"
$V mode live --harness nope >/dev/null 2>&1; check "cli rejects unknown harness" "$?" "2"
$V off >/dev/null; check "kill switch" "$(hook claude)" "{}"; $V on >/dev/null
check "env kill switch" "$(WAYFINDER=0 hook hermes)" ""
$V mode live >/dev/null

# Plugins, each driven through its own harness API shape against the stub hook.
cat > "$T/oc.mjs" <<JS
const { Wayfinder } = await import("$ROOT/plugins/opencode/wayfinder.js");
const hooks = await Wayfinder({ directory: "/p" });
const out = { message: { id: "msg_test" }, parts: [{ type: "text", text: "make a poster for launch day" }] };
await hooks["chat.message"]({ sessionID: "s" }, out);
const empty = { message: {}, parts: [{ type: "file" }] };
await hooks["chat.message"]({ sessionID: "s" }, empty);
console.log(out.parts.length, out.parts[1]?.text, out.parts[1]?.synthetic, empty.parts.length);
if (out.parts[1] && (!out.parts[1].id.startsWith("prt_") || out.parts[1].sessionID !== "s" || out.parts[1].messageID !== "msg_test")) throw new Error("Invalid OpenCode part identifiers");
JS
check "opencode plugin injects synthetic part" "$(node "$T/oc.mjs")" "2 LIVE:opencode true 1"
cat > "$T/pi.mts" <<JS
const mod = await import("$ROOT/plugins/pi/wayfinder.ts");
let handler; mod.default({ on: (e, fn) => { if (e === "before_agent_start") handler = fn; } });
const r = await handler({ prompt: "make a poster for launch day" }, { cwd: "/p", sessionManager: { getSessionId: () => "s" } });
const none = await handler({ prompt: "" }, {});
console.log(r.message.customType, r.message.content, r.message.display, none === undefined);
JS
check "pi extension returns hidden message" "$(node --experimental-strip-types --no-warnings "$T/pi.mts" 2>/dev/null)" "wayfinder LIVE:pi false true"
check "hermes plugin returns context" "$(cd "$ROOT/plugins/hermes" && python3 -c '
import wayfinder
hooks = {}
wayfinder.register(type("C", (), {"register_hook": lambda self, n, f: hooks.__setitem__(n, f)})())
print(hooks["pre_llm_call"](session_id="s", user_message="make a poster for launch day")["context"], hooks["pre_llm_call"](user_message="  "))')" "LIVE:hermes None"
$V mode shadow >/dev/null
check "opencode plugin adds nothing in shadow" "$(node "$T/oc.mjs")" "1 undefined undefined 1"

# Hermes config editor.
he() { printf "$1" > "$T/h.yaml"; python3 "$ROOT/scripts/hermes_enable.py" "$T/h.yaml"; }
check "hermes empty list" "$(he 'a: 1\nplugins:\n  enabled: []\nb: 2\n' | sed -n 3p)" "  enabled: [wayfinder]"
check "hermes flow list" "$(he 'plugins:\n  enabled: [x, "y"]\n' | sed -n 2p)" "  enabled: [x, y, wayfinder]"
check "hermes block list" "$(he 'plugins:\n  enabled:\n  - x\nz: 1\n' | sed -n 4p)" "  - wayfinder"
check "hermes idempotent" "$(he 'plugins:\n  enabled: [wayfinder]\n' | sed -n 2p)" "  enabled: [wayfinder]"
check "hermes keeps other lines" "$(he '# c\nplugins:\n  enabled: []\nq: 3\n' | sed -n '1p;4p' | paste -sd' ')" "# c q: 3"
mkdir -p "$T/hp"; printf 'plugins:\n  enabled: []\n' > "$T/hp/config.yaml"
check "hermes editor takes an explicit --hermes-home" "$(python3 "$ROOT/scripts/hermes_enable.py" --hermes-home "$T/hp" | sed -n 2p)" "  enabled: [wayfinder]"
python3 "$ROOT/scripts/hermes_enable.py" >/dev/null 2>&1; check "hermes editor has no default profile" "$?" "2"
check "hermes editor prints, never writes" "$(cat "$T/hp/config.yaml" | sed -n 2p)" "  enabled: []"

# Installer, in a throwaway HOME, project and Hermes profile.
H="$T/home"; P="$T/proj"; HH="$T/hermes-profile"; mkdir -p "$H/.gemini" "$H/.kimi-code" "$HH" "$P/.claude"
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$P/.claude/settings.json"
echo '{"hooks":{"BeforeTool":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$H/.gemini/settings.json"
printf 'model = "k"\n' > "$H/.kimi-code/config.toml"
printf 'model: m\nplugins:\n  enabled: []\n' > "$HH/config.yaml"
snapshot() { (cd "$T" && find home proj hermes-profile -printf '%p %s %l\n' 2>/dev/null | sort; cat "$HH/config.yaml" "$P/.claude/settings.json") | sha256sum; }
before="$(snapshot)"
HOME="$H" WAYFINDER_HOME="$T/iw" bash "$ROOT/scripts/install.sh" --project "$P" >/dev/null 2>&1
check "hermes without an explicit profile refuses" "$?" "2"
HOME="$H" WAYFINDER_HOME="$T/iw" bash "$ROOT/scripts/install.sh" --project "$P" --hermes-home "$T/nope" >/dev/null 2>&1
check "missing hermes profile refuses" "$?" "2"
HOME="$H" WAYFINDER_HOME="$T/iw" bash "$ROOT/scripts/install.sh" --harness "${HARNESSES// /,}" --project "$P" --hermes-home "$HH" --dry-run >/dev/null 2>&1
check "dry-run exit" "$?" "0"
check "refusals and dry-run write nothing" "$(snapshot)" "$before"
check "dry-run creates no state dir" "$([ -e "$T/iw" ] && echo created || echo none)" "none"
inst() { HOME="$H" WAYFINDER_HOME="$T/iw" bash "$ROOT/scripts/install.sh" --harness "${HARNESSES// /,}" --project "$P" --hermes-home "$HH" "$@"; }
inst >/dev/null 2>&1; check "installer exit" "$?" "0"
check "claude wired once" "$(jq -r '[.hooks.UserPromptSubmit[].hooks[].command] | map(select(test("wayfinder-hook"))) | length' "$P/.claude/settings.json")" "1"
check "claude command" "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$P/.claude/settings.json" | sed 's#.*/##')" "wayfinder-hook.sh claude"
check "claude other hooks kept" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$P/.claude/settings.json")" "keep-me"
check "codex wired" "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$P/.codex/hooks.json" | sed 's#.*/##')" "wayfinder-hook.sh codex"
check "gemini wired, ms timeout" "$(jq -r '.hooks.BeforeAgent[0].hooks[0].timeout' "$H/.gemini/settings.json")" "6000"
check "gemini other hooks kept" "$(jq -r '.hooks.BeforeTool[0].hooks[0].command' "$H/.gemini/settings.json")" "keep-me"
check "kimi toml valid" "$(python3 -c "import tomllib; d=tomllib.load(open('$H/.kimi-code/config.toml','rb')); print(d['hooks'][0]['event'], d['model'])")" "UserPromptSubmit k"
check "opencode plugin linked" "$(readlink "$H/.config/opencode/plugin/wayfinder.js")" "$ROOT/plugins/opencode/wayfinder.js"
check "pi extension linked" "$(readlink "$H/.pi/agent/extensions/wayfinder.ts")" "$ROOT/plugins/pi/wayfinder.ts"
check "hermes plugin linked into the given profile" "$(readlink "$HH/plugins/wayfinder")" "$ROOT/plugins/hermes/wayfinder"
check "hermes enabled in the given profile" "$(grep 'enabled:' "$HH/config.yaml")" "  enabled: [wayfinder]"
check "default ~/.hermes untouched" "$([ -e "$H/.hermes" ] && echo touched || echo untouched)" "untouched"
backups="$(ls "$T/iw/backups" | wc -l)"
inst >/dev/null 2>&1; check "rerun exit" "$?" "0"
check "rerun writes no backups" "$(ls "$T/iw/backups" | wc -l)" "$backups"
check "rerun reports wired (7 harnesses + hermes enable)" "$(inst --dry-run 2>/dev/null | grep -c already)" "8"
inst --harness nope >/dev/null 2>&1; check "installer rejects unknown harness" "$?" "2"

# Real engine on a temp catalog (needs flashrank and the downloaded model; skipped without them).
if ! python3 -c 'import flashrank' 2>/dev/null; then
  echo "skip: flashrank not importable, real-engine checks not run"
elif [ ! -d "$MODEL_CACHE/ms-marco-MiniLM-L-12-v2" ]; then
  echo "skip: ranking model not downloaded (scripts/setup_model.py), real-engine checks not run"
else
  export FLASHRANK_CACHE_DIR="$MODEL_CACHE"
  S="$T/skills"; mkdir -p "$S/fal-media" "$S/cat/email-send" "$S/_hidden/x"
  printf -- '---\nname: fal-media\ndescription: Generate or edit images and videos, posters, thumbnails.\n---\n' > "$S/fal-media/SKILL.md"
  printf -- '---\nname: email-send\ndescription: Send or reply to email threads.\n---\n' > "$S/cat/email-send/SKILL.md"
  printf -- '---\nname: hidden\ndescription: should never load\n---\n' > "$S/_hidden/x/SKILL.md"
  unset WAYFINDER_ENGINE
  out="$(printf '%s' '{"prompt":"generate a poster image for the launch","session_id":"s"}' | WAYFINDER_SKILLS_ROOTS="$S" WAYFINDER_MODE=live bash "$ROOT/scripts/wayfinder-hook.sh" gemini)"
  check "real engine picks and injects" "$(jq -r '.hookSpecificOutput.additionalContext' <<<"$out" | grep -o 'fal-media' | head -1)" "fal-media"
  check "real engine catalog excludes _dirs" "$(tail -1 "$T/w/suggestions.jsonl" | jq -r '.catalog_size, .harness, .injected' | paste -sd' ')" "2 gemini true"
  check "log has no prompt text" "$(grep -c 'poster' "$T/w/suggestions.jsonl")" "0"

  # Factory caller path: a non-hook harness with no stdin pipe of its own.
  E='{"prompt":"generate a poster image for the launch","session_id":"t1","cwd":"/tmp"}'
  FH="$T/fh"; mkdir -p "$FH"
  printf '%s' "$E" | WAYFINDER_HOME="$FH" python3 "$ROOT/engine/run.py" log --harness factory >/dev/null 2>"$T/refused.txt"
  check "factory refuses the hook path" "$?" "2"
  check "refusal names the hook path" "$(grep -c 'hook path' "$T/refused.txt")" "1"
  WAYFINDER_HOME="$FH" WAYFINDER_SKILLS_ROOTS="$S" python3 "$ROOT/engine/run.py" log \
    --harness factory --invocation-id inv-1 --event-json "$E" </dev/null >/dev/null 2>&1
  check "factory logs with no stdin" "$?" "0"
  check "row is per-invocation" "$([ -s "$FH/invocations/inv-1/shadow.jsonl" ] && echo yes)" "yes"
  check "shared log stays clean" "$([ -e "$FH/suggestions.jsonl" ] && echo dirty || echo clean)" "clean"
  check "factory row is shadow" "$(jq -r '.mode' "$FH/invocations/inv-1/shadow.jsonl")" "shadow"
  check "row echoes the invocation id" "$(jq -r '.invocation_id' "$FH/invocations/inv-1/shadow.jsonl")" "inv-1"
  check "row resolves a pick path" "$(jq -r '.pick_path' "$FH/invocations/inv-1/shadow.jsonl" | grep -c 'fal-media/SKILL.md')" "1"
  check "row records the catalog root" "$(jq -r '.skills_root' "$FH/invocations/inv-1/shadow.jsonl")" "$S"
  check "row stores no prompt text" "$(grep -c 'poster' "$FH/invocations/inv-1/shadow.jsonl")" "0"
  WAYFINDER_HOME="$FH" WAYFINDER_SKILLS_ROOTS="$S" python3 "$ROOT/engine/run.py" log \
    --harness factory --invocation-id ../escape --event-json "$E" </dev/null >/dev/null 2>&1
  check "traversal id writes nothing" "$([ -e "$T/escape" ] && echo leaked || echo safe)" "safe"
  WAYFINDER_HOME="$FH" python3 "$ROOT/engine/run.py" outcome --harness factory --session t1 \
    --pick fal-media --used 1 --detail "$S/fal-media/SKILL.md" >/dev/null 2>&1
  check "factory outcome accepted" "$?" "0"
  check "outcome visible in the report" "$(WAYFINDER_HOME="$FH" python3 "$ROOT/engine/run.py" report | jq -r '.outcomes_by_harness.factory.labeled // "missing"')" "1"
fi

# The gate-ordering checker. Run before the rest so a malformed workflow spec
# fails the suite rather than sitting unnoticed behind 200 passing checks.
if python3 "$ROOT/test/dag.py"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL dag checker"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
