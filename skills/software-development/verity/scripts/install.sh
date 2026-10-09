#!/usr/bin/env bash
# Installs Canny (qkal/Canny by Kal, MIT; cloned at a pinned commit, not vendored) and wires
# the Verity hook into the chosen harnesses, in shadow mode. Every config file is backed up
# before it is touched, and re-running is idempotent.
#
# Usage: install.sh [--harness hermes,claude,codex,kimi,gemini] [--project DIR] [--canny-dir DIR]
#                   [--backup-dir DIR] [--dry-run]
#   --harness     default: hermes. For Hermes the installer only PRINTS the config.yaml hooks
#                 snippet; it never writes into a Hermes profile.
#   --project     directory whose .claude/settings.json and .codex/hooks.json get the hooks
#                 (default: current directory). Kimi and Gemini configs are user-global.
set -euo pipefail

CANNY_REPO="https://github.com/qkal/Canny"
CANNY_PIN="f2c5e53779445d60dc4a09d2dbced2308fccb820"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/verity-hook.sh"

DATA="${HERMES_ZOUROBOROS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hermes-zouroboros}"
DEFAULT_CANNY_DIR="${ZOUROBOROS_DATA_DIR:-$DATA}/integrations/canny"
VERITY_HOME="${VERITY_HOME:-${ZOUROBOROS_STATE_DIR:-$DATA/state}/verity}"

HARNESSES="hermes"
PROJECT="$PWD"
CANNY_DIR="${CANNY_DIR:-$DEFAULT_CANNY_DIR}"
BACKUP_DIR="${BACKUP_DIR:-$VERITY_HOME/backups}"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESSES="$2"; shift 2 ;;
    --project) PROJECT="$(cd "$2" && pwd)"; shift 2 ;;
    --canny-dir) CANNY_DIR="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,11p "$0" | sed "s/^# \{0,1\}//"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for bin in node jq git; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "Canny needs Node 22 or newer" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
backup() {
  [ -f "$1" ] || return 0
  local dest="$BACKUP_DIR/$(echo "$1" | tr / _).pre-verity-$STAMP"
  run mkdir -p -m 700 "$BACKUP_DIR"
  run cp -p "$1" "$dest"
  echo "backed up $1 -> $dest"
}

if [ -d "$CANNY_DIR/.git" ]; then
  have="$(git -C "$CANNY_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  [ "$have" = "$CANNY_PIN" ] || echo "warning: $CANNY_DIR is at $have, pin is $CANNY_PIN" >&2
else
  run mkdir -p "$(dirname "$CANNY_DIR")"
  run git clone --quiet "$CANNY_REPO" "$CANNY_DIR"
  run git -C "$CANNY_DIR" checkout --quiet "$CANNY_PIN"
fi
[ "$DRY" = 1 ] || [ -f "$CANNY_DIR/dist/cli.js" ] || { echo "no dist/cli.js in $CANNY_DIR" >&2; exit 1; }

# Hermes runs hook commands without a shell, so a non-default Canny dir goes through env(1).
cmd() { local c="bash $HOOK $1"; [ "$CANNY_DIR" = "$DEFAULT_CANNY_DIR" ] || c="env CANNY_DIR=$CANNY_DIR $c"; echo "$c"; }

