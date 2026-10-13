"""Tests for scripts/governor.py (stdlib only)."""
import os, pwd, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from governor import evaluate


def rx(**kw):
    base = {"kind": "heal", "delivery": "pr", "title": "t", "spec": "s", "rationale": "r",
            "acceptance_checks": [{"id": "a"}], "reproduction": {"meets_expectation": True}, "heldout_ref": ["concurrency"],
            "change_plan": {"summary": "fix", "files": ["docs/x.md"], "approach": []}}
    base.update(kw); return base


class GovernorTests(unittest.TestCase):
    def tier(self, r): return evaluate(r)["tier"]

    def test_low(self): self.assertEqual(self.tier(rx()), "L")
    def test_more_than_three_files_is_medium(self):
        self.assertEqual(self.tier(rx(change_plan={"summary": "x", "files": ["a", "b", "c", "d"]})), "M")
    def test_public_cli_is_medium(self):
        self.assertEqual(self.tier(rx(change_plan={"summary": "help text", "files": ["integration/mcp.ts"]})), "M")
    def test_database_is_high(self):
        self.assertEqual(self.tier(rx(change_plan={"summary": "x", "files": ["packages/memory/src/database.ts"]})), "H")
    def test_concurrency_words_high(self):
        self.assertEqual(self.tier(rx(change_plan={"summary": "set busy_timeout", "files": ["docs/x.md"]})), "H")
    def test_operator_delivery_high(self):
        self.assertEqual(self.tier(rx(delivery="operator", change_plan={})), "H")
    def test_governance_paths_are_G(self):
        for f in [".github/workflows/ci.yml", "CONSTITUTION.md", "skills/zouroboros-loop/scripts/ledger.py", "packages/swarm/src/routing/swarm-decision-gate.ts"]:
            self.assertEqual(self.tier(rx(change_plan={"summary": "x", "files": [f]})), "G", f)
    def test_blocks(self):
        self.assertEqual(self.tier(rx(acceptance_checks=[])), "BLOCK")
        self.assertEqual(self.tier(rx(reproduction={})), "BLOCK")
        self.assertEqual(self.tier(rx(kind="evolve")), "BLOCK")                       # no baseline
        self.assertEqual(self.tier(rx(kind="evolve", baseline={"metric": "m", "value": 1, "n": 5})), "L")
        self.assertEqual(self.tier(rx(spec="fine-tune the model on failures")), "BLOCK")
        self.assertEqual(self.tier(rx(open_questions=["which port?"])), "BLOCK")
        self.assertEqual(self.tier(rx(change_plan={"summary": "x", "files": [os.path.join(pwd.getpwuid(os.getuid()).pw_dir, "hermes-zouroboros", "integration/cli.ts")]})), "BLOCK")
        self.assertEqual(self.tier(rx(change_plan={"summary": "x", "files": ["~/.hermes/config.yaml"]})), "BLOCK")
    def test_operator_heal_needs_no_repo_reproduction(self):
        self.assertNotEqual(self.tier(rx(delivery="operator", reproduction={}, change_plan={})), "BLOCK")
    def test_deterministic(self):
        r = rx(change_plan={"summary": "SIGTERM forwarding", "files": ["integration/cli.ts"]})
        self.assertEqual(evaluate(r), evaluate(r))


if __name__ == "__main__":
    unittest.main()
