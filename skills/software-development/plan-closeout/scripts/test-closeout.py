#!/usr/bin/env python3
"""Unit tests for plan-closeout pure logic.

Covers the pieces that must be right regardless of git/bun availability:
  - parse_consensus_output (gate stdout -> structured status/findings)
  - phase_eval (hard-gate exit semantics)
  - gap audit (placeholder scan + python/ts orphan detection) over fixtures
  - build_report verdict wiring (eval is the only hard gate)
  - the per-repository PLAN_ACTIVE sentinel and the pre_verify hook

Run: python3 test-closeout.py   ·   Exit 0 = all pass, 1 = a failure.
Everything runs in temp dirs; nothing is written to the skill tree or $HOME.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the skill tree
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import closeout as C  # noqa: E402

_failed = 0
_total = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _failed, _total
    _total += 1
    if cond:
        print(f"PASS {name}")
    else:
        _failed += 1
        print(f"FAIL {name}{(' — ' + detail) if detail else ''}")


# --------------------------------------------------------------------------- #
# parse_consensus_output
# --------------------------------------------------------------------------- #

PASS_OUT = """📊 Results:

  ✅ hf:zai-org/GLM-5.1: PASS
  ✅ xai:grok-3-mini: PASS

📋 Consensus: PASSED
   ✅ All vendors agree — safe to proceed

ID: cg-20260615-abc123
"""

REJECT_OUT = """📊 Results:

  ⚠️ hf:zai-org/GLM-5.1: FAIL
     • Null deref on line 42 when input is empty
  ⚠️ xai:grok-3-mini: FAIL
     • Missing await on async call

📋 Consensus: REJECTED
   ❌ Unanimous rejection — fix required

ID: cg-20260615-def456
"""

DEGRADED_OUT = """📊 Results:

  🚫 hf:zai-org/GLM-5.1: ABSTAIN (no usable response)
     • Call failed: JSON Parse error
  🚫 hf:moonshotai/Kimi-K2.6: ABSTAIN (no usable response)
     • Empty response from vendor
  ✅ xai:grok-3-mini: PASS

📋 Consensus: ESCALATE
   ⓘ 2 reviewer(s) abstained (no usable response) — excluded from quorum: GLM-5.1, Kimi-K2.6
   ⚠️ ESCALATE — insufficient quorum: fewer than 2 reviewers returned a usable verdict.

