---
name: zouroboros-loop-evolve
description: Apply one approved prescription on a branch.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux]
metadata:
  hermes:
    category: zouroboros
    tags: [zouroboros, self-healing, evolve, git, closed-loop]
    related_skills: [zouroboros-loop, zouroboros-loop-prescribe, zouroboros-loop-verify]
prerequisites:
  commands: [git, gh, python3, bun, pnpm]
---

# Zouroboros Loop Evolve Skill

Phase 3 of the Zouroboros loop (introspect → prescribe → **evolve** → verify). It applies one
**approved** prescription in an isolated git worktree branched from the prescription's base
commit. It works red then green: first a failing regression test in the repo's own suite, then
the smallest fix. It proves the change locally (acceptance checks, full suite against base,
scope) and hands a bound record to verify. It never touches the deployed checkout and never
merges or deploys. Pushing a branch and opening a **draft** PR happen only after verify certifies,
and only if the approval scope includes them.

## When to Use
- `ledger.py state` shows a prescription `approved` with scope `evolve-local` (from the
  `zouroboros-loop` orchestrator or the operator).
- A certified prescription whose approval also includes `push-branch` and `open-draft-pr` is
  ready to become a PR.

Not for unapproved prescriptions, operator-delivery runbooks (a human performs those), or
changes outside the prescription's `change_plan.files`.

## Prerequisites
- The `zouroboros-loop` skill: `ledger.py`, `repo.sh` (mirror at
  `<loop home>/repos/`), `check-runner.py`.
- The prescription JSON and its `approve` event with a matching digest.
- `gh` authenticated (for push and PR only). Bun, pnpm and the Node toolchain under
  `~/.hermes/tools`.
- MCP `codebase-memory` for navigating the code. Edit files in the worktree with `patch` or
  `write_file`.

## How to Run
Read `references/evolve-procedure.md` with `read_file`, then use `terminal`:

| Script | Purpose |
|---|---|
| `"${HERMES_SKILL_DIR}"/../zouroboros-loop/scripts/repo.sh worktree-add zo-loop/<C>/<nn>-<slug> <base.sha>` | Isolated branch from the base commit |
| `"${HERMES_SKILL_DIR}"/../zouroboros-loop/scripts/repo.sh build <worktree>` | Frozen install and build (log outside the worktree) |
| `"${HERMES_SKILL_DIR}"/../zouroboros-loop/scripts/check-runner.py --expect pass` | Acceptance checks green on the branch |
| `"${HERMES_SKILL_DIR}"/scripts/local-suite.sh <dir> <out.json>` | Repo suite with isolated PATH and private HOME; records failing test names |
| `"${HERMES_SKILL_DIR}"/scripts/scope-check.py` | Diff ⊆ allowed files; no deleted tests or protected paths; clean tree |
| `"${HERMES_SKILL_DIR}"/scripts/evolve-record.py` | Fail-closed handoff record bound to the head SHA (regressions vs base refused) |
| `"${HERMES_SKILL_DIR}"/scripts/open-pr.sh` | After certification and with scope: push, then open a **draft** PR (`templates/PR_BODY.md`) |

## Quick Reference
- Ledger: `start` (needs the approval digest and `evolve-local`) → `branch-ready` (base, head,
  branch) → verify takes over → `pr-opened` (needs `push-branch` and `open-draft-pr`).
- Commits: test first, then fix, each with the RX ID, defects and evidence
  (`templates/COMMIT_MSG.txt`).
- Rollback before push: `repo.sh worktree-remove <branch>` plus ledger `abandon`. After a PR:
  close it (operator). After a merge: `git revert` through a new prescription.

## Procedure
1. Run `ledger.py event --event start --actor evolve --rx-file RX.json`. A refusal means the
   approval is missing, the digest changed, or the scope is wrong. Stop and report.
2. Run `repo.sh sync`, `repo.sh worktree-add <branch> <base.sha>`, then `repo.sh build <wt>`.
3. **Red:** add the prescription's `tests_to_add` to the repo suite and run them. They must fail
   for the defect's reason. Commit (`test(...): reproduce …`).
4. **Green:** make the smallest change inside `change_plan.files`, rebuild, and run the new test
   until it passes. Commit (`fix(...): … [RX-ID]`).
5. Run the acceptance checks with `check-runner.py --repo <wt> --checks <acceptance> --expect pass --out evolve/<rx>.acceptance.json`.
6. Suite: run `local-suite.sh` on the worktree, and on a `/tmp` export of the base (or reuse a
   base suite run on the same base SHA).
7. Run `scope-check.py --worktree <wt> --rx RX.json --out evolve/<rx>.scope.json`.
8. Run `evolve-record.py … --out cycles/<C>/evolve/<rx>.json`, then
   `ledger.py event --event branch-ready --data '{base_sha, head_sha, branch}'`.
9. Hand off to `zouroboros-loop-verify`. Do not push.
10. Only if verify recorded `certified` and the approval scope allows it, run
    `open-pr.sh <loop-home> <C> RX.json evolve/<rx>.json verify/<rx>.json`. Report the draft PR
    URL; the human reviews and merges.

## Pitfalls
- Branch from `base.sha`, not the deployed tree and not a newer `main`. The red reproduction
  is bound to that commit.
- Writing the fix before the test loses the proof that the test detects the defect.
- Fixing the check instead of the spec (special-casing the harness) is gaming, and verify's
  held-out checks are designed to catch it.
- Never edit the prescription, the held-out catalog or verify scripts from an evolve branch.
  Scope and tamper checks fail it, and doing so violates Article VIII.
- `local-suite.sh` deliberately excludes `~/.local/bin` (the real Hermes, Claude and Codex
  launchers) and uses a private HOME, because `/tmp` is world-writable and the installer tests
  refuse it.
- Pre-existing failures on base are recorded, not hidden. Only regressions block evolve.

## Verification
- `scope-check.py` reports `ok`, and the evolve record exists, bound to the head SHA.
- The ledger shows `evolved` with the same head SHA, and `ledger.py verify` passes.
- The new regression test fails on base and passes on head. Verify re-checks this independently.
