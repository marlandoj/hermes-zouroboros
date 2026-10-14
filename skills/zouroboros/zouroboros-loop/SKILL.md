---
name: zouroboros-loop
description: Run the introspect-prescribe-evolve-verify loop.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux]
metadata:
  hermes:
    category: zouroboros
    tags: [zouroboros, self-healing, self-evolving, closed-loop, governance]
    related_skills: [zouroboros-platform-assessment, zouroboros-loop-prescribe, zouroboros-loop-evolve, zouroboros-loop-verify]
prerequisites:
  commands: [python3, git, gh, bun, pnpm, jq]
---

# Zouroboros Loop Skill

This orchestrates the closed loop that gives Zouroboros its name: **introspect → prescribe →
evolve → verify**, repeated. Its rules come from the Zouroboros Constitution: no evolution
without verification, reversibility, human sovereignty, provenance, and fail-safe defaults. It
owns the shared machinery: the hash-chained ledger, the check runner, and the repo plumbing.
It decides the next step from the ledger and pauses whenever the operator must decide. It
never approves, merges, deploys or spends on its own.

## When to Use
- The operator asks to run, resume, or report on the self-healing / self-evolving loop.
- After a platform assessment, to turn its defects into verified fixes.
- After a human merges a loop PR and deploys, to confirm the fix with the next assessment.

## Prerequisites
- Phase skills: `zouroboros-platform-assessment` (introspect), `zouroboros-loop-prescribe`,
  `zouroboros-loop-evolve`, `zouroboros-loop-verify`.
- `gh` authenticated for the repository owner. Bun, pnpm, jq, and the Node toolchain in
  `~/.hermes/tools`.
- Loop home `<loop home>/`, holding `ledger.jsonl`, `cycles/`,
  `repos/` (mirror), `worktrees/`, `logs/`, `tmp/` and an optional `known-failures.json`.
- MCP `codebase-memory` (graph-first code retrieval) for the phase skills.

## How to Run
Read `references/loop-contract.md` (states, actors, approvals, tiers, stop conditions) with
`read_file`. Use `terminal` for:

| Script | Purpose |
|---|---|
| `"${HERMES_SKILL_DIR}"/scripts/loop-status.py --home H` | Next action and owner for every prescription, plus stop conditions. Exit 0 means the agent may proceed, 4 means paused. |
| `"${HERMES_SKILL_DIR}"/scripts/ledger.py` | `init`, `cycle-open`/`cycle-close`, `budget`/`budget-raise`/`spend`, `event`, `state`, `verify`, `digest` |
| `"${HERMES_SKILL_DIR}"/scripts/check-runner.py` | One executor for acceptance, held-out and regression checks (refuses the deployed checkout; requires red signatures) |
| `"${HERMES_SKILL_DIR}"/scripts/repo.sh` | Mirror `sync`, `export`/`export-remove`, `worktree-add`/`worktree-remove`, `build`, `clean-check` |
| `"${HERMES_SKILL_DIR}"/scripts/pr-sync.py --home H` | Records `merged`/`closed` from the GitHub API, never by assertion |

Tests: `python3 -m unittest discover -s tests` (ledger and check-runner).

## Quick Reference
- One cycle: `cycle-open` (zero budget by the loop, or a budget by the operator) → introspect →
  prescribe → **operator approves** → evolve → verify → **operator decides PR** → human merges
  → next introspect confirms → `cycle-close`. Operator-delivered runbooks: approve
  (`operator-runbook`) → the operator performs the runbook → `applied` (operator words +
  acceptance evidence) → confirm.
- The agent never: approves, raises budget, merges, deploys, changes repo settings, or edits
  approved prescriptions.
- Stop and report on: any operator step, budget exhausted, 2 consecutive `failed`, retry limit,
  `regressed`, invalid ledger, more than 3 active PR prescriptions, or 2 closed cycles with no
  `confirmed`.

## Procedure
1. **Orient.** Run `ledger.py verify`, then `loop-status.py`. If the status is paused, report
   the operator decisions it lists, with the evidence, and stop.
2. **Open a cycle** if none is open: `ledger.py cycle-open --cycle C<YYYYMMDD>-<n> --budget-calls 0 --budget-usd 0 --actor loop`.
   Any budget for live model calls comes from the operator (`budget-raise`, with their words).
3. **Introspect.** Run `zouroboros-platform-assessment`, or reuse a current assessment.
   Defects become the cycle's input.
4. **Prescribe** (`zouroboros-loop-prescribe`). Red reproduction on `origin/main`, governor,
   validation, `PRESCRIPTIONS.md`, `propose` events. **Pause for approval.**
5. **Record approvals** exactly as given:
   `ledger.py event --event approve --actor operator --rx-file … --data '{"scope":[…],"operator_words":"<verbatim>"}'`.
6. **Evolve** each approved PR prescription (`zouroboros-loop-evolve`), one at a time, up to 3.
   Operator-delivered prescriptions skip evolve: once the runbook is performed, record
   `ledger.py event --event applied --actor operator --rx-file … --evidence <acceptance result> --data '{"operator_words":"<verbatim>"}'`.
7. **Verify** each evolved prescription (`zouroboros-loop-verify`). Then:
   - **certified:** pause for the operator's PR decision.
   - **failed:** report, and pause for retry or abandon.
   - **inconclusive:** report the missing evidence, and pause.
8. **PR** only with scope: run evolve's `open-pr.sh` (draft). Then run `pr-sync.py`
   periodically. A human merges and deploys.
9. **Confirm.** After deploy, run the assessment again. For each merged (or `applied`) prescription, record
   `confirmed` or `regressed` (actor `introspect`, with the assessment path and matrix rows). A
   regression becomes a new heal prescription.
10. **Close** the cycle (`cycle-close`) when no prescription is active. Update `CYCLE.md` from
    `templates/CYCLE.md`.

## Pitfalls
- Never write approvals the operator didn't give. A smoke ledger (`init --mode smoke`) is the
  only place for the `test-fixture` actor, and it can't be used in live mode.
- Never edit `ledger.jsonl`. Every write re-verifies the chain, so one edited line blocks the
  whole loop.
- Revise prescriptions only while `proposed`. After approval, write a new prescription.
- If `main` has no branch protection, human review is the only selection
  barrier, and every PR says so.
- The upstream `selfheal` scorecard can fabricate readings when its sources are missing. Keep the metric
  track off until it fails closed.
- `/tmp` is RAM-backed on this host. Exports and check scratch are removed after each run; keep
  evidence under the loop home.

## Verification
- `ledger.py verify` passes, and `loop-status.py` agrees with `ledger.py state`.
- Every non-proposed prescription has evidence files whose digests are recorded in the ledger.
- Unit tests pass in all four loop skills (`scripts/tests/`), and a smoke ledger
  (`ledger.py init --mode smoke`) reproduces a full cycle end to end.