ID: cg-20260615-ghi789
"""

# 1. Clean pass parsed correctly.
r = C.parse_consensus_output(PASS_OUT)
check("parse_pass",
      r["status"] == "passed" and r["consensus_id"] == "cg-20260615-abc123"
      and r["abstained"] == 0 and r["findings"] == [],
      str(r))
# 2. Reject parsed with real findings (infra noise excluded).
r = C.parse_consensus_output(REJECT_OUT)
check("parse_reject",
      r["status"] == "rejected" and len(r["findings"]) == 2
      and "Null deref on line 42 when input is empty" in r["findings"],
      str(r))
# 3. Degraded panel: escalate + abstain count, infra bullets filtered out.
r = C.parse_consensus_output(DEGRADED_OUT)
check("parse_degraded",
      r["status"] == "escalate" and r["abstained"] == 2
      and r["findings"] == [],
      str(r))

# --------------------------------------------------------------------------- #
# phase_eval — hard-gate exit semantics
# --------------------------------------------------------------------------- #

# 4. All-pass eval reports ok.
res = C.phase_eval(["true", "echo hi"])
check("eval_all_pass", all(e.ok for e in res) and len(res) == 2, str(res))
# 5. A failing command flips ok=False and records exit code.
res = C.phase_eval(["true", "false"])
check("eval_one_fail",
      res[0].ok and not res[1].ok and res[1].exit_code != 0, str(res))

# --------------------------------------------------------------------------- #
# Gap audit over a temp git repo fixture
# --------------------------------------------------------------------------- #

import subprocess  # noqa: E402


def _init_repo(tmp: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True,
                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=tmp, check=True)


with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    _init_repo(tmp)

    # Python file: one placeholder, one orphan, one wired function.
    (tmp / "mod.py").write_text(
        "def used_helper(x):\n"
        "    return x + 1\n"
        "\n"
        "def orphan_helper(y):\n"
        "    # TODO finish this\n"
        "    return y\n"
        "\n"
        "def caller():\n"
        "    return used_helper(3)\n"
    )
    # TS file: an unreferenced export.
    (tmp / "lib.ts").write_text(
        "export function danglerExport(a: number) {\n"
        "  return a * 2;\n"
        "}\n"
    )
    subprocess.run(["git", "add", "-A"], cwd=tmp, check=True)

    files = ["mod.py", "lib.ts"]

    placeholders = C.scan_placeholders(files, cwd=tmp)
    check("gap_placeholder_found",
          any(g.kind == "todo-marker" and g.file == "mod.py"
              for g in placeholders),
          str(placeholders))

    gaps = C.phase_gap_audit(files, cwd=tmp)
    kinds = {(g.file, g.kind) for g in gaps}
    check("gap_python_orphan",
          ("mod.py", "orphan-def") in kinds, str(gaps))
    check("gap_no_false_orphan_on_used",
          not any(g.kind == "orphan-def" and "used_helper" in g.detail
                  for g in gaps),
          str(gaps))
    check("gap_ts_orphan",
          ("lib.ts", "orphan-export") in kinds, str(gaps))

    # changed_files should see the staged fixtures.
    cf = set(C.changed_files(None, cwd=tmp))
    check("changed_files_detects_staged",
          {"mod.py", "lib.ts"} <= cf, str(cf))

# --------------------------------------------------------------------------- #
# build_report verdict wiring
# --------------------------------------------------------------------------- #

# 6. Eval fail => DoD not met, regardless of clean advisory phases.
rep = C.build_report(
    files=["a.py"],
    evals=[C.EvalResult("false", 1, False, "boom")],
    gaps=[],
    consensus=[],
    consensus_skipped=[],
    consensus_ran=False,
)
check("report_eval_fail_blocks",
      rep["verdict"]["definition_of_done_met"] is False, str(rep["verdict"]))
# 7. Eval pass + advisory findings => DoD met (advisory never hard-blocks).
rep = C.build_report(
    files=["a.py"],
    evals=[C.EvalResult("true", 0, True, "")],
    gaps=[C.GapFinding("a.py", 1, "orphan-def", "x")],
    consensus=[C.ConsensusFileResult("a.py", "rejected", 0, "id", ["finding"])],
    consensus_skipped=[],
    consensus_ran=True,
)
check("report_eval_pass_advisory_ok",
      rep["verdict"]["definition_of_done_met"] is True
      and rep["consensus"]["substantive_rejects"] == ["a.py"],
      str(rep["verdict"]))
# 8. render_text runs without error on a populated report.
txt = C.render_text(rep)
check("render_text_smoke",
      "PLAN CLOSEOUT" in txt and "VERDICT" in txt, txt[:80])
# 9. strict mode: eval passes but advisory findings exist => DoD NOT met, and
#    the rendered verdict agrees with the (non-zero) exit semantics.
rep_strict = C.build_report(
    files=["a.py"],
    evals=[C.EvalResult("true", 0, True, "")],
    gaps=[C.GapFinding("a.py", 1, "orphan-def", "x")],
    consensus=[],
    consensus_skipped=[],
    consensus_ran=False,
    strict=True,
)
txt_strict = C.render_text(rep_strict)
check("strict_verdict_consistent",
      rep_strict["verdict"]["definition_of_done_met"] is False
      and "NOT met (--strict)" in txt_strict,
      str(rep_strict["verdict"]) + " | " + txt_strict[-120:])

# --------------------------------------------------------------------------- #
# Phase 4 — Complexity (ponytail-review) parsing + advisory wiring
# --------------------------------------------------------------------------- #

# 13. Valid review JSON -> formatted ledger lines + net_lines.
r = C.parse_complexity_output(
    '{"file":"a.py","model":"m","api":"synthetic",'
    '"findings":[{"loc":"L3-7","tag":"yagni","what":"factory with one product",'
    '"replacement":"call it directly"}],"net_lines":5}'
)
check("complexity_parse_valid",
      r["net_lines"] == 5 and len(r["findings"]) == 1
      and r["findings"][0] == "L3-7: yagni: factory with one product. call it directly."
      and r["note"] == "",
      str(r))

# 14. Empty findings -> lean (no findings, net 0, no note).
r = C.parse_complexity_output('{"findings":[],"net_lines":0,"api":"synthetic"}')
check("complexity_parse_lean",
      r["findings"] == [] and r["net_lines"] == 0 and r["note"] == "", str(r))

# 15. Non-JSON garbage -> empty ledger with a note (never raises).
r = C.parse_complexity_output("bun: command not found")
check("complexity_parse_garbage",
      r["findings"] == [] and r["note"] == "unparseable review output", str(r))

# 16. The review's own note (no key / transient error) is surfaced verbatim;
#     api=none with no note falls back to a generic "review unavailable".
r = C.parse_complexity_output(
    '{"findings":[],"net_lines":0,"api":"none","note":"review error: API 429"}'
)
check("complexity_parse_note_passthrough",
      r["note"] == "review error: API 429", str(r))
r = C.parse_complexity_output('{"findings":[],"net_lines":0,"api":"none"}')
check("complexity_parse_unavailable_fallback",
      r["note"] == "review unavailable", str(r))

# 17. COMPLEXITY is advisory even under --strict: findings present, eval passes,
#     no gaps/rejects => DoD still MET (complexity never gates the exit code).
rep_cx = C.build_report(
    files=["a.py"],
    evals=[C.EvalResult("true", 0, True, "")],
    gaps=[],
    consensus=[],
    consensus_skipped=[],
    consensus_ran=False,
    strict=True,
    complexity=[C.ComplexityFileResult("a.py", ["L3: yagni: x. y."], 5)],
    complexity_ran=True,
)
check("complexity_never_gates",
      rep_cx["verdict"]["definition_of_done_met"] is True
      and rep_cx["complexity"]["finding_count"] == 1
      and rep_cx["complexity"]["net_lines_possible"] == 5,
      str(rep_cx["verdict"]) + " | " + str(rep_cx["complexity"]))

# 18. render_text shows the COMPLEXITY section with the suggestion line.
txt_cx = C.render_text(rep_cx)
check("complexity_render_section",
      "4. COMPLEXITY" in txt_cx and "a.py:L3: yagni: x. y." in txt_cx, txt_cx[-200:])

# --------------------------------------------------------------------------- #
# Plan-active sentinel lifecycle (gate the pre_verify hook enforces)
# --------------------------------------------------------------------------- #

with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    os.environ["ZOUROBOROS_STATE_DIR"] = str(td / "state")
    os.environ.pop("ZOUROBOROS_WORKSPACE", None)  # hermetic root resolution
    repo_a, repo_b = td / "a", td / "b"
    for r in (repo_a, repo_b):
        r.mkdir()
        _init_repo(r)
    state = C.plan_state_dir(repo_a)

    # 19. state is keyed per repository root and lives under ZOUROBOROS_STATE_DIR.
    check("sentinel_keyed_per_root",
          state.parent == td / "state" / "plan-closeout"
          and state != C.plan_state_dir(repo_b)
          and state == C.plan_state_dir(repo_a / "."), str(state))

    # 20. default_root resolves the git top level from a subdirectory.
    (repo_a / "sub").mkdir()
    check("default_root_git_toplevel",
          C.default_root(str(repo_a / "sub")).resolve() == repo_a.resolve(),
          str(C.default_root(str(repo_a / "sub"))))

    # 10. arm writes the sentinel with the label; status reports it.
    C.arm_plan("my plan", state, repo_a)
    st = C.plan_status(state, repo_a)
    check("sentinel_arm_writes",
          (state / "PLAN_ACTIVE").exists() and st["armed"] and st["label"] == "my plan",
          str(st))
    check("sentinel_other_repo_unarmed",
          not C.plan_status(C.plan_state_dir(repo_b), repo_b)["armed"])

    # 11. a passing closeout clears the gate and leaves a receipt.
    C.record_pass({"change_set": ["a.py"], "eval": {"ok": True}}, state)
    check("sentinel_pass_clears",
          not (state / "PLAN_ACTIVE").exists() and (state / "last-pass.json").exists(),
          str(list(state.iterdir())))

    # 12. disarm removes a re-armed sentinel.
    C.arm_plan("again", state, repo_a)
    C.disarm_plan(state)
    check("sentinel_disarm_clears", not (state / "PLAN_ACTIVE").exists(), "still present")

    # 21. end to end: --arm, a no-eval run keeps the gate, a passing --eval run clears it.
    (repo_a / "x.py").write_text("print(1)\n")
    cli = [sys.executable, "-B", str(HERE / "closeout.py"), "--cwd", str(repo_a)]
    def run(*a):
        return subprocess.run([*cli, *a], capture_output=True, text=True)
    run("--arm", "e2e")
    r1 = run("--file", "x.py", "--no-complexity")
    armed_after_noeval = json.loads(run("--status").stdout)["armed"]
    r2 = run("--file", "x.py", "--no-complexity", "--eval", "true")
    check("cli_noeval_keeps_gate_eval_clears",
          r1.returncode == 0 and armed_after_noeval
          and r2.returncode == 0 and not json.loads(run("--status").stdout)["armed"],
          r1.stderr + r2.stderr)

    # 22. consensus is off unless a gate is given; a given gate is run and parsed.
    gate = td / "gate.ts"
    gate.write_text("console.log('Consensus: REJECTED\\n  \u2022 real finding\\nID: cg-1');\n")
    r = run("--file", "x.py", "--no-complexity", "--json")
    rep_off = json.loads(r.stdout)
    import shutil
    if shutil.which("bun"):
        rep_on = json.loads(run("--file", "x.py", "--no-complexity", "--json",
                                "--consensus-gate", str(gate)).stdout)
        on_ok = (rep_on["consensus"]["ran"]
                 and rep_on["consensus"]["results"][0]["status"] == "rejected"
                 and rep_on["consensus"]["results"][0]["findings"] == ["real finding"])
    else:
        on_ok = True  # bun unavailable: the off-by-default half still runs
    check("consensus_off_by_default_external_gate_runs",
          rep_off["consensus"]["ran"] is False and on_ok, r.stdout[-300:])

    # 23. the pre_verify hook blocks once when armed, then stays silent.
    hook = HERE / "closeout-verify-hook.sh"
    run("--arm", "hook plan")
    def fire(attempt, cwd, changed=()):
        payload = {"hook_event_name": "pre_verify", "session_id": "s", "cwd": str(cwd),
                   "extra": {"attempt": attempt, "changed_paths": list(changed)}}
        return subprocess.run(["bash", str(hook)], input=json.dumps(payload),
                              capture_output=True, text=True)
    first = fire(0, td, [str(repo_a / "x.py")])
    out = json.loads(first.stdout) if first.stdout.strip() else {}
    check("hook_blocks_when_armed",
          out.get("decision") == "block" and "hook plan" in out.get("reason", "")
          and "--disarm" in out.get("reason", ""), first.stdout + first.stderr)
    check("hook_silent_on_second_nudge", fire(1, repo_a).stdout.strip() == "")
    check("hook_silent_for_unarmed_repo", fire(0, repo_b).stdout.strip() == "")
    run("--disarm")
    check("hook_silent_after_disarm", fire(0, repo_a).stdout.strip() == "")

print(f"\n{_total - _failed}/{_total} passed")
sys.exit(1 if _failed else 0)
