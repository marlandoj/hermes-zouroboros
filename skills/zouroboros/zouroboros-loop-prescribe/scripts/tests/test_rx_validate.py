"""Fail-closed tests for rx-validate.py against a self-contained synthetic fixture (stdlib only)."""
import copy, hashlib, json, os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import importlib.util
spec = importlib.util.spec_from_file_location("rxv", os.path.join(HERE, "..", "rx-validate.py"))
rxv = importlib.util.module_from_spec(spec); spec.loader.exec_module(rxv)
from governor import evaluate

SHA = "a" * 40
DEFECTS = """# Defect register
| ID | Sev | Class | Workflow | Summary |
|---|---|---|---|---|
| D-07 | High | PRE | Memory write | Concurrent writers lose facts |
| D-08 | Low | PRE | Other | Unrelated |

### D-07 — Concurrent writers lose facts (High)
- Expected: all writes persist.
### D-08 — Unrelated (Low)
- Something else.
"""


def canon(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class RxValidateTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp(prefix="zo-task-rxv-", dir="/tmp")
        self.assess = os.path.join(d, "assessment"); os.makedirs(self.assess)
        with open(os.path.join(self.assess, "DEFECTS.md"), "w") as f:
            f.write(DEFECTS)
        check = {"id": "D-07/AC-1", "kind": "acceptance", "cmd": "exit 1", "expect": {"exit": 0}, "red": {"exit": 1}}
        red = {"expect": "fail", "meets_expectation": True, "results": [{"id": "D-07/AC-1", "passed": False, "red_signature": True}]}
        self.red = os.path.join(d, "red.json")
        with open(self.red, "w") as f:
            json.dump(red, f)
        rx = {"schema": "zo-loop/prescription@1", "id": "RX-C20990101-1-01", "cycle": "C20990101-1", "kind": "heal", "delivery": "pr",
              "title": "Wait for competing writers", "defects": ["D-07"],
              "source": {"assessment": self.assess, "defects_digest": rxv.defects_digest(os.path.join(self.assess, "DEFECTS.md"), ["D-07"])},
              "spec": "All concurrent writes persist.", "rationale": "Fixture.", "base": {"repo": "owner/repo", "ref": "origin/main", "sha": SHA},
              "reproduction": {"result_file": self.red, "digest": canon(red), "red_on_sha": SHA, "meets_expectation": True},
              "acceptance_checks": [check], "heldout_ref": ["concurrency"],
              "change_plan": {"summary": "set busy_timeout", "files": ["packages/memory/src/database.ts", "tests/x.test.ts"], "max_files": 2},
              "risk": {"blast_radius": "memory writers", "reversibility": "revert"}, "rollback": "revert", "budget": {"live_calls": 0, "usd": 0},
              "open_questions": []}
        rx["governor"] = evaluate(rx)
        self.rx = rx

    def errs(self, rx):
        return rxv.validate(rx)

    def test_fixture_valid(self):
        self.assertEqual(self.errs(self.rx), [])

    def test_unrelated_defect_edit_keeps_binding(self):
        with open(os.path.join(self.assess, "DEFECTS.md"), "a") as f:
            f.write("\n| D-09 | Low | PRE | x | added later |\n")
        self.assertEqual(self.errs(self.rx), [])

    def test_cited_defect_edit_breaks_binding(self):
        with open(os.path.join(self.assess, "DEFECTS.md"), "w") as f:
            f.write(DEFECTS.replace("all writes persist", "most writes persist"))
        self.assertTrue(any("defects_digest" in e for e in self.errs(self.rx)))

    def test_hand_edited_tier_rejected(self):
        r = copy.deepcopy(self.rx); r["governor"]["tier"] = "L"
        self.assertTrue(any("governor" in e for e in self.errs(r)))

    def test_missing_red_signature_rejected(self):
        r = copy.deepcopy(self.rx); r["acceptance_checks"][0].pop("red")
        self.assertTrue(any("red" in e for e in self.errs(r)))

    def test_reproduction_digest_mismatch_rejected(self):
        r = copy.deepcopy(self.rx); r["reproduction"]["digest"] = "0" * 64
        self.assertTrue(any("digest" in e for e in self.errs(r)))

    def test_reproduction_on_other_sha_rejected(self):
        r = copy.deepcopy(self.rx); r["base"]["sha"] = "f" * 40; r["governor"] = evaluate(r)
        self.assertTrue(any("red_on_sha" in e for e in self.errs(r)))

    def test_uncovered_check_rejected(self):
        r = copy.deepcopy(self.rx); r["acceptance_checks"].append(dict(r["acceptance_checks"][0], id="D-07/AC-9")); r["governor"] = evaluate(r)
        self.assertTrue(any("does not cover" in e for e in self.errs(r)))

    def test_heldout_kind_in_acceptance_rejected(self):
        r = copy.deepcopy(self.rx); r["acceptance_checks"][0]["kind"] = "heldout"
        self.assertTrue(any("held-out lives in verify" in e for e in self.errs(r)))

    def test_unknown_or_missing_heldout_class_rejected(self):
        r = copy.deepcopy(self.rx); r["heldout_ref"] = ["no-such-class"]; r["governor"] = evaluate(r)
        self.assertTrue(any("unknown held-out classes" in e for e in self.errs(r)))
        r["heldout_ref"] = []; r["governor"] = evaluate(r)
        self.assertTrue(any("must name at least one held-out class" in e for e in self.errs(r)))

    def test_bad_ids_rejected(self):
        r = copy.deepcopy(self.rx); r["id"] = "RX-1"; r["defects"] = ["bug"]
        es = self.errs(r)
        self.assertTrue(any("id" in e for e in es) and any("defects" in e for e in es))


if __name__ == "__main__":
    unittest.main()
