#!/usr/bin/env python3
"""Check that an evolve branch changes only what the approved prescription allows.

Usage: scope-check.py --worktree DIR --rx RX.json [--out RESULT.json]

Compares base.sha..HEAD plus any uncommitted changes against change_plan.files (exact paths or
globs) and change_plan.max_files. Violations (exit 1):
  - a changed file outside the allowed list
  - more changed files than max_files + len(tests_to_add)   (tests_to_add are always allowed)
  - a deleted or renamed test file, or a protected path touched (CI, governance, held-out, lockfile
    without a planned dependency change)
  - uncommitted changes (the branch must be clean at its head)
  - HEAD equal to base (nothing changed)
"""
import argparse, fnmatch, json, subprocess, sys

PROTECTED = [".github/*", "CONSTITUTION.md", "ZOUROBOROS.md", "*heldout*", "*zouroboros-loop*", "pnpm-lock.yaml"]


def git(wt, *args):
    return subprocess.run(["git", "-C", wt, *args], capture_output=True, text=True, check=True).stdout


def allowed(path, globs):
    return any(path == g or fnmatch.fnmatch(path, g) for g in globs)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worktree", required=True); ap.add_argument("--rx", required=True); ap.add_argument("--out")
    a = ap.parse_args()
    rx = json.load(open(a.rx)); plan = rx.get("change_plan") or {}
    base = rx["base"]["sha"]; head = git(a.worktree, "rev-parse", "HEAD").strip()
    globs = list(plan.get("files", [])) + list(plan.get("tests_to_add", []))
    limit = int(plan.get("max_files", len(plan.get("files", [])))) + len(plan.get("tests_to_add", []))
    status = [l for l in git(a.worktree, "status", "--porcelain", "--untracked-files=normal").splitlines() if l.strip()]
    changes = []
    for line in git(a.worktree, "diff", "--name-status", "-M", f"{base}..HEAD").splitlines():
        parts = line.split("\t"); changes.append((parts[0], parts[-1], parts[1] if len(parts) > 2 else None))
    files = sorted({c[1] for c in changes})
    v = []
    if head == base:
        v.append("HEAD equals base — nothing evolved")
    if status:
        v.append(f"uncommitted changes: {status[:5]}")
    out_of_scope = [f for f in files if not allowed(f, globs)]
    if out_of_scope:
        v.append(f"files outside change_plan: {out_of_scope}")
    if len(files) > limit:
        v.append(f"{len(files)} files changed > allowed {limit}")
    for st, path, old in changes:
        tst = lambda p: p and (p.startswith("tests/") or ".test." in p or "/__tests__/" in p or p.startswith("test_") or "/test_" in p)
        if st.startswith("D") and tst(path):
            v.append(f"test deleted: {path}")
        if st.startswith("R") and tst(old):
            v.append(f"test renamed: {old} -> {path}")
        if allowed(path, PROTECTED) and not allowed(path, globs):
            v.append(f"protected path touched: {path}")
    report = {"rx": rx["id"], "base": base, "head": head, "files": files, "changes": changes,
              "allowed": globs, "limit": limit, "violations": v, "ok": not v}
    s = json.dumps(report, indent=2)
    if a.out:
        open(a.out, "w").write(s + "\n")
    print(s)
    return 0 if not v else 1


if __name__ == "__main__":
    sys.exit(main())
