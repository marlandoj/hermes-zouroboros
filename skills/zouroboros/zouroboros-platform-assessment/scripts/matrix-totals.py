#!/usr/bin/env python3
"""Recompute TEST-MATRIX.md totals from its rows; never hand-count.

Rows are table lines whose first cell is an ID like `C-31` or a range like `C-07..13`.
The first status keyword in a row wins: NOT TESTED, NOT APPLICABLE, BLOCKED, FAIL, PASS.
A row without a status is reported as an error (exit 1) so it gets fixed, not guessed.
Rewrites the `## Totals` section in place.

Usage: matrix-totals.py <TEST-MATRIX.md>
"""
import re, sys
from collections import Counter

STATUSES = ("NOT TESTED", "NOT APPLICABLE", "BLOCKED", "FAIL", "PASS")
COLS = ["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT APPLICABLE"]

def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    text = open(path).read()
    rows = [l for l in text.splitlines() if re.match(r"\| [A-Z]{1,2}-\d", l)]
    by_row, atomic, missing = Counter(), Counter(), []
    for line in rows:
        status = next((s for s in STATUSES if re.search(r"\|\s*" + s, line)), None)
        if status is None:
            missing.append(line.split("|")[1].strip()); continue
        by_row[status] += 1
        m = re.match(r"\| [A-Z]{1,2}-(\d+)\.\.(\d+)", line)
        atomic[status] += (int(m.group(2)) - int(m.group(1)) + 1) if m else 1
    if missing:
        print("rows without a status:", ", ".join(missing)); sys.exit(1)
    fmt = lambda c: " | ".join(str(c.get(k, 0)) for k in COLS) + f" | {sum(c.values())} |"
    totals = ("## Totals (computed by scripts/matrix-totals.py)\n"
              "| | PASS | FAIL | BLOCKED | NOT TESTED | N/A | Total |\n|---|---|---|---|---|---|---|\n"
              f"| Matrix rows (a grouped row counts once) | {fmt(by_row)}\n"
              f"| Atomic checks (ranges expanded) | {fmt(atomic)}\n")
    text = re.sub(r"## Totals.*\Z", totals, text, flags=re.S) if "## Totals" in text else text.rstrip() + "\n\n" + totals
    open(path, "w").write(text)
    print(totals)

if __name__ == "__main__":
    main()
