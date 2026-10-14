#!/usr/bin/env bash
# Push a CERTIFIED loop branch and open a DRAFT pull request. Never merges.
# Usage: open-pr.sh <loop-home> <cycle> <rx.json> <evolve-record.json> <verify-report.json>
# Pre-flight (all must hold, else exit 3 before anything leaves the machine):
#   - ledger chain verifies; RX state is `certified`
#   - the approval scope includes push-branch AND open-draft-pr, and the prescription digest is unchanged
#   - the verify report's verdict is certified for exactly the evolve record's head SHA
#   - the worktree is clean at that head; the branch name starts with zo-loop/
# After the PR exists, records `pr-opened` in the ledger (the ledger re-checks scope and digest).
set -euo pipefail
die() { printf 'open-pr: %s\n' "$1" >&2; exit 3; }
HOME_DIR="${1:?loop home}"; CYCLE="${2:?cycle}"; RX="${3:?rx.json}"; EVO="${4:?evolve record}"; VER="${5:?verify report}"
LOOP="$(cd "$(dirname "$0")/../../zouroboros-loop/scripts" && pwd)"; L="python3 $LOOP/ledger.py"
TPL="$(cd "$(dirname "$0")/.." && pwd)/templates/PR_BODY.md"
id=$(jq -r .id "$RX"); branch=$(jq -r .branch "$EVO"); head=$(jq -r .head_sha "$EVO"); wt=$(jq -r .worktree "$EVO")
$L verify --home "$HOME_DIR" >/dev/null || die "ledger chain failed verification"
st=$($L state --home "$HOME_DIR" --rx "$id" --json)
[[ "$(jq -r --arg r "$id" '.rx[$r].state' <<<"$st")" == certified ]] || die "$id is not certified"
scope=$(jq -r --arg r "$id" '.rx[$r].approval.scope | join(",")' <<<"$st")
[[ ",$scope," == *",push-branch,"* && ",$scope," == *",open-draft-pr,"* ]] || die "approval scope '$scope' lacks push-branch/open-draft-pr"
[[ "$(jq -r --arg r "$id" '.rx[$r].approval.rx_digest' <<<"$st")" == "$($L digest "$RX")" ]] || die "prescription changed since approval"
[[ "$(jq -r .verdict "$VER")" == certified && "$(jq -r .head_sha "$VER")" == "$head" ]] || die "verify report is not certified for $head"
[[ "$branch" == zo-loop/* ]] || die "branch must start with zo-loop/"
[[ "$(git -C "$wt" rev-parse HEAD)" == "$head" && -z "$(git -C "$wt" status --porcelain)" ]] || die "worktree not clean at $head"
repo=$(jq -r .base.repo "$RX")
# Constitution Art. V relies on branch protection; state the actual protection status in the PR.
if gh api "repos/$repo/branches/main/protection" >/dev/null 2>&1; then
  export ZO_PROTECTION_NOTE="\`main\` is protected on this repository; the merge still requires human review."
else
  export ZO_PROTECTION_NOTE="⚠️ \`main\` has **no branch protection** on this repository. Your review is the only selection barrier: CI does not block a merge."
fi
body=$(mktemp /tmp/zo-task-prbody-XXXXXX)
python3 - "$TPL" "$RX" "$EVO" "$VER" > "$body" <<'EOF'
import json, sys
tpl, rx, evo, ver = open(sys.argv[1]).read(), *(json.load(open(p)) for p in sys.argv[2:])
fill = {"RX_ID": rx["id"], "TITLE": rx["title"], "DEFECTS": ", ".join(rx["defects"]), "KIND": rx["kind"], "SPEC": rx["spec"],
        "RATIONALE": rx["rationale"], "TIER": rx["governor"]["tier"], "FLAGS": "; ".join(f"{f['tier']}:{f['rule']}" for f in rx["governor"]["flags"]) or "none",
        "BASE": evo["base_sha"], "HEAD": evo["head_sha"], "DIFFSTAT": evo["diffstat"], "ROLLBACK": rx["rollback"],
        "CHECKS": "\n".join(f"- `{c['id']}` {c.get('description','')}" for c in rx["acceptance_checks"]),
        "VERDICT": ver["verdict"], "VERIFY_SUMMARY": ver.get("summary", ""), "VERIFY_DIGEST": ver.get("report_digest", ""),
        "PROTECTION_NOTE": __import__("os").environ.get("ZO_PROTECTION_NOTE", "Branch protection status unknown; treat your review as the only barrier.")}
for k, v in fill.items():
    tpl = tpl.replace("{{" + k + "}}", str(v))
print(tpl)
EOF
git -C "$wt" push --set-upstream origin "$branch"
url=$(gh pr create --repo "$repo" --draft --base main --head "$branch" --title "[$id] $(jq -r .title "$RX")" --body-file "$body")
rm -f "$body"
$L event --home "$HOME_DIR" --cycle "$CYCLE" --rx "$id" --event pr-opened --actor evolve --rx-file "$RX" --evidence "$VER" --data "{\"pr_url\":\"$url\",\"head_sha\":\"$head\"}"
echo "$url"