# Adds one hook group per event unless a group already calls this wrapper.
merge_json() {
  local file="$1" spec="$2" tmp
  run mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"
  jq --argjson spec "$spec" '
    .hooks //= {} |
    reduce ($spec | to_entries[]) as $e (.;
      if ((.hooks[$e.key] // []) | tostring | test("verity-hook")) then .
      else .hooks[$e.key] = ((.hooks[$e.key] // []) + [$e.value]) end)' <(if [ -f "$file" ]; then cat "$file"; else echo '{}'; fi) > "$tmp"
  if [ -f "$file" ] && [ "$(jq -S . "$file")" = "$(jq -S . "$tmp")" ]; then rm -f "$tmp"; echo "already wired $file"; return; fi
  if [ "$DRY" = 1 ]; then rm -f "$tmp"; echo "[dry-run] merge into $file: $spec"; return; fi
  backup "$file"
  mv "$tmp" "$file"
  echo "wired $file"
}

group() { # command timeout [matcher]
  jq -nc --arg c "$1" --argjson t "$2" --arg m "${3:-}" \
    '{hooks: [{type: "command", command: $c, timeout: $t}]} + (if $m == "" then {} else {matcher: $m} end)'
}

install_claude() {
  local c; c="$(cmd claude)"
  local edit="Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"
  merge_json "$PROJECT/.claude/settings.json" "$(jq -nc \
    --argjson s "$(group "$c" 10)" --argjson pre "$(group "$c" 10 "$edit")" \
    --argjson post "$(group "$c" 15 "$edit")" --argjson fail "$(group "$c" 15 "Bash|PowerShell")" \
    --argjson stop "$(group "$c" 15)" \
    '{SessionStart: $s, PreToolUse: $pre, PostToolUse: $post, PostToolUseFailure: $fail, Stop: $stop}')"
}

install_codex() {
  local c; c="$(cmd codex)"
  local g; g() { jq -nc --arg c "$c" --argjson t "$1" --arg m "${2:-}" \
    '{hooks: [{type: "command", command: $c, timeout: $t, statusMessage: "Verity"}]} + (if $m == "" then {} else {matcher: $m} end)'; }
  merge_json "$PROJECT/.codex/hooks.json" "$(jq -nc \
    --argjson s "$(g 10)" --argjson pre "$(g 10 'Bash|apply_patch')" \
    --argjson post "$(g 15 'Bash|apply_patch')" --argjson stop "$(g 15)" \
    '{SessionStart: $s, PreToolUse: $pre, PostToolUse: $post, Stop: $stop}')"
  echo "note: Codex runs new hooks only after you trust them once with /hooks in an interactive session"
}

install_gemini() {
  local c; c="$(cmd gemini)"
  local tools='^(write_file|replace|run_shell_command)$'
  merge_json "$HOME/.gemini/settings.json" "$(jq -nc \
    --argjson s "$(group "$c" 10000)" --argjson pre "$(group "$c" 10000 "$tools")" \
    --argjson post "$(group "$c" 15000 "$tools")" --argjson stop "$(group "$c" 15000)" \
    '{SessionStart: $s, BeforeTool: $pre, AfterTool: $post, AfterAgent: $stop}')"
}

# Hermes: print the hooks snippet for the profile's config.yaml. Writing YAML into a live
# profile is left to the operator, who also approves each hook on first use.
install_hermes() {
  local c; c="$(cmd hermes)"
  cat <<YAML
# Add to the hooks: section of your Hermes profile's config.yaml (merge with existing events):
hooks:
  on_session_start:
    - command: "$c"
      timeout: 10
  pre_tool_call:
    - matcher: "terminal|write_file|patch"
      command: "$c"
      timeout: 15
  post_tool_call:
    - matcher: "terminal|write_file|patch"
      command: "$c"
      timeout: 15
  pre_verify:
    - command: "$c"
      timeout: 15
YAML
  echo "hermes: snippet printed above; nothing was written to a Hermes profile"
}

install_kimi() {
  local file="$HOME/.kimi-code/config.toml" c; c="$(cmd kimi)"
  if [ -f "$file" ] && grep -q verity-hook "$file"; then echo "already wired $file"; return; fi
  backup "$file"
  local block
  block="$(printf '\n[[hooks]]\nevent = "%s"\n%scommand = "%s"\ntimeout = %s\n' \
    SessionStart "" "$c" 10 \
    PreToolUse 'matcher = "^(Bash|Write|Edit)$"\n' "$c" 10 \
    PostToolUse 'matcher = "^(Bash|Write|Edit)$"\n' "$c" 15 \
    PostToolUseFailure 'matcher = "^Bash$"\n' "$c" 15 \
    Stop "" "$c" 15)"
  if [ "$DRY" = 1 ]; then echo "[dry-run] append to $file:"; printf '%b\n' "$block"; return; fi
  mkdir -p "$(dirname "$file")"
  printf '%b\n' "$block" >> "$file"
  echo "wired $file"
}

IFS=, read -ra list <<< "$HARNESSES"
for h in "${list[@]}"; do
  case "$h" in
    hermes|claude|codex|kimi|gemini) "install_$h" ;;
    *) echo "unsupported harness: $h (supported: hermes, claude, codex, kimi, gemini)" >&2; exit 2 ;;
  esac
done
run mkdir -p -m 700 "${CANNY_HOME:-$HOME/.canny}" "$VERITY_HOME"
echo "done, in shadow mode. status: bash $DIR/verity.sh status   go live: bash $DIR/verity.sh mode live"
