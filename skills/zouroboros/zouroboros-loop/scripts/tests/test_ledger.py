"""Unit tests for scripts/ledger.py (stdlib only). Run: python3 -m unittest discover -s tests -v"""
import io, json, os, subprocess, sys, tempfile, unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import importlib.util
spec = importlib.util.spec_from_file_location("ledger", os.path.join(os.path.dirname(__file__), "..", "ledger.py"))
ledger = importlib.util.module_from_spec(spec); spec.loader.exec_module(ledger)


def run(*args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ledger.main(list(args))
    return code, out.getvalue(), err.getvalue()


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="zo-task-ledger-")
        self.home = os.path.join(self.d, "loop")
        self.rx = os.path.join(self.d, "rx.json")
        with open(self.rx, "w") as f:
            json.dump({"id": "RX-C1-01", "kind": "heal", "title": "t", "governor": {"tier": "L"}}, f)

    def ev(self, event, actor, **kw):
        args = ["event", "--home", self.home, "--cycle", "C1", "--rx", "RX-C1-01", "--event", event, "--actor", actor]
        if kw.get("rx_file", True):
            args += ["--rx-file", self.rx]
        if "data" in kw:
            args += ["--data", json.dumps(kw["data"])]
        if "evidence" in kw:
            args += ["--evidence", *kw["evidence"]]
        return run(*args)

    def open_cycle(self, mode="live", actor="operator"):
        self.assertEqual(run("init", "--home", self.home, "--mode", mode)[0], 0)
        self.assertEqual(run("cycle-open", "--home", self.home, "--cycle", "C1", "--budget-calls", "5", "--budget-usd", "1", "--actor", actor)[0], 0)

    def approve(self, scope=("evolve-local",), actor="operator"):
        return self.ev("approve", actor, data={"scope": list(scope), "operator_words": "yes, evolve RX-C1-01 locally"})

    def to_evolved(self):
        self.assertEqual(self.ev("propose", "prescribe")[0], 0)
        self.assertEqual(self.approve(("evolve-local", "push-branch", "open-draft-pr"))[0], 0)
        self.assertEqual(self.ev("start", "evolve")[0], 0)
        self.assertEqual(self.ev("branch-ready", "evolve", data={"base_sha": "a" * 40, "head_sha": "b" * 40, "branch": "zo-loop/C1/01-x"})[0], 0)

    def report(self):
        p = os.path.join(self.d, "verify.json")
        with open(p, "w") as f:
            json.dump({"verdict": "certified"}, f)
        return p

    def test_happy_path_to_pr_open(self):
        self.open_cycle(); self.to_evolved()
        self.assertEqual(self.ev("verify-start", "verify")[0], 0)
        self.assertEqual(self.ev("certified", "verify", data={"head_sha": "b" * 40}, evidence=[self.report()])[0], 0)
        self.assertEqual(self.ev("pr-opened", "evolve", data={"pr_url": "https://github.com/o/r/pull/1"})[0], 0)
        code, out, _ = run("state", "--home", self.home, "--json")
        self.assertEqual(json.loads(out)["rx"]["RX-C1-01"]["state"], "pr-open")
        self.assertEqual(run("verify", "--home", self.home)[0], 0)

    def test_wrong_actor_refused(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        self.assertEqual(self.approve(actor="evolve")[0], 3)          # only operator approves
        self.assertEqual(self.ev("start", "evolve")[0], 3)             # not approved yet

    def test_test_fixture_refused_in_live_ledger(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        code, _, err = self.approve(actor="test-fixture")
        self.assertEqual(code, 3); self.assertIn("smoke", err)

    def test_test_fixture_allowed_in_smoke_ledger(self):
        self.open_cycle(mode="smoke", actor="test-fixture"); self.ev("propose", "prescribe")
        self.assertEqual(self.approve(actor="test-fixture")[0], 0)

    def test_block_tier_cannot_be_approved(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        with open(self.rx, "w") as f:
            json.dump({"id": "RX-C1-01", "governor": {"tier": "BLOCK"}}, f)
        code, _, err = self.approve(); self.assertEqual(code, 3); self.assertIn("BLOCK", err)

    def test_approval_requires_scope_and_words(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        self.assertEqual(self.ev("approve", "operator", data={"scope": ["evolve-local"]})[0], 3)
        self.assertEqual(self.ev("approve", "operator", data={"scope": ["deploy"], "operator_words": "x"})[0], 3)

    def test_edit_after_approval_invalidates(self):
        self.open_cycle(); self.ev("propose", "prescribe"); self.approve()
        with open(self.rx, "w") as f:
            json.dump({"id": "RX-C1-01", "kind": "heal", "title": "changed", "governor": {"tier": "L"}}, f)
        code, _, err = self.ev("start", "evolve")
        self.assertEqual(code, 3); self.assertIn("changed since approval", err)

    def test_pr_requires_push_and_pr_scope(self):
        self.open_cycle(); self.ev("propose", "prescribe"); self.approve(("evolve-local",))
        self.ev("start", "evolve"); self.ev("branch-ready", "evolve", data={"base_sha": "a" * 40, "head_sha": "b" * 40, "branch": "x"})
        self.ev("verify-start", "verify"); self.ev("certified", "verify", data={"head_sha": "b" * 40}, evidence=[self.report()])
        self.assertEqual(self.ev("pr-opened", "evolve", data={"pr_url": "https://github.com/o/r/pull/1"})[0], 3)

    def test_verdict_bound_to_evolved_head(self):
        self.open_cycle(); self.to_evolved(); self.ev("verify-start", "verify")
        self.assertEqual(self.ev("certified", "verify", data={"head_sha": "c" * 40}, evidence=[self.report()])[0], 3)
        self.assertEqual(self.ev("certified", "verify", data={"head_sha": "b" * 40})[0], 3)   # no evidence

    def test_merged_must_come_from_github(self):
        self.open_cycle(); self.to_evolved(); self.ev("verify-start", "verify")
        self.ev("certified", "verify", data={"head_sha": "b" * 40}, evidence=[self.report()])
        self.ev("pr-opened", "evolve", data={"pr_url": "https://github.com/o/r/pull/1"})
        self.assertEqual(self.ev("merged", "operator", data={"merged_sha": "d" * 40})[0], 3)
        self.assertEqual(self.ev("merged", "github", data={"merged_sha": "d" * 40, "source": "github-api"})[0], 0)

    def test_retry_limit(self):
        self.open_cycle(); self.to_evolved()
        for i in range(3):
            self.ev("verify-start", "verify")
            self.assertEqual(self.ev("failed", "verify", data={"head_sha": "b" * 40}, evidence=[self.report()])[0], 0)
            code = self.approve(("evolve-local",))[0]
            if i < 2:
                self.assertEqual(code, 0)
                self.ev("start", "evolve"); self.ev("branch-ready", "evolve", data={"base_sha": "a" * 40, "head_sha": "b" * 40, "branch": "x"})
            else:
                self.assertEqual(code, 3)   # third retry refused

    def test_tamper_detected(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        p = os.path.join(self.home, "ledger.jsonl")
        with open(p) as f:
            lines = f.read().splitlines()
        e = json.loads(lines[-1]); e["actor"] = "operator"; lines[-1] = json.dumps(e, sort_keys=True)
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        self.assertEqual(run("verify", "--home", self.home)[0], 3)
        self.assertEqual(self.approve()[0], 3)   # every write re-verifies the chain

    def test_closed_cycle_refuses_events(self):
        self.open_cycle(); run("cycle-close", "--home", self.home, "--cycle", "C1", "--actor", "operator")
        self.assertEqual(self.ev("propose", "prescribe")[0], 3)

    def test_budget(self):
        self.open_cycle()
        self.assertEqual(run("budget", "--home", self.home, "--cycle", "C1", "--need-calls", "5")[0], 0)
        run("spend", "--home", self.home, "--cycle", "C1", "--calls", "4", "--actor", "verify", "--note", "probe")
        self.assertEqual(run("budget", "--home", self.home, "--cycle", "C1", "--need-calls", "2")[0], 3)
        self.assertEqual(run("spend", "--home", self.home, "--cycle", "C1", "--calls", "2", "--actor", "verify", "--note", "over")[0], 3)

    def test_zero_budget_cycle_by_loop_and_operator_raise(self):
        self.assertEqual(run("init", "--home", self.home)[0], 0)
        self.assertEqual(run("cycle-open", "--home", self.home, "--cycle", "C1", "--budget-calls", "3", "--budget-usd", "0", "--actor", "loop")[0], 3)
        self.assertEqual(run("cycle-open", "--home", self.home, "--cycle", "C1", "--budget-calls", "0", "--budget-usd", "0", "--actor", "loop")[0], 0)
        self.assertEqual(run("budget", "--home", self.home, "--cycle", "C1", "--need-calls", "1")[0], 3)
        self.assertEqual(run("budget-raise", "--home", self.home, "--cycle", "C1", "--calls", "2", "--usd", "0.5", "--actor", "loop", "--operator-words", "x")[0], 3)
        self.assertEqual(run("budget-raise", "--home", self.home, "--cycle", "C1", "--calls", "2", "--usd", "0.5", "--actor", "operator", "--operator-words", "ok, 2 calls")[0], 0)
        self.assertEqual(run("budget", "--home", self.home, "--cycle", "C1", "--need-calls", "2")[0], 0)

    def test_malformed_data_refused_without_append(self):
        self.open_cycle()
        before = run("verify", "--home", self.home)[1]
        code, _, err = run("event", "--home", self.home, "--cycle", "C1", "--rx", "RX-C1-01", "--event", "propose",
                           "--actor", "prescribe", "--rx-file", self.rx, "--data", "not-json")
        self.assertEqual(code, 3); self.assertIn("JSON object", err)
        self.assertEqual(run("verify", "--home", self.home)[1], before)   # nothing appended

    def test_revise_requires_note_and_keeps_proposed(self):
        self.open_cycle(); self.ev("propose", "prescribe")
        self.assertEqual(self.ev("revise", "prescribe")[0], 3)            # no --note
        code = run("event", "--home", self.home, "--cycle", "C1", "--rx", "RX-C1-01", "--event", "revise", "--actor", "prescribe",
                   "--rx-file", self.rx, "--note", "tightened files")[0]
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(run("state", "--home", self.home, "--json")[1])["rx"]["RX-C1-01"]["state"], "proposed")

    def test_verify_abort_recovers_and_operator_abandon(self):
        self.open_cycle(); self.to_evolved(); self.ev("verify-start", "verify")
        self.assertEqual(self.ev("verify-abort", "verify")[0], 3)                       # needs --note
        code = run("event", "--home", self.home, "--cycle", "C1", "--rx", "RX-C1-01", "--event", "verify-abort", "--actor", "verify",
                   "--rx-file", self.rx, "--note", "verify host rebooted")[0]
        self.assertEqual(code, 0)
        self.ev("verify-start", "verify"); self.ev("failed", "verify", data={"head_sha": "b" * 40}, evidence=[self.report()])
        self.assertEqual(self.ev("abandon", "evolve")[0], 3)                            # operator's decision
        self.assertEqual(self.ev("abandon", "operator")[0], 0)

    def test_init_refuses_overwrite(self):
        self.open_cycle()
        self.assertEqual(run("init", "--home", self.home)[0], 3)


class OperatorDeliveryTests(unittest.TestCase):
    """Operator-delivered prescriptions (runbooks): approve → applied → confirmed (assessment D-28)."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="zo-task-ledger-")
        self.home = os.path.join(self.d, "loop")
        self.prx = os.path.join(self.home, "cycles", "C1", "prescriptions")
        os.makedirs(self.prx)
        self.evidence = os.path.join(self.d, "acceptance.json")
        with open(self.evidence, "w") as f:
            json.dump({"meets_expectation": True}, f)
        self.assertEqual(run("init", "--home", self.home)[0], 0)
        self.assertEqual(run("cycle-open", "--home", self.home, "--cycle", "C1", "--budget-calls", "0", "--budget-usd", "0", "--actor", "operator")[0], 0)

    def rx(self, n, delivery):
        p = os.path.join(self.prx, f"RX-C1-{n}.json")
        with open(p, "w") as f:
            json.dump({"id": f"RX-C1-{n}", "kind": "heal", "delivery": delivery, "title": "t", "governor": {"tier": "H"}}, f)
        self.assertEqual(self.ev(n, "propose", "prescribe")[0], 0)
        return p

    def ev(self, n, event, actor, data=None, evidence=None, rx_file=True):
        args = ["event", "--home", self.home, "--cycle", "C1", "--rx", f"RX-C1-{n}", "--event", event, "--actor", actor]
        if rx_file:
            args += ["--rx-file", os.path.join(self.prx, f"RX-C1-{n}.json")]
        if data is not None:
            args += ["--data", json.dumps(data)]
        if evidence:
            args += ["--evidence", *evidence]
        return run(*args)

    def approve(self, n, scope):
        return self.ev(n, "approve", "operator", data={"scope": scope, "operator_words": "Approved"})

    def status(self):
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "..", "loop-status.py"), "--home", self.home, "--json"],
                           capture_output=True, text=True)
        out = json.loads(p.stdout)
        return {r["rx"]: r for r in out["prescriptions"]}, out["stop"]

    def state(self, n):
        return json.loads(run("state", "--home", self.home, "--json")[1])["rx"][f"RX-C1-{n}"]["state"]

    def test_lifecycle_approve_applied_confirmed(self):
        self.rx("01", "operator")
        self.assertEqual(self.approve("01", ["operator-runbook"])[0], 0)
        rows, _ = self.status()
        self.assertEqual((rows["RX-C1-01"]["state"], rows["RX-C1-01"]["owner"]), ("approved", "operator"))
        self.assertEqual(self.ev("01", "start", "evolve")[0], 3)                        # evolve never runs a runbook
        self.assertEqual(self.ev("01", "applied", "operator", data={"operator_words": "done"})[0], 3)   # no evidence
        self.assertEqual(self.ev("01", "applied", "operator", evidence=[self.evidence])[0], 3)         # no operator words
        self.assertEqual(self.ev("01", "applied", "evolve", data={"operator_words": "done"}, evidence=[self.evidence])[0], 3)
        self.assertEqual(self.ev("01", "applied", "operator", data={"operator_words": "done"}, evidence=[self.evidence])[0], 0)
        rows, _ = self.status()
        self.assertEqual((rows["RX-C1-01"]["state"], rows["RX-C1-01"]["owner"]), ("applied", "agent"))
        self.assertEqual(self.ev("01", "confirmed", "introspect", data={})[0], 3)
        self.assertEqual(self.ev("01", "confirmed", "introspect", data={"assessment": "/a", "matrix_rows": ["G-06"]})[0], 0)
        self.assertEqual(self.state("01"), "confirmed")
        self.assertEqual(run("verify", "--home", self.home)[0], 0)

    def test_regressed_from_applied(self):
        self.rx("01", "operator"); self.approve("01", ["operator-runbook"])
        self.ev("01", "applied", "operator", data={"operator_words": "done"}, evidence=[self.evidence])
        self.assertEqual(self.ev("01", "regressed", "introspect", data={"assessment": "/a", "matrix_rows": ["G-06"]})[0], 0)

    def test_scope_must_match_delivery(self):
        self.rx("01", "operator"); self.rx("02", "pr")
        self.assertEqual(self.approve("01", ["evolve-local"])[0], 3)
        self.assertEqual(self.approve("01", ["operator-runbook", "evolve-local"])[0], 3)
        self.assertEqual(self.approve("02", ["operator-runbook"])[0], 3)
        self.assertEqual(self.approve("02", ["evolve-local", "operator-runbook"])[0], 3)
        self.assertEqual(self.approve("01", ["operator-runbook", "live-calls:2"])[0], 0)
        self.assertEqual(self.approve("02", ["evolve-local"])[0], 0)

    def test_applied_needs_unchanged_prescription_and_runbook_scope(self):
        p = self.rx("01", "operator"); self.approve("01", ["operator-runbook"])
        with open(p, "w") as f:
            json.dump({"id": "RX-C1-01", "kind": "heal", "delivery": "operator", "title": "changed", "governor": {"tier": "H"}}, f)
        code, _, err = self.ev("01", "applied", "operator", data={"operator_words": "done"}, evidence=[self.evidence])
        self.assertEqual(code, 3); self.assertIn("changed since approval", err)
        self.rx("02", "pr"); self.approve("02", ["evolve-local"])
        self.assertEqual(self.ev("02", "applied", "operator", data={"operator_words": "done"}, evidence=[self.evidence])[0], 3)

    def test_runbooks_do_not_count_toward_active_pr_limit(self):
        for n in ("01", "02", "03", "04"):
            self.rx(n, "operator"); self.assertEqual(self.approve(n, ["operator-runbook"])[0], 0)
        _, stops = self.status()
        self.assertEqual(stops, [])
        for n in ("05", "06", "07", "08"):
            self.rx(n, "pr"); self.approve(n, ["evolve-local"])
        _, stops = self.status()
        self.assertTrue(any("active" in s for s in stops))


if __name__ == "__main__":
    unittest.main()
