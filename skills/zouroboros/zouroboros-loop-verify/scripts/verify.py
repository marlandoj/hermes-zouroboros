#!/usr/bin/env python3
"""Verify one evolved prescription: the loop's fitness function (Constitution Arts. II, III, IX).

Usage: verify.py --home LOOP_HOME --cycle C --rx RX.json --evolve EVOLVE.json [--no-ledger]
Writes cycles/<C>/verify/<rx>.json and VERIFY-<rx>.md, then records verify-start and the verdict in the
ledger (unless --no-ledger). Exit 0 certified · 1 failed · 2 inconclusive · 3 refused (integrity).

Pipeline (each step's raw output is kept under cycles/<C>/verify/<rx>/):
  0 integrity   prescription digest == approval digest == evolve record digest; ledger state `evolved`;
                worktree clean at evolve.head_sha; held-out catalog untouched by the diff
  1 rebuild     independent detached exports of base_sha and head_sha in /tmp, each built from scratch
  2 suite       local-suite on base and head (build, typecheck, Bun, Python, portable)
  3 acceptance  base must still be red (with signature); head must pass
  4 held-out    catalog classes named in the prescription's heldout_ref (+ always-on): head must pass;
                base should be red (otherwise the check is reported non-discriminating)
  5 harness     full MCP assessment harness on base and head; any PASS→FAIL is a regression
  6 tamper      tamper-check.py on base..head
  7 verdict     rules in references/verdict-rules.md
"""
import argparse, datetime as dt, hashlib, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.realpath(__file__))
SKILL = os.path.dirname(HERE)
LOOP = os.path.join(os.path.dirname(SKILL), "zouroboros-loop", "scripts")
EVOLVE = os.path.join(os.path.dirname(SKILL), "zouroboros-loop-evolve", "scripts")
CATALOG = os.path.join(SKILL, "heldout", "catalog.json")


def digest(p):
    raw = open(p, "rb").read()
    try:
        return hashlib.sha256(json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    except ValueError:
        return hashlib.sha256(raw).hexdigest()


def sh(*cmd, cwd=None, check=False, timeout=None):
    p = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])}… exit {p.returncode}: {p.stderr[-400:]}")
    return p


def run_checks(repo, checks, expect, out, keep=None):
    cf = out + ".checks.json"
    json.dump(checks, open(cf, "w"), indent=2)
    args = [sys.executable, os.path.join(LOOP, "check-runner.py"), "--repo", repo, "--checks", cf,
            "--kinds", "acceptance,heldout,regression", "--expect", expect, "--out", out]
    if keep:
        args += ["--keep-dir", keep]
    sh(*args)
    try:
        return json.load(open(out))
    except Exception:
        return {"meets_expectation": False, "results": [], "error": "check-runner produced no report"}


def mcp_compare(base_json, head_json):
    def load(p):
        try:
            return {r["id"]: r["status"] for r in json.load(open(p))}
        except Exception:
            return None
    b, h = load(base_json), load(head_json)
    if b is None or h is None:
        return {"ok": False, "error": "harness output missing", "regressions": [], "improvements": []}
    reg = sorted(k for k in b if b[k] == "PASS" and h.get(k) != "PASS")
    imp = sorted(k for k in h if h[k] == "PASS" and b.get(k) == "FAIL")
    new_fail = sorted(k for k in h if h[k] == "FAIL" and k not in b)
    return {"ok": not reg and not new_fail, "regressions": reg, "new_failures": new_fail, "improvements": imp,
            "base_pass": sum(v == "PASS" for v in b.values()), "head_pass": sum(v == "PASS" for v in h.values()), "total": len(h)}


