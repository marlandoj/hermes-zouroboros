---
name: zouroboros-loop-prescribe
description: Turn assessment defects into gated prescriptions.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux]
metadata:
  hermes:
    category: zouroboros
    tags: [zouroboros, self-healing, prescribe, governance, closed-loop]
    related_skills: [zouroboros-loop, zouroboros-platform-assessment, zouroboros-loop-evolve, zouroboros-loop-verify]
prerequisites:
  commands: [python3, git, gh, bun]
---

# Zouroboros Loop Prescribe Skill

Phase 2 of the Zouroboros loop (introspect → **prescribe** → evolve → verify). It turns verified
defects from a platform assessment into prescriptions. Each prescription is precise, immutable,
risk-tiered and reproducible: a spec, executable acceptance checks with defect signatures, a
confirmed red reproduction on the base commit, a scoped change plan, a rollback, and a governor
tier. It proposes only. Approval is the operator's, and changes happen in the evolve phase.

## When to Use
- A completed `zouroboros-platform-assessment` run has open defects, and the operator wants
  remediation planned.
- The `zouroboros-loop` orchestrator reaches its prescribe step.
- A prescription failed verification and needs a revised version. Write a new RX; never edit an
  approved one.

Not for applying fixes (use `zouroboros-loop-evolve`), and not for metric-only targets while the
upstream scorecard can fabricate readings when its sources are missing.

## Prerequisites
- The `zouroboros-loop` skill (shared `ledger.py`, `check-runner.py`, `repo.sh`) and an open
  cycle in `<loop home>/ledger.jsonl`.
- An assessment directory with `DEFECTS.md` and `TEST-MATRIX.md`.
- `gh` authenticated for the repository owner, and the Node toolchain under `~/.hermes/tools`.
- MCP `codebase-memory` for locating fix sites. Use the upstream checkout in the loop mirror,
  not the deployed tree.

## How to Run
Read `references/prescription-schema.md` and `references/check-patterns.md` with `read_file`.
Write prescriptions with `write_file` from `templates/prescription.json`, and run the scripts
with `terminal`:

| Script | Purpose |
|---|---|
| `"${HERMES_SKILL_DIR}"/scripts/governor.py RX.json --write` | Compute and store the risk tier (L/M/H/G/BLOCK) from the ported upstream flags and Constitution rules |
| `"${HERMES_SKILL_DIR}"/scripts/rx-validate.py RX.json …` | Fail-closed schema, evidence and governor validation |
| `"${HERMES_SKILL_DIR}"/scripts/rx-validate.py --render CYCLE_DIR` | Write `PRESCRIPTIONS.md` for operator review |
| `"${HERMES_SKILL_DIR}"/../zouroboros-loop/scripts/check-runner.py --expect fail` | Red reproduction on the base commit |
| `"${HERMES_SKILL_DIR}"/../zouroboros-loop/scripts/ledger.py event --event propose` | Record each prescription as proposed |

## Quick Reference
- Kinds: **heal** (restore a declared spec; needs red on base) and **evolve** (move the spec;
  needs a baseline with a sample size).
- Delivery: **pr** (repo change via evolve) or **operator** (host or settings runbook).
- Tiers: L ≤ 3 files, local · M broader or public interface · H data, secrets, process,
  network, bridges · G loop, gates, governance, CI · BLOCK unverifiable, weights, production
  paths, or open questions.
- At most 3 active PR prescriptions per cycle.
- IDs: `RX-<cycle>-<nn>`. Files: `cycles/<cycle>/prescriptions/`.

## Procedure
1. **Triage.** Read the assessment's `DEFECTS.md`. Choose High-severity defects and anything
   blocking a critical workflow; at most 3 PR prescriptions per cycle. Skip defects whose fix is
   an operator decision unless you record that decision as an `open_questions` item.
2. **Locate.** `repo.sh sync`, then find the fix site on `origin/main` with `search_files` or the
   codebase-memory graph. The deployed tree may differ from `main`.
3. **Write the checks** (`check-patterns.md`): self-contained, deterministic, exit 97 on setup
   failure, with a `red` signature.
4. **Reproduce red on the base.** Export `origin/main` to `/tmp`, build it, run
   `check-runner.py --expect fail`, and save the result to `cycles/<C>/evidence/`. If a check
   doesn't fail with its signature, the defect is already fixed upstream or the check is wrong.
   Don't prescribe until you know which.
5. **Write the prescription** from the template: spec, rationale with evidence, base SHA,
   reproduction (`ledger.py digest`), the smallest change plan with tests, rollback and budget.
6. **Govern and validate.** Run `governor.py --write`, then `rx-validate.py`. Fix the
   prescription, never the validator. BLOCK means don't propose it for approval.
7. **Render and propose.** Run `rx-validate.py --render`, then
   `ledger.py event --event propose --actor prescribe --rx-file …` for each prescription.
8. **Hand off.** Present `PRESCRIPTIONS.md` with a recommendation per RX
   (`templates/PRESCRIPTIONS-review.md`) and ask for approval and scope. Then stop: approval is
   the operator's words, recorded verbatim with `ledger.py event --event approve --actor operator`.

## Pitfalls
- A red result that could be a harness failure proves nothing. Declare the defect signature.
- A defect found on the deployed tree may already be fixed on `main`. Always reproduce on the
  base you will patch.
- Prescribing the implementation instead of the property lets evolve satisfy the check without
  fixing the defect (Article III).
- Editing a prescription after approval silently changes what was approved. The ledger refuses
  the next transition, so write a new RX instead.
- The upstream selfheal `prescribe()` writes a memory episode even with `--dry-run`.
  Don't call it against live data.

## Verification
- `rx-validate.py` reports every prescription valid, and `PRESCRIPTIONS.md` is rendered.
- Every heal+pr prescription's reproduction shows `meets_expectation: true` on `base.sha`.
- `ledger.py state` shows each prescription `proposed`, and `ledger.py verify` passes.
- `python3 -m unittest discover -s tests` passes (governor and validator negative tests).
