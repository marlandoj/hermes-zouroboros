#!/usr/bin/env python3
"""Write the evolve → verify handoff record (cycles/<C>/evolve/<rx>.json). Fail closed.

Usage: evolve-record.py --rx RX.json --worktree DIR --branch BRANCH --acceptance ACCEPT.json
                        --suite SUITE.json --base-suite BASE_SUITE.json --scope SCOPE.json --out cycles/<C>/evolve/<rx>.json

Refuses unless: the worktree is clean at HEAD; acceptance (check-runner, expect=pass) passed on
this HEAD; the local suite ran on this HEAD and the base suite ran on base.sha, with no step or test
that passes on base failing on HEAD (pre-existing failures are recorded, not hidden); the scope
check passed on this HEAD. Records
commits, diffstat and digests of every input so verify can bind its verdict to exactly this head.
"""
import argparse, hashlib, json, os, subprocess, sys


def git(wt, *a):
    return subprocess.run(["git", "-C", wt, *a], capture_output=True, text=True, check=True).stdout.strip()


def digest(p):
    raw = open(p, "rb").read()
    try:
        return hashlib.sha256(json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    except ValueError:
        return hashlib.sha256(raw).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for k in ("rx", "worktree", "branch", "acceptance", "suite", "base_suite", "scope", "out"):
        ap.add_argument("--" + k.replace("_", "-"), dest=k, required=True)
    a = ap.parse_args()
    rx, acc, suite, bsuite, scope = (json.load(open(p)) for p in (a.rx, a.acceptance, a.suite, a.base_suite, a.scope))
    head = git(a.worktree, "rev-parse", "HEAD"); base = rx["base"]["sha"]
    errs = []
    if git(a.worktree, "status", "--porcelain", "--untracked-files=normal"):
        errs.append("worktree not clean")
    if git(a.worktree, "rev-parse", "--abbrev-ref", "HEAD") != a.branch:
        errs.append(f"worktree is not on {a.branch}")
    if not (acc.get("expect") == "pass" and acc.get("meets_expectation") is True):
        errs.append("acceptance checks did not all pass")
    if {r["id"] for r in acc.get("results", [])} != {c["id"] for c in rx["acceptance_checks"]}:
        errs.append("acceptance result does not cover exactly the prescription's checks")
    if suite.get("sha") != head:
        errs.append(f"local suite did not run on HEAD (suite sha {suite.get('sha')})")
    if bsuite.get("sha") != base:
        errs.append(f"base suite did not run on base.sha (got {bsuite.get('sha')})")
    stp = lambda x: {st["step"]: st["exit"] for st in x.get("steps", [])}
    tst = lambda x: {(st["step"], t) for st in x.get("steps", []) for t in st.get("failing_tests", [])}
    step_reg = [k for k, v in stp(bsuite).items() if v == 0 and stp(suite).get(k, 1) != 0]
    test_reg = sorted(f"{a_}: {b_}" for a_, b_ in tst(suite) - tst(bsuite))
    if step_reg or test_reg:
        errs.append(f"suite regressions vs base: steps {step_reg}, tests {test_reg}")
    preexisting = sorted(f"{a_}: {b_}" for a_, b_ in tst(suite) & tst(bsuite))
    if scope.get("head") != head or scope.get("ok") is not True:
        errs.append("scope check not passing on HEAD")
    if errs:
        print(json.dumps({"ok": False, "refused": errs}), file=sys.stderr); return 3
    rec = {"schema": "zo-loop/evolve@1", "rx": rx["id"], "rx_digest": digest(a.rx), "repo": rx["base"]["repo"],
           "branch": a.branch, "worktree": os.path.realpath(a.worktree), "base_sha": base, "head_sha": head,
           "commits": git(a.worktree, "log", "--format=%H %s", f"{base}..HEAD").splitlines(),
           "diffstat": git(a.worktree, "diff", "--shortstat", f"{base}..HEAD"), "files": scope["files"],
           "suite_preexisting_failures": preexisting,
           "inputs": {k: {"path": os.path.realpath(p), "digest": digest(p)} for k, p in
                      (("acceptance", a.acceptance), ("suite", a.suite), ("base_suite", a.base_suite), ("scope", a.scope))}}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(rec, f, indent=2); f.write("\n")
    print(json.dumps({"ok": True, "out": a.out, "head_sha": head, "base_sha": base}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
