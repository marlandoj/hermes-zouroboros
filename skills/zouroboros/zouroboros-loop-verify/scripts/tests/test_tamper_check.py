"""Tests for scripts/tamper-check.py using throwaway git repositories (stdlib only)."""
import json, os, subprocess, sys, tempfile, unittest

TC = os.path.join(os.path.dirname(__file__), "..", "tamper-check.py")


def git(d, *a):
    return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True, check=True).stdout.strip()


class TamperTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="zo-task-tamper-", dir="/tmp")
        git(self.d, "init", "-q"); git(self.d, "config", "user.email", "t@t"); git(self.d, "config", "user.name", "t")
        self.w("tests/a.test.ts", "test('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n")
        self.w("src/x.ts", "export const x = 1;\n")
        self.w("package.json", '{\n  "scripts": {\n    "test": "bun test tests"\n  }\n}\n')
        self.w(".github/workflows/ci.yml", "on: push\n")
        git(self.d, "add", "-A"); git(self.d, "commit", "-qm", "base"); self.base = git(self.d, "rev-parse", "HEAD")

    def w(self, p, s):
        os.makedirs(os.path.dirname(os.path.join(self.d, p)), exist_ok=True)
        with open(os.path.join(self.d, p), "w") as f:
            f.write(s)

    def check(self):
        git(self.d, "add", "-A"); git(self.d, "commit", "-qm", "head", "--allow-empty"); head = git(self.d, "rev-parse", "HEAD")
        p = subprocess.run([sys.executable, TC, "--worktree", self.d, "--base", self.base, "--head", head], capture_output=True, text=True)
        return p.returncode, json.loads(p.stdout)

    def test_clean_fix_not_flagged(self):
        self.w("src/x.ts", "export const x = 2;\n"); self.w("tests/b.test.ts", "test('b', () => { expect(2).toBe(2); });\n")
        code, r = self.check(); self.assertEqual(code, 0, r)

    def test_assertion_removed(self):
        self.w("tests/a.test.ts", "test('a', () => {\n  expect(1).toBe(1);\n});\n")
        code, r = self.check(); self.assertEqual(code, 1); self.assertTrue(any("assertion removal" in f for f in r["flags"]))

    def test_skip_added(self):
        self.w("tests/a.test.ts", "test.skip('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n")
        code, r = self.check(); self.assertEqual(code, 1); self.assertTrue(any("skip/only" in f for f in r["flags"]))

    def test_test_deleted(self):
        os.remove(os.path.join(self.d, "tests/a.test.ts"))
        code, r = self.check(); self.assertEqual(code, 1); self.assertTrue(any("test deleted" in f for f in r["flags"]))

    def test_ci_touched(self):
        self.w(".github/workflows/ci.yml", "on: [push]\n")
        code, r = self.check(); self.assertEqual(code, 1); self.assertTrue(any("protected path" in f for f in r["flags"]))

    def test_test_script_changed(self):
        self.w("package.json", '{\n  "scripts": {\n    "test": "true"\n  }\n}\n')
        code, r = self.check(); self.assertEqual(code, 1); self.assertTrue(any("test/typecheck script" in f for f in r["flags"]))

    def test_timeout_raise_is_warning_only(self):
        self.w("tests/a.test.ts", "test('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n}, timeout: 9000);\n")
        git(self.d, "add", "-A"); git(self.d, "commit", "-qm", "t1"); self.base = git(self.d, "rev-parse", "HEAD")
        self.w("tests/a.test.ts", "test('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n}, timeout: 90000);\n")
        code, r = self.check(); self.assertEqual(code, 0); self.assertTrue(r["warnings"])


if __name__ == "__main__":
    unittest.main()
