#!/usr/bin/env bash
# Optional: install a pre-push hook that runs the leak gate on the full tree and on the outgoing diff.
# Refuses to replace a hook it did not write. Requires gitleaks (GITLEAKS_BIN or PATH).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
HOOKS="$(git rev-parse --git-path hooks)"
HOOK="$HOOKS/pre-push"
MARKER='# hermes-zouroboros leak gate'
if [ -e "$HOOK" ] && ! grep -qF "$MARKER" "$HOOK"; then
  printf 'Refusing to replace existing %s; chain it manually.\n' "$HOOK" >&2
  exit 1
fi
mkdir -p "$HOOKS"
cat > "$HOOK" <<'HOOK'
#!/usr/bin/env bash
# hermes-zouroboros leak gate
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
bun "$root/scripts/ci/leak-gate.ts" --root "$root"
zero=0000000000000000000000000000000000000000
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then base="$(git merge-base "$local_sha" origin/main 2>/dev/null || true)"; else base="$remote_sha"; fi
  [ -n "$base" ] || { echo 'leak gate: no base for the outgoing diff; full-tree gate only' >&2; continue; }
  bun "$root/scripts/ci/leak-gate.ts" --root "$root" --diff "$base"
done
HOOK
chmod 0755 "$HOOK"
printf 'Installed %s\n' "$HOOK"
if [ -z "${LEAK_GATE_SALT:-}" ] && [ ! -f "${LEAK_GATE_SALT_FILE:-$HOME/.config/hermes-zouroboros/leak-gate-salt}" ]; then
  printf 'Note: no identity salt at ~/.config/hermes-zouroboros/leak-gate-salt; persona-name and brand rules will skip. See docs/skills.md.\n'
fi
