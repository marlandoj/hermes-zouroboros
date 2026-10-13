#!/usr/bin/env python3
"""Run executable checks (acceptance, held-out, regression) against a repo copy and report JSON.

One runner for every phase, so prescribe (red on base), evolve (green on branch) and verify
(base vs head, held-out) measure the same way.

Usage:
  check-runner.py --repo DIR --checks CHECKS.json [--kinds acceptance,heldout,regression]
                  [--expect fail|pass] [--out RESULT.json] [--keep-dir /tmp/DIR]

CHECKS.json is a list of objects:
  {"id": "AC-1", "kind": "acceptance"|"heldout"|"regression", "description": "...",
   "cmd": "shell command", "timeout_s": 300, "env": {"K": "V"},
   "expect": {"exit": 0}                                  # exact exit code
           | {"exit_nonzero": true}
           | {"stdout_regex": "PASS=\\d+ FAIL=0"}
           | {"json_file": "{scratch}/out.json", "select": {"id": "C-31"}, "field": "status", "equals": "PASS"},
   "red": {...same grammar...}   # REQUIRED for --expect fail: the defect's own signature, e.g. {"exit": 1}
                                 # vs a harness failure (use exit 97 for setup errors in your cmd)}

Placeholders in cmd/env/json_file: {repo} repo under test, {scratch} fresh per-check scratch dir, {gh_config} gh auth dir,
{skills} the Hermes skills root, {bun} the bun binary.

Safety (Art. IX): refuses a repo that is the deployed checkout or not under /tmp or the loop's
repos/worktrees directories; runs each check with a minimal environment and its own scratch HOME;
redacts credential-shaped strings from captured output. Exit 0 when every selected check meets
--expect (default pass), 1 otherwise, 3 when refused.
"""
import argparse, json, os, pwd, re, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from loop_paths import LOOP_HOME, REAL_HOME, SKILLS_ROOT as SKILLS, is_protected  # noqa: E402
SECRET = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{30,}|Bearer\s+[A-Za-z0-9._-]{16,})")


def bun():
    for c in (shutil.which("bun"), os.path.join(REAL_HOME, ".bun/bin/bun")):
        if c and os.path.exists(c):
            return c
    return "bun"


def allowed_repo(repo):
    r = os.path.realpath(repo)
    if is_protected(r):
        return False, "refusing to run checks in the deployed checkout (copy it to scratch first)"
    ok = r.startswith("/tmp/") or r.startswith(os.path.join(LOOP_HOME, "repos") + os.sep) or r.startswith(os.path.join(LOOP_HOME, "worktrees") + os.sep)
    return ok, "" if ok else f"repo must be under /tmp or {LOOP_HOME}/{{repos,worktrees}}"


def fill(s, ctx):
    for k, v in ctx.items():
        s = s.replace("{" + k + "}", v)
    return s


def dig(obj, select, field):
    items = obj if isinstance(obj, list) else obj.get("results", [])
    for it in items:
        if all(str(it.get(k)) == str(v) for k, v in select.items()):
            return it.get(field)
    return None


def evaluate(exp, code, out, ctx):
    if "exit" in exp:
        return code == exp["exit"], code
    if exp.get("exit_nonzero"):
        return code != 0, code
    if "stdout_regex" in exp:
        m = re.search(exp["stdout_regex"], out)
        return bool(m), (m.group(0) if m else None)
    if "json_file" in exp:
        try:
            with open(fill(exp["json_file"], ctx)) as f:
                observed = dig(json.load(f), exp.get("select", {}), exp["field"])
            return observed == exp["equals"], observed
        except Exception as ex:  # missing/unparseable output is a failure, never a pass
            return False, f"unreadable: {type(ex).__name__}"
    return False, "no recognised expectation"


