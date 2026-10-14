#!/usr/bin/env python3
"""Record merged/closed for pr-open prescriptions from the GitHub API (never from assertion).

Usage: pr-sync.py --home LOOP_HOME [--dry-run]
For each prescription in state pr-open, reads the PR URL from the ledger's pr-opened event and asks
`gh pr view --json state,mergeCommit,mergedAt,closedAt`. MERGED → ledger `merged` (actor github,
source github-api, merged_sha); CLOSED → `closed`. OPEN → nothing. Read-only on GitHub.
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.realpath(__file__))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--home", required=True); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    L = [sys.executable, os.path.join(HERE, "ledger.py")]
    events = [json.loads(l) for l in open(os.path.join(a.home, "ledger.jsonl")) if l.strip()]
    st = json.loads(subprocess.run([*L, "state", "--home", a.home, "--json"], capture_output=True, text=True).stdout)["rx"]
    out = []
    for rx, info in st.items():
        if info["state"] != "pr-open":
            continue
        opened = [e for e in events if e.get("rx") == rx and e["event"] == "pr-opened"][-1]
        url = opened["data"]["pr_url"]
        p = subprocess.run(["gh", "pr", "view", url, "--json", "state,mergeCommit,mergedAt,closedAt"], capture_output=True, text=True)
        if p.returncode != 0:
            out.append({"rx": rx, "url": url, "error": p.stderr.strip()[:200]}); continue
        pr = json.loads(p.stdout)
        if pr["state"] == "MERGED":
            ev = ["merged", {"merged_sha": pr["mergeCommit"]["oid"], "source": "github-api", "merged_at": pr["mergedAt"], "pr_url": url}]
        elif pr["state"] == "CLOSED":
            ev = ["closed", {"source": "github-api", "closed_at": pr["closedAt"], "pr_url": url}]
        else:
            out.append({"rx": rx, "url": url, "state": pr["state"]}); continue
        rec = {"rx": rx, "url": url, "state": pr["state"], "event": ev[0]}
        if not a.dry_run:
            r = subprocess.run([*L, "event", "--home", a.home, "--cycle", info["cycle"], "--rx", rx, "--event", ev[0],
                                "--actor", "github", "--data", json.dumps(ev[1])], capture_output=True, text=True)
            rec["recorded"] = r.returncode == 0
            if r.returncode != 0:
                rec["error"] = r.stderr.strip()[:200]
        out.append(rec)
    print(json.dumps(out, indent=2))
    return 0 if all("error" not in x for x in out) else 1


if __name__ == "__main__":
    sys.exit(main())
