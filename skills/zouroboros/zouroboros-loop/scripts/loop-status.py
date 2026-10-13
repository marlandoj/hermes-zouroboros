#!/usr/bin/env python3
"""Where is the loop, what happens next, and who owns it? Derived only from the ledger (read-only).

Usage: loop-status.py --home LOOP_HOME [--cycle C] [--json]
Exit 0 = the agent has work it may do now; 4 = paused (every next step needs the operator, or a
stop condition holds); 3 = ledger invalid.

Stop conditions (references/loop-contract.md): chain invalid; budget exhausted; ≥2 consecutive
failed in a cycle; retry limit reached; any regressed; >3 active PR prescriptions; stagnation
(no confirmed across the last 2 closed cycles).
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.realpath(__file__))
ACTIVE = {"approved", "evolving", "evolved", "verifying", "certified", "pr-open"}
NEXT = {  # state -> (owner, action)
    "proposed": ("operator", "review PRESCRIPTIONS.md; approve with scope (evolve-local[, push-branch, open-draft-pr]) or reject"),
    "approved": ("agent", "zouroboros-loop-evolve: ledger start → worktree → red → green → record → branch-ready"),
    "evolving": ("agent", "resume evolve in the existing worktree, or abandon (repo.sh worktree-remove + ledger abandon)"),
    "evolved": ("agent", "zouroboros-loop-verify: verify.py"),
    "verifying": ("agent", "verify in progress; if it crashed, ledger verify-abort --note … then re-run verify"),
    "certified": ("operator", "decide: open draft PR (needs push-branch + open-draft-pr scope; then evolve open-pr.sh) or withdraw"),
    "pr-open": ("agent", "pr-sync.py (records merged/closed from the GitHub API); human reviews and merges"),
    "merged": ("agent", "after deploy, run the platform assessment; record confirmed/regressed from its matrix"),
    "failed": ("operator", "read VERIFY-<rx>.md; approve a retry (≤2) or abandon"),
    "inconclusive": ("operator", "supply the missing evidence (known-failures entry, held-out probe, re-derive) then approve a retry, or abandon"),
    "regressed": ("agent", "prescribe a new heal for the regression (stop condition: operator attention first)"),
}
TERMINAL = {"rejected", "withdrawn", "abandoned", "closed", "confirmed"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--home", required=True); ap.add_argument("--cycle"); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    L = [sys.executable, os.path.join(HERE, "ledger.py")]
    v = subprocess.run([*L, "verify", "--home", a.home], capture_output=True, text=True)
    if v.returncode != 0:
        print(json.dumps({"paused": True, "stop": ["ledger chain invalid: " + v.stderr.strip()]})); return 3
    st = json.loads(subprocess.run([*L, "state", "--home", a.home, "--json"], capture_output=True, text=True).stdout)
    rxs, cycles = st["rx"], st["cycles"]
    if a.cycle:
        rxs = {k: v for k, v in rxs.items() if v["cycle"] == a.cycle}; cycles = {k: v for k, v in cycles.items() if k == a.cycle}
    stops = []
    for c, info in cycles.items():
        if info["open"] and (info["spent_calls"] > info["budget_calls"] or info["spent_usd"] > info["budget_usd"]):
            stops.append(f"{c}: budget exhausted")
        if info["failed_streak"] >= 2:
            stops.append(f"{c}: {info['failed_streak']} consecutive failed verifications")
    for k, r in rxs.items():
        if r["state"] == "regressed":
            stops.append(f"{k}: regressed after merge")
        if r["retries"] >= 2 and r["state"] in ("failed", "inconclusive"):
            stops.append(f"{k}: retry limit reached")
    active_pr = [k for k, r in rxs.items() if r["state"] in ACTIVE]
    if len(active_pr) > 3:
        stops.append(f"{len(active_pr)} active prescriptions (> 3)")
    closed = [c for c, i in sorted(cycles.items()) if not i["open"]]
    if len(closed) >= 2 and not any(r["state"] == "confirmed" and r["cycle"] in closed[-2:] for r in rxs.values()):
        stops.append("stagnation: no confirmed improvement across the last 2 closed cycles")
    rows = []
    for k, r in sorted(rxs.items()):
        owner, action = NEXT.get(r["state"], ("none", "terminal") if r["state"] in TERMINAL else ("unknown", "inspect ledger"))
        tier = None
        f = os.path.join(a.home, "cycles", r["cycle"] or "", "prescriptions", f"{k}.json")
        if os.path.exists(f):
            try:
                rxj = json.load(open(f)); tier = (rxj.get("governor") or {}).get("tier")
                if r["state"] == "proposed" and tier == "BLOCK":
                    owner, action = "operator", "BLOCKED by governor — answer open_questions: " + "; ".join(rxj.get("open_questions") or ["see governor flags"])
            except ValueError:
                tier = "unreadable"
        rows.append({"rx": k, "state": r["state"], "tier": tier, "owner": owner, "next": action, "retries": r["retries"]})
    agent_work = [x for x in rows if x["owner"] == "agent"] and not stops
    out = {"paused": not agent_work, "stop": stops, "cycles": cycles, "prescriptions": rows}
    if a.json:
        print(json.dumps(out, indent=2))
    else:
        for c, i in cycles.items():
            print(f"cycle {c}: open={i['open']} calls {i['spent_calls']}/{i['budget_calls']} usd {i['spent_usd']:.2f}/{i['budget_usd']:.2f} failed_streak={i['failed_streak']}")
        for x in rows:
            print(f"  {x['rx']:<22} {x['state']:<13} tier={x['tier'] or '-':<5} [{x['owner']}] {x['next']}")
        print("STOP: " + "; ".join(stops) if stops else ("agent may proceed" if agent_work else "paused: waiting for the operator"))
    return 0 if agent_work else 4


if __name__ == "__main__":
    sys.exit(main())