def run_check(c, repo, keep_dir=None):
    if keep_dir:   # persistent per-check scratch (verify keeps harness outputs for base/head comparison)
        scratch = os.path.join(keep_dir, re.sub(r"[^A-Za-z0-9_.-]", "_", c["id"])); os.makedirs(scratch, exist_ok=False)
    else:
        scratch = tempfile.mkdtemp(prefix="zo-task-check-", dir="/tmp")  # harnesses require /tmp
    ctx = {"repo": os.path.realpath(repo), "scratch": scratch, "skills": SKILLS, "bun": bun(),
           "gh_config": os.environ.get("GH_CONFIG_DIR") or os.path.join(REAL_HOME, ".config/gh")}
    nodebin = next((os.path.join(REAL_HOME, ".hermes/tools", d, "bin") for d in sorted(os.listdir(os.path.join(REAL_HOME, ".hermes/tools")))
                    if d.startswith("node-")), "") if os.path.isdir(os.path.join(REAL_HOME, ".hermes/tools")) else ""
    env = {"PATH": ":".join(p for p in (os.path.dirname(ctx["bun"]), nodebin, os.path.join(REAL_HOME, ".local/bin"), "/usr/bin", "/bin") if p),
           "HOME": os.path.join(scratch, "home"), "LANG": "C.UTF-8", "CI": "1", "TMPDIR": scratch}
    os.makedirs(env["HOME"], exist_ok=True)
    env.update({k: fill(str(v), ctx) for k, v in c.get("env", {}).items()})
    t0 = time.time()
    try:
        p = subprocess.run(["bash", "-c", fill(c["cmd"], ctx)], cwd=ctx["repo"], env=env, capture_output=True,
                           text=True, timeout=int(c.get("timeout_s", 300)), start_new_session=True)
        code, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as te:
        code, out, err = 124, (te.stdout or b"").decode() if isinstance(te.stdout, bytes) else (te.stdout or ""), "TIMEOUT"
    ms = int((time.time() - t0) * 1000)
    passed, observed = evaluate(c.get("expect", {"exit": 0}), code, out, ctx)
    red = None
    if "red" in c:   # the specific signature of the defect (distinguishes "defect present" from "harness broke")
        red, red_observed = evaluate(c["red"], code, out, ctx)
    if not keep_dir:
        shutil.rmtree(scratch, ignore_errors=True)
    redact = lambda s: SECRET.sub("<redacted>", s or "")[-1500:]
    return {"id": c["id"], "kind": c.get("kind", "acceptance"), "description": c.get("description", ""),
            "passed": passed, "exit": code, "observed": observed, "red_signature": red, "duration_ms": ms,
            "stdout_tail": redact(out), "stderr_tail": redact(err)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True); ap.add_argument("--checks", required=True)
    ap.add_argument("--kinds", default="acceptance,heldout,regression"); ap.add_argument("--expect", choices=["pass", "fail"], default="pass")
    ap.add_argument("--out"); ap.add_argument("--keep-dir", help="keep per-check scratch under this /tmp directory")
    a = ap.parse_args()
    if a.keep_dir and not os.path.realpath(a.keep_dir).startswith("/tmp/"):
        print(json.dumps({"ok": False, "refused": "--keep-dir must be under /tmp"}), file=sys.stderr); return 3
    ok, why = allowed_repo(a.repo)
    if not ok:
        print(json.dumps({"ok": False, "refused": why}), file=sys.stderr); return 3
    with open(a.checks) as f:
        checks = json.load(f)
    kinds = set(a.kinds.split(","))
    sel = [c for c in checks if c.get("kind", "acceptance") in kinds]
    if not sel:
        print(json.dumps({"ok": False, "refused": "no checks selected — an empty check set never passes"}), file=sys.stderr); return 3
    results = [run_check(c, a.repo, a.keep_dir) for c in sel]
    if a.expect == "pass":
        meets = all(r["passed"] for r in results)
    else:  # red reproduction: must fail AND match its declared defect signature (fail closed if undeclared)
        meets = all((not r["passed"]) and r["red_signature"] is True for r in results)
    report = {"repo": os.path.realpath(a.repo), "checks_file": os.path.realpath(a.checks), "expect": a.expect,
              "selected": len(results), "passed": sum(r["passed"] for r in results),
              "failed": sum(not r["passed"] for r in results), "meets_expectation": meets, "results": results}
    s = json.dumps(report, indent=2)
    if a.out:
        with open(a.out, "w") as f:
            f.write(s + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "results"}))
    for r in results:
        print(f"{'PASS' if r['passed'] else 'FAIL'}\t{r['id']}\t{r['kind']}\texit={r['exit']}\tobserved={r['observed']}\tred_signature={r['red_signature']}\t{r['duration_ms']}ms", file=sys.stderr)
    return 0 if meets else 1


if __name__ == "__main__":
    sys.exit(main())
