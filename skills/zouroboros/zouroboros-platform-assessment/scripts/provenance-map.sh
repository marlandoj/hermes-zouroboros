#!/usr/bin/env bash
# Identify which upstream revision an untracked checkout corresponds to, file by file.
# Read-only on the checkout. Needs `gh` auth for private repos.
# Usage: provenance-map.sh <checkout> <owner/repo> <evidence-dir> [scratch-dir]
set -uo pipefail
[[ $# -ge 3 ]] || { echo "Usage: $0 <checkout> <owner/repo> <evidence-dir> [scratch]" >&2; exit 2; }
L="$1"; REPO="$2"; A="$3"; S="${4:-$(mktemp -d /tmp/zo-task-prov-XXXXXX)}"
mkdir -p "$A"
if [[ -d "$L/.git" ]]; then
  git -C "$L" log -1 --format='tracked checkout: %H %cI %s' | tee "$A/provenance.txt"; git -C "$L" status --short | tee -a "$A/provenance.txt"; exit 0
fi
gh repo clone "$REPO" "$S/remote" -- --quiet || exit 1
cd "$S/remote" || exit 1
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/pr/*' 2>/dev/null
# 1. closest commit across all branches and PR heads
best=""; bestn=999999
for c in $(git rev-list --all | head -400); do
  n=$(git --work-tree="$L" diff --name-only "$c" -- . 2>/dev/null | wc -l)
  (( n < bestn )) && { bestn=$n; best=$c; }
done
main=$(git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main)
{
  echo "closest_commit=$(git log -1 --format='%h %cI %s' "$best") differing_files=$bestn"
  echo "upstream_head=$(git log -1 --format='%h %cI %s' "$main") commits_ahead_of_closest=$(git rev-list --count "$best..$main")"
} | tee "$A/provenance.txt"
# 2. per-file origin of every differing file
out="$A/provenance-file-map.tsv"; printf 'path\tstatus_vs_closest\tlocal_blob_first_seen\tsame_as_upstream_head\n' > "$out"
git --work-tree="$L" diff --name-status "$best" -- . | while read -r st f; do
  if [[ -f "$L/$f" ]]; then lh=$(git hash-object "$L/$f"); c=$(git log --all --reverse --format='%h %cs' --find-object="$lh" | head -1); else lh=""; c="(missing locally)"; fi
  mh=$(git rev-parse -q --verify "$main:$f" 2>/dev/null); [[ -n "$lh" && "$mh" == "$lh" ]] && sm=yes || sm=no
  printf '%s\t%s\t%s\t%s\n' "$f" "$st" "${c:-NOWHERE-UPSTREAM}" "$sm"
done >> "$out"
# 3. local files absent from the closest commit (excluding build output)
(cd "$L" && find . -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path './.git*' -not -name '*.tsbuildinfo' -not -path '*/__pycache__/*' | sed 's|^\./||' | sort) > "$S/local.txt"
git ls-tree -r --name-only "$best" | sort > "$S/closest.txt"
comm -23 "$S/local.txt" "$S/closest.txt" | while read -r f; do
  lh=$(git hash-object "$L/$f"); c=$(git log --all --reverse --format='%h %cs' --find-object="$lh" | head -1)
  printf '%s\tLOCAL-ONLY\t%s\tno\n' "$f" "${c:-NOWHERE-UPSTREAM}"
done >> "$out"
echo "files found in no upstream commit: $(awk -F'\t' '$3=="NOWHERE-UPSTREAM"' "$out" | wc -l)" | tee -a "$A/provenance.txt"
