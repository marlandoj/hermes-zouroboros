---
name: zouroboros-loop-verify
description: Certify or reject an evolved change with proof.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux]
metadata:
  hermes:
    category: zouroboros
    tags: [zouroboros, self-healing, verify, held-out, closed-loop]
    related_skills: [zouroboros-loop, zouroboros-loop-evolve, zouroboros-platform-assessment]
prerequisites:
  commands: [git, python3, bun, pnpm]
---

# Zouroboros Loop Verify Skill

Phase 4 of the Zouroboros loop (introspect → prescribe → evolve → **verify**), and its fitness
function. It independently rebuilds base and head from the mirror and runs the following:

- re-confirms the defect is red on base;
- runs the acceptance checks on head;
- runs held-out probes that evolve never sees, and that must discriminate on base;
- compares the full suite at test level and the whole MCP assessment harness, base vs head;
- scans the diff for test weakening.

It then issues **certified**, **failed** or **inconclusive** under fail-closed rules and records
the verdict in the hash-chained ledger. It never edits code and never merges. Certified means
ready for human review, not constitutional promotion.

## When to Use
- `ledger.py state` shows a prescription `evolved` (after `zouroboros-loop-evolve`).
- Re-verifying after the operator updates the known-failures list or the held-out catalog
  changes (approve a retry first).

## Prerequisites
- The `zouroboros-loop` skill (ledger, repo mirror, check runner) and the evolve skill
  (`local-suite.sh`).
- The prescription, its evolve record (`cycles/<C>/evolve/<rx>.json`) and a clean worktree at
  the recorded head.
- The assessment harnesses in `zouroboros-platform-assessment/scripts` (`mcp-e2e.ts`).
- No model calls are needed. Independent persona reviews are out of scope until an operator
  budget and the governance issuer exist.

## How to Run
Read `references/verdict-rules.md` and `references/heldout-catalog.md` with `read_file`. Then,
with `terminal`:

```bash
python3 scripts/verify.py --home <loop home> --cycle <C> \
  --rx cycles/<C>/prescriptions/<RX>.json --evolve cycles/<C>/evolve/<RX>.json
```

Exit codes: 0 certified · 1 failed · 2 inconclusive · 3 refused (integrity; ledger unchanged).
Outputs: `cycles/<C>/verify/<RX>.json`, `VERIFY-<RX>.md`, and raw step outputs under
`cycles/<C>/verify/<RX>/`.

## Quick Reference
| Component | Role |
|---|---|
| `"${HERMES_SKILL_DIR}"/scripts/verify.py` | Pipeline: integrity → rebuild → suite → acceptance → held-out → harness → tamper → verdict |
| `"${HERMES_SKILL_DIR}"/scripts/tamper-check.py` | Deleted or renamed tests, removed assertions, skip/only, test-script or exclude edits, protected paths |
| `heldout/catalog.json` + `heldout/probes/` | Held-out checks per defect class; each must be red on the current base before use |
| `<loop-home>/known-failures.json` | Operator-approved pre-existing failures (smoke ledgers may use labelled fixtures) |

## Procedure
1. Confirm the ledger state is `evolved` and that `ledger.py verify` passes.
2. Run `verify.py`. It records `verify-start`, then the verdict, with the report as evidence.
3. Read `VERIFY-<RX>.md`. For **failed**, report the reasons; the orchestrator decides whether
   to approve a retry or abandon. For **inconclusive**, report what evidence is missing (see
   verdict-rules.md resolutions). Never relabel it.
4. For **certified**, hand back to the orchestrator. Evolve opens a draft PR only if the
   approval scope allows it.
5. After a human merges, the next platform assessment re-tests the defect, and the orchestrator
   records `confirmed` or `regressed`.

## Pitfalls
- A held-out probe that passes on base proves nothing. Verify reports it as non-discriminating;
  fix the probe.
- Verify the probes themselves. Two of the first three were wrong: one used a relative marker
  path, and one sent SIGINT to a background job that ignores it. Both were caught by requiring
  red on `main`.
- Don't run verify in the evolve worktree. It always uses fresh `/tmp` exports of both SHAs.
- Pre-existing failures are never silently ignored. They make the verdict inconclusive until
  the operator approves an allowlist entry or a heal prescription fixes them.
- Editing the prescription after approval makes verify refuse. Write a new prescription and
  re-approve.

## Verification
- `python3 -m unittest discover -s tests` passes (tamper-check tests).
- The verify report's `head_sha` equals the evolve record and the ledger head. The ledger
  verdict event carries the report digest.
- Re-running verify on the same inputs yields the same verdict. Nondeterminism means a flaky
  check, and that is a defect.
