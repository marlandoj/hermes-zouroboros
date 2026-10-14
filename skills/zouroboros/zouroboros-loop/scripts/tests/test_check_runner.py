"""Tests for scripts/check-runner.py (stdlib only)."""
import json, os, pwd, subprocess, sys, tempfile, unittest

RUNNER = os.path.join(os.path.dirname(__file__), "..", "check-runner.py")
HOME = pwd.getpwuid(os.getuid()).pw_dir
CHECKOUT = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".."))


def run(repo, checks, *extra):
    d = tempfile.mkdtemp(prefix="zo-task-cr-", dir="/tmp")
    cf = os.path.join(d, "checks.json")
    with open(cf, "w") as f:
        json.dump(checks, f)
    out = os.path.join(d, "out.json")
    p = subprocess.run([sys.executable, RUNNER, "--repo", repo, "--checks", cf, "--out", out, *extra], capture_output=True, text=True)
    rep = json.load(open(out)) if os.path.exists(out) else None
    return p.returncode, rep, p.stderr


class CheckRunnerTests(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="zo-task-repo-", dir="/tmp")

    def test_refuses_deployed_checkout(self):
        for deployed in (os.path.join(HOME, "hermes-zouroboros"), CHECKOUT):
            code, _, err = run(deployed, [{"id": "x", "cmd": "true"}])
            self.assertEqual(code, 3, deployed); self.assertIn("deployed checkout", err)

    def test_refuses_repo_outside_allowed_roots(self):
        code, _, err = run(HOME, [{"id": "x", "cmd": "true"}])
        self.assertEqual(code, 3)

    def test_empty_selection_never_passes(self):
        code, _, err = run(self.repo, [{"id": "x", "kind": "heldout", "cmd": "true"}], "--kinds", "acceptance")
        self.assertEqual(code, 3); self.assertIn("never passes", err)

    def test_exit_expectations_and_expect_fail(self):
        checks = [{"id": "a", "cmd": "exit 0", "expect": {"exit": 0}}, {"id": "b", "cmd": "exit 4", "expect": {"exit": 0}}]
        code, rep, _ = run(self.repo, checks)
        self.assertEqual(code, 1); self.assertEqual([r["passed"] for r in rep["results"]], [True, False])
        code, rep, _ = run(self.repo, [dict(checks[1], red={"exit": 4})], "--expect", "fail")
        self.assertEqual(code, 0)   # red reproduction: fails with its declared signature

    def test_red_requires_declared_signature(self):
        # fails, but no red signature declared -> not an accepted reproduction (fail closed)
        code, rep, _ = run(self.repo, [{"id": "n", "cmd": "exit 1"}], "--expect", "fail")
        self.assertEqual(code, 1)
        # fails for the wrong reason (setup error 97) -> signature mismatch
        code, rep, _ = run(self.repo, [{"id": "w", "cmd": "exit 97", "red": {"exit": 1}}], "--expect", "fail")
        self.assertEqual(code, 1); self.assertFalse(rep["results"][0]["red_signature"])
        # fails for the right reason
        code, rep, _ = run(self.repo, [{"id": "r", "cmd": "exit 1", "red": {"exit": 1}}], "--expect", "fail")
        self.assertEqual(code, 0)

    def test_stdout_regex_and_json_select(self):
        checks = [
            {"id": "r", "cmd": "echo PASS=31 FAIL=0", "expect": {"stdout_regex": r"FAIL=0"}},
            {"id": "j", "cmd": "echo '[{\"id\":\"C-31\",\"status\":\"PASS\"}]' > {scratch}/o.json",
             "expect": {"json_file": "{scratch}/o.json", "select": {"id": "C-31"}, "field": "status", "equals": "PASS"}},
            {"id": "missing", "cmd": "true", "expect": {"json_file": "{scratch}/none.json", "select": {"id": "C-31"}, "field": "status", "equals": "PASS"}},
        ]
        code, rep, _ = run(self.repo, checks)
        self.assertEqual([r["passed"] for r in rep["results"]], [True, True, False])

    def test_timeout_is_failure(self):
        code, rep, _ = run(self.repo, [{"id": "t", "cmd": "sleep 5", "timeout_s": 1}])
        self.assertEqual(code, 1); self.assertEqual(rep["results"][0]["exit"], 124)

    def test_secrets_redacted_and_env_minimal(self):
        fake = "sk-proj-" + "A" * 30
        code, rep, _ = run(self.repo, [{"id": "s", "cmd": f"echo {fake}; echo HOME=$HOME; env | grep -c OPENAI_API_KEY || true"}])
        out = rep["results"][0]["stdout_tail"]
        self.assertNotIn(fake, out); self.assertIn("<redacted>", out)
        self.assertIn("zo-task-check-", out)          # scratch HOME, not the account home
        self.assertTrue(out.strip().endswith("0"))   # parent secrets not inherited


if __name__ == "__main__":
    unittest.main()