def load_known_failures(home, no_ledger, L):
    """Operator-approved pre-existing failures: <home>/known-failures.json.
    Entries need step, test, defect, reason and approved_by=operator with operator_words; approved_by=test-fixture
    is honoured only when the ledger is a smoke ledger (never in a live loop)."""
    p = os.path.join(home, "known-failures.json")
    if not os.path.exists(p):
        return set(), "none"
    mode = "live"
    if not no_ledger:
        mode = json.loads(sh(*L, "verify", "--home", home).stdout or "{}").get("mode", "live")
    ok, ignored = set(), []
    for e in json.load(open(p)).get("entries", []):
        valid = all(e.get(k) for k in ("step", "test", "defect", "reason", "operator_words")) and (
            e.get("approved_by") == "operator" or (e.get("approved_by") == "test-fixture" and mode == "smoke"))
        (ok.add((e["step"], e["test"])) if valid else ignored.append(e.get("test")))
    return ok, f"{len(ok)} honoured, {len(ignored)} ignored ({mode} ledger), file digest {digest(p)[:12]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for k in ("home", "cycle", "rx", "evolve"):
        ap.add_argument("--" + k, required=True)
    ap.add_argument("--no-ledger", action="store_true")
    a = ap.parse_args()
    try:
        rx, evo = json.load(open(a.rx)), json.load(open(a.evolve))
        evo["base_sha"], evo["head_sha"], evo["worktree"]
    except Exception as ex:   # unreadable or incomplete inputs: refuse, never guess (Art. IX)
        print(json.dumps({"ok": False, "refused": f"unreadable prescription or evolve record: {type(ex).__name__}: {ex}"}), file=sys.stderr); return 3
    cyc_dir = os.path.join(a.home, "cycles", a.cycle)
    L = [sys.executable, os.path.join(LOOP, "ledger.py")]
    # One evidence set per attempt (Art. VI): never overwrite an earlier attempt's report.
    prior = 0
    if os.path.exists(os.path.join(a.home, "ledger.jsonl")):
        prior = sum(1 for l in open(os.path.join(a.home, "ledger.jsonl")) if l.strip()
                    and (e := json.loads(l)).get("rx") == rx["id"] and e["event"] in ("certified", "failed", "inconclusive"))
    attempt = prior + 1
    suffix = "" if attempt == 1 else f".a{attempt}"
    vdir = os.path.join(cyc_dir, "verify", rx["id"] + suffix); os.makedirs(vdir, exist_ok=False)
    started = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    report = {"schema": "zo-loop/verify@1", "rx": rx["id"], "kind": rx["kind"], "tier": rx["governor"]["tier"],
              "base_sha": evo["base_sha"], "head_sha": evo["head_sha"], "started_utc": started, "steps": {}, "reasons": []}

    # 0 integrity (refuse = exit 3, no verdict)
    problems = []
    if evo.get("rx_digest") != digest(a.rx): problems.append("evolve record bound to a different prescription digest")
    if not a.no_ledger:
        st = json.loads(sh(*L, "state", "--home", a.home, "--rx", rx["id"], "--json").stdout or "{}").get("rx", {}).get(rx["id"], {})
        if st.get("state") != "evolved": problems.append(f"ledger state is {st.get('state')!r}, expected 'evolved'")
        if (st.get("approval") or {}).get("rx_digest") != digest(a.rx): problems.append("prescription changed since approval")
        if st.get("head_sha") != evo["head_sha"]: problems.append("ledger head_sha differs from evolve record")
    wt = evo["worktree"]
    if sh("git", "-C", wt, "rev-parse", "HEAD").stdout.strip() != evo["head_sha"]: problems.append("worktree HEAD moved since evolve")
    if sh("git", "-C", wt, "status", "--porcelain").stdout.strip(): problems.append("worktree dirty")
    if problems:
        print(json.dumps({"ok": False, "refused": problems}), file=sys.stderr); return 3
    if not a.no_ledger:
        r = sh(*L, "event", "--home", a.home, "--cycle", a.cycle, "--rx", rx["id"], "--event", "verify-start", "--actor", "verify", "--data", "{}")
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr); return 3

    tmp = subprocess.run(["mktemp", "-d", "/tmp/zo-task-verify-XXXXXX"], capture_output=True, text=True).stdout.strip()
    exports = {}
    try:
        # 1 rebuild independent exports
        for side in ("base", "head"):
            d = os.path.join(tmp, side); sh("bash", os.path.join(LOOP, "repo.sh"), "export", evo[f"{side}_sha"], d, check=True); exports[side] = d
        # 2 suite
        suite = {}
        for side, d in exports.items():
            out = os.path.join(vdir, f"suite-{side}.json")
            sh("bash", os.path.join(EVOLVE, "local-suite.sh"), d, out, timeout=3600)
            suite[side] = json.load(open(out)) if os.path.exists(out) else {"ok": False, "steps": []}
        steps = lambda s: {x["step"]: x["exit"] for x in s.get("steps", [])}
        tests = lambda s: {(x["step"], t) for x in s.get("steps", []) for t in x.get("failing_tests", [])}
        sb, shd = steps(suite["base"]), steps(suite["head"])
        tb, th = tests(suite["base"]), tests(suite["head"])
        step_reg = sorted(k for k in sb if sb[k] == 0 and shd.get(k, 1) != 0)
        test_reg = sorted(f"{st}: {t}" for st, t in th - tb)
        pre = sorted(th & tb)
        known, allow_note = load_known_failures(a.home, a.no_ledger, L)
        pre_unlisted = [f"{st}: {t}" for st, t in pre if (st, t) not in known]
        pre_listed = [f"{st}: {t}" for st, t in pre if (st, t) in known]
        # a step failing on both sides with no named failing tests cannot be compared at test level
        opaque = sorted(k for k in sb if sb[k] != 0 and shd.get(k, 1) != 0 and not any(st == k for st, _ in th))
        report["steps"]["suite"] = {"base_ok": suite["base"].get("ok"), "head_ok": suite["head"].get("ok"),
                                    "regressions": step_reg + test_reg, "preexisting_unlisted": pre_unlisted,
                                    "preexisting_allowlisted": pre_listed, "opaque_failing_steps": opaque,
                                    "known_failures": allow_note, "base": sb, "head": shd}
        # 3 acceptance
        acc_b = run_checks(exports["base"], rx["acceptance_checks"], "fail", os.path.join(vdir, "acceptance-base.json"))
        acc_h = run_checks(exports["head"], rx["acceptance_checks"], "pass", os.path.join(vdir, "acceptance-head.json"))
        report["steps"]["acceptance"] = {"base_red_confirmed": acc_b.get("meets_expectation"), "head_pass": acc_h.get("meets_expectation"),
                                         "head": [(r["id"], r["passed"], r["observed"]) for r in acc_h.get("results", [])]}
        # 4 held-out
        cat = json.load(open(CATALOG)); wanted = set(rx.get("heldout_ref") or [])
        unknown = sorted(wanted - set(cat["classes"]))
        if unknown:
            report["reasons"].append(f"unknown held-out classes ignored: {unknown}")
        chosen = [c for name, cls in cat["classes"].items() if cls.get("always") or name in wanted for c in cls["checks"]]
        plain = [c for c in chosen if "compare" not in c]
        ho = {"selected": [c["id"] for c in chosen], "head_pass": None, "non_discriminating": []}
        if plain:
            h_h = run_checks(exports["head"], plain, "pass", os.path.join(vdir, "heldout-head.json"))
            h_b = run_checks(exports["base"], plain, "fail", os.path.join(vdir, "heldout-base.json"))
            ho["head_pass"] = h_h.get("meets_expectation")
            ho["head"] = [(r["id"], r["passed"], r["observed"]) for r in h_h.get("results", [])]
            ho["non_discriminating"] = [r["id"] for r in h_b.get("results", []) if r["passed"] or r["red_signature"] is not True]
        report["steps"]["heldout"] = ho
        # 5 harness comparison
        cmp_checks = [c for c in chosen if c.get("compare") == "mcp-e2e"]
        if cmp_checks:
            c = cmp_checks[0]; keep = os.path.join(tmp, "keep")
            for side in ("base", "head"):
                os.makedirs(os.path.join(keep, side), exist_ok=True)
                run_checks(exports[side], [c], "pass", os.path.join(vdir, f"harness-{side}.json"), keep=os.path.join(keep, side))
                src = os.path.join(keep, side, c["id"], "e2e.json")
                if os.path.exists(src): shutil.copy(src, os.path.join(vdir, f"mcp-e2e-{side}.json"))
            report["steps"]["harness"] = mcp_compare(os.path.join(vdir, "mcp-e2e-base.json"), os.path.join(vdir, "mcp-e2e-head.json"))
        # 6 tamper
        tout = os.path.join(vdir, "tamper.json")
        sh(sys.executable, os.path.join(HERE, "tamper-check.py"), "--worktree", wt, "--base", evo["base_sha"], "--head", evo["head_sha"], "--out", tout)
        report["steps"]["tamper"] = json.load(open(tout))
    finally:
        for d in exports.values():
            sh("bash", os.path.join(LOOP, "repo.sh"), "export-remove", d)
        shutil.rmtree(tmp, ignore_errors=True)

    # 7 verdict (references/verdict-rules.md)
    s, R = report["steps"], report["reasons"]
    failed, inconclusive = [], []
    if not s["acceptance"]["head_pass"]: failed.append("acceptance checks fail on head")
    if s["heldout"]["head_pass"] is False: failed.append("held-out checks fail on head")
    if s["suite"]["regressions"]: failed.append(f"suite regressions: {s['suite']['regressions']}")
    if s.get("harness") and (s["harness"].get("regressions") or s["harness"].get("new_failures")): failed.append(f"harness regressions: {s['harness'].get('regressions')} {s['harness'].get('new_failures')}")
    if s.get("harness") and s["harness"].get("error"): inconclusive.append(f"harness comparison unavailable: {s['harness']['error']}")
    if not s["tamper"]["ok"]: failed.append(f"tamper flags: {s['tamper']['flags']}")
    if not s["acceptance"]["base_red_confirmed"]: inconclusive.append("base is no longer red with the defect signature — improvement cannot be attributed")
    if s["suite"]["preexisting_unlisted"]: inconclusive.append(f"pre-existing failures not in the operator-approved known-failures list: {s['suite']['preexisting_unlisted']}")
    if s["suite"]["opaque_failing_steps"]: inconclusive.append(f"steps failing on base and head without test-level detail: {s['suite']['opaque_failing_steps']}")
    if rx["governor"]["tier"] in ("H", "G") and (s["heldout"]["head_pass"] is None or len(s["heldout"]["non_discriminating"]) == len([x for x in s["heldout"]["selected"] if not x.startswith("HO-MCP")])):
        inconclusive.append("tier H/G requires at least one discriminating held-out check")
    if rx["kind"] == "evolve":
        inconclusive.append("evolve-kind metric certification needs a held-out metric baseline comparison (not configured for this prescription)")
    verdict = "failed" if failed else "inconclusive" if inconclusive else "certified"
    R += failed + inconclusive
    report.update(verdict=verdict, finished_utc=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                  summary={"certified": "Acceptance green on head and red on base; held-out green and discriminating; no suite or harness regressions; no tampering.",
                           "failed": "Change rejected: " + "; ".join(failed), "inconclusive": "Not certifiable yet: " + "; ".join(inconclusive)}[verdict],
                  promotion_note="Certified here means ready for HUMAN review/merge. Constitutional promotion additionally requires the governance attestation issuer (not installed on this host) and CI on the PR.")
    out = os.path.join(cyc_dir, "verify", f"{rx['id']}{suffix}.json")
    report["attempt"] = attempt
    json.dump(report, open(out, "w"), indent=2); open(out, "a").write("\n")
    report["report_digest"] = digest(out); json.dump(report, open(out, "w"), indent=2); open(out, "a").write("\n")
    md = [f"# Verify {rx['id']} — {verdict.upper()} (attempt {attempt})", "", f"- Base `{evo['base_sha'][:12]}` → head `{evo['head_sha'][:12]}`; tier {rx['governor']['tier']}; kind {rx['kind']}",
          f"- {report['summary']}", f"- Suite: base_ok={s['suite']['base_ok']} head_ok={s['suite']['head_ok']} regressions={s['suite']['regressions']}; pre-existing allowlisted={s['suite']['preexisting_allowlisted']}; pre-existing unlisted={s['suite']['preexisting_unlisted']}; known-failures: {s['suite']['known_failures']}",
          f"- Acceptance: base red confirmed={s['acceptance']['base_red_confirmed']}, head pass={s['acceptance']['head_pass']}",
          f"- Held-out: {s['heldout']['selected']} head_pass={s['heldout']['head_pass']} non-discriminating={s['heldout']['non_discriminating']}",
          f"- Harness: {s.get('harness')}", f"- Tamper: ok={s['tamper']['ok']} flags={s['tamper']['flags']} warnings={s['tamper']['warnings']}",
          f"- Note: {report['promotion_note']}", f"- Raw outputs: `{vdir}`"]
    open(os.path.join(cyc_dir, f"VERIFY-{rx['id']}{suffix}.md"), "w").write("\n".join(md) + "\n")
    if not a.no_ledger:
        r = sh(*L, "event", "--home", a.home, "--cycle", a.cycle, "--rx", rx["id"], "--event", verdict, "--actor", "verify",
               "--evidence", out, "--data", json.dumps({"head_sha": evo["head_sha"], "reasons": R}))
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr); return 3
    print(json.dumps({"verdict": verdict, "report": out, "reasons": R}))
    return {"certified": 0, "failed": 1, "inconclusive": 2}[verdict]


if __name__ == "__main__":
    sys.exit(main())
