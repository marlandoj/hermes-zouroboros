#!/usr/bin/env python3
"""Detect test weakening and protected-path edits between base and head (Constitution Art. III).

Usage: tamper-check.py --worktree DIR --base SHA --head SHA [--out RESULT.json]

Flags (any flag → verify cannot certify):
  - test file deleted or renamed away
  - net removal of assertions in a test file (expect(, assert, toBe/toEqual, self.assert*)
  - skip/only/todo markers added (test.skip, it.skip, describe.skip, .only(, xit(, @unittest.skip, pytest.mark.skip, test.todo)
  - package.json "test"/"typecheck" script changed, or tsconfig/bunfig exclude changed
  - CI workflow, governance documents, held-out catalog/probes or loop skills touched
  - assertion tolerance loosened (timeouts/thresholds raised in tests: a heuristic, reported as a warning)
"""
import argparse, json, re, subprocess, sys

TEST = re.compile(r"(^|/)(tests?|__tests__)/|\.test\.[jt]sx?$|\.spec\.[jt]sx?$|(^|/)test_[^/]+\.py$")
ASSERT = re.compile(r"\bexpect\(|\bassert\b|\.toBe\(|\.toEqual\(|self\.assert\w*\(")
SKIP = re.compile(r"\b(test|it|describe)\.(skip|todo)\(|\.only\(|\bxit\(|@unittest\.skip|pytest\.mark\.skip|--passWithNoTests")
PROTECTED = re.compile(r"^\.github/|(^|/)(CONSTITUTION|ZOUROBOROS)\.md$|heldout|zouroboros-loop|governance")
CONFIG = re.compile(r"(^|/)(package\.json|tsconfig[^/]*\.json|bunfig\.toml|pytest\.ini|setup\.cfg)$")
NUMBER_UP = re.compile(r"(timeout\w*|threshold|tolerance)\s*[:=]\s*(\d+)", re.I)


def git(wt, *a):
    return subprocess.run(["git", "-C", wt, *a], capture_output=True, text=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--worktree", required=True); ap.add_argument("--base", required=True); ap.add_argument("--head", required=True); ap.add_argument("--out")
    a = ap.parse_args()
    flags, warnings = [], []
    for line in git(a.worktree, "diff", "--name-status", "-M", f"{a.base}..{a.head}").splitlines():
        parts = line.split("\t"); st, path = parts[0], parts[-1]; old = parts[1] if len(parts) > 2 else path
        if st.startswith("D") and TEST.search(path): flags.append(f"test deleted: {path}")
        if st.startswith("R") and TEST.search(old) and not TEST.search(path): flags.append(f"test renamed away: {old} -> {path}")
        if PROTECTED.search(path): flags.append(f"protected path changed: {path}")
        if CONFIG.search(path):
            d = git(a.worktree, "diff", f"{a.base}..{a.head}", "--", path)
            if re.search(r'^[-+]\s*"(test|typecheck)"\s*:', d, re.M): flags.append(f"test/typecheck script changed in {path}")
            if re.search(r'^[-+].*"exclude"', d, re.M): flags.append(f"exclude list changed in {path}")
    for path in git(a.worktree, "diff", "--name-only", f"{a.base}..{a.head}").splitlines():
        if not TEST.search(path):
            continue
        d = git(a.worktree, "diff", "-U0", f"{a.base}..{a.head}", "--", path).splitlines()
        added = [l[1:] for l in d if l.startswith("+") and not l.startswith("+++")]
        removed = [l[1:] for l in d if l.startswith("-") and not l.startswith("---")]
        ra, aa = sum(bool(ASSERT.search(l)) for l in removed), sum(bool(ASSERT.search(l)) for l in added)
        if ra > aa: flags.append(f"net assertion removal in {path}: -{ra} +{aa}")
        for l in added:
            if SKIP.search(l): flags.append(f"skip/only marker added in {path}: {l.strip()[:80]}")
        before = {m.group(1).lower(): int(m.group(2)) for l in removed for m in NUMBER_UP.finditer(l)}
        for l in added:
            for m in NUMBER_UP.finditer(l):
                k, v = m.group(1).lower(), int(m.group(2))
                if k in before and v > before[k]: warnings.append(f"{k} raised {before[k]} -> {v} in {path}")
    report = {"base": a.base, "head": a.head, "flags": flags, "warnings": warnings, "ok": not flags}
    s = json.dumps(report, indent=2)
    if a.out:
        open(a.out, "w").write(s + "\n")
    print(s)
    return 0 if not flags else 1


if __name__ == "__main__":
    sys.exit(main())
