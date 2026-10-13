# Sourced by the loop's bash scripts. Resolves host-specific paths at runtime; nothing is hard-coded.
#   REAL_HOME  account home from passwd (executors may run with a private $HOME)
#   CHECKOUT   the hermes-zouroboros checkout this skill tree lives in (empty if not inside one)
#   LOOP       loop home: $ZO_LOOP_HOME > $ZOUROBOROS_STATE_DIR/zouroboros-loop > <profile data>/state/zouroboros-loop
#   REPO       <owner>/<repo>: $ZO_LOOP_REPO > the checkout's GitHub origin
#   PROTECTED  paths the loop must never modify or run checks in
REAL_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
_zo_skills_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECKOUT=""; [[ -f "$_zo_skills_root/../integration/cli.ts" ]] && CHECKOUT="$(cd "$_zo_skills_root/.." && pwd)"
_zo_data="${HERMES_ZOUROBOROS_HOME:-$REAL_HOME/.local/share/hermes-zouroboros}"
LOOP="${ZO_LOOP_HOME:-${ZOUROBOROS_STATE_DIR:-$_zo_data/state}/zouroboros-loop}"
REPO="${ZO_LOOP_REPO:-}"
if [[ -z "$REPO" && -n "$CHECKOUT" ]]; then
  REPO="$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/.]+)(\.git)?$#\2#p')"
fi
PROTECTED=("$REAL_HOME/hermes-zouroboros"); [[ -n "$CHECKOUT" ]] && PROTECTED+=("$CHECKOUT")
zo_protected() { local p; p="$(realpath -m "$1")"; local x; for x in "${PROTECTED[@]}"; do x="$(realpath -m "$x")"; [[ "$p" == "$x" || "$p" == "$x"/* ]] && return 0; done; return 1; }
