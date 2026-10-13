#!/usr/bin/env python3
"""Backup → disposable restore drill for SQLite stores (read-only on sources).

Uses the SQLite online backup API, restores into a scratch directory, and checks
integrity_check plus identical per-table row counts. Prints a JSON summary.
Consumer checks (MCP memory_search, factory intake) are run separately against
the restored copies — see references/procedure.md, phase F.

Usage: restore-drill.py <scratch-dir-under-/tmp> <db> [<db> ...]
Delete the scratch directory afterwards: it contains copies of live data.
"""
import json, os, shutil, sqlite3, sys, time

def counts(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
        return {t: c.execute(f'select count(*) from "{t}"').fetchone()[0] for t in tables}
    finally:
        c.close()

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    scratch, sources = sys.argv[1], sys.argv[2:]
    if not os.path.abspath(scratch).startswith("/tmp/"):
        sys.exit("scratch must be under /tmp")
    os.makedirs(f"{scratch}/backup", exist_ok=True)
    os.makedirs(f"{scratch}/restored", exist_ok=True)
    results, ok = [], True
    for i, src in enumerate(sources):
        name = f"{i}-{os.path.basename(src)}"
        bak, dst = f"{scratch}/backup/{name}", f"{scratch}/restored/{name}"
        t0 = time.time()
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True); d = sqlite3.connect(bak)
        s.backup(d); d.close(); s.close()
        shutil.copy(bak, dst)
        c = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
        integrity = c.execute("pragma integrity_check").fetchone()[0]; c.close()
        a, b = counts(src), counts(dst)
        passed = integrity == "ok" and a == b
        ok &= passed
        results.append({"source": src, "restored": dst, "bytes": os.path.getsize(dst),
                        "seconds": round(time.time() - t0, 3), "integrity": integrity,
                        "rowcounts_equal": a == b, "tables": len(b), "rows": sum(b.values()),
                        "result": "PASS" if passed else "FAIL"})
    print(json.dumps(results, indent=2))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
