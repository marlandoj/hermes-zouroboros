#!/usr/bin/env bash
# Prove an installed Hermes discovers the distribution skills through skills.external_dirs.
# Uses a throwaway HERMES_HOME; never reads or writes an existing Hermes profile.
# Usage: bash scripts/verify-hermes-skills.sh [extra-skills-dir ...]
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
HERMES="${HERMES_BIN:-hermes}"
command -v "$HERMES" >/dev/null || { echo "Hermes not found; set HERMES_BIN" >&2; exit 1; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/hermes-skills-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
dirs=("$PWD/skills" "$@")
{ echo 'skills:'; echo '  external_dirs:'; for dir in "${dirs[@]}"; do printf '    - %s\n' "$(cd "$dir" && pwd)"; done; } > "$scratch/config.yaml"
listing="$(HERMES_HOME="$scratch" COLUMNS=250 timeout 180 "$HERMES" skills list --source local)"
missing=0 found=0
while IFS= read -r skill_md; do
  name="$(sed -n '2,/^---$/s/^name:[[:space:]]*["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}[[:space:]]*$/\1/p' "$skill_md" | head -1)"
  if grep -qE "│ ${name} +│" <<<"$listing"; then found=$((found + 1)); else echo "NOT DISCOVERED: ${name:-?} (${skill_md})" >&2; missing=$((missing + 1)); fi
done < <(for dir in "${dirs[@]}"; do find "$dir" -mindepth 3 -maxdepth 3 -name SKILL.md; done | sort)
echo "hermes skill discovery: ${found} discovered, ${missing} missing"
[ "$missing" -eq 0 ]
