# Verdict rules (implemented in `scripts/verify.py`)

Verify is the loop's fitness function (Constitution Arts. II and III). Its verdict is one of
**certified**, **failed** or **inconclusive**. Integrity problems produce **no verdict at all**
(a refusal, exit 3). Rules are evaluated top-down. Any FAILED rule wins; otherwise any
INCONCLUSIVE rule wins; otherwise the verdict is CERTIFIED.

## Refuse (exit 3, ledger unchanged)
- The prescription, evolve record or worktree is unreadable or incomplete.
- The prescription's digest ≠ the approval digest, or ≠ the evolve record's `rx_digest`.
- The ledger state is not `evolved`, or the ledger head ≠ the evolve record head.
- The worktree HEAD moved, or the worktree is dirty.

## FAILED: the change is rejected
| Rule | Why |
|---|---|
| An acceptance check fails on head | The declared spec does not hold. |
| A held-out check fails on head | The fix doesn't generalize beyond the visible check (Art. III). |
| A suite step that passed on base fails on head, or a named test failing on head didn't fail on base | Regression. |
| An MCP harness test PASS on base is not PASS on head, or a new failing harness test appears | Regression in the assessment contract. |
| Any tamper flag (deleted or renamed-away test, net assertion removal, skip/only marker, test-script or exclude change, protected path) | Weakening the selection pressure is never an improvement. |

## INCONCLUSIVE: not certifiable yet (fix the evidence, not the verdict)
| Rule | Typical resolution |
|---|---|
| Base is no longer red with the defect signature | The defect vanished upstream or the check is wrong. Re-derive the prescription on the current base. |
| A test failing on both base and head is not in the operator-approved known-failures list | The operator approves an allowlist entry citing a defect, or a heal prescription fixes it. |
| A suite step fails on both sides with no test-level detail | Fix the environment, or make the step report test names. |
| Tier H or G with no discriminating held-out check | Add a held-out probe to the catalog that is red on base. |
| `kind: evolve` (every case, for now) | **Not implemented in `verify.py` v1.** Evolve-kind prescriptions are always inconclusive until metric comparison is built. Intended design: repeat ≥ 5 on base and head; improvement must exceed 2 pooled σ and be > 0; any other metric regressing > 0.02 fails; visible vs held-out divergence > 0.05 is Goodhart, so fail. Thresholds are ported from upstream `selfheal` (`heldout-verification.ts`, `holdout.ts`). Building this is itself a tier-G prescription. |
| MCP harness comparison unavailable | The harness output is missing on one side. Rerun. |

## CERTIFIED means "ready for human review"
Certified means: acceptance is green on head and red on base; held-out is green on head and
discriminating; there are no suite or harness regressions; and nothing was tampered with. It
is **not** constitutional promotion. That additionally requires:
- the governance attestation issuer (Claude Code and Codex CLI persona reviews from authenticated
  sessions, bound to the exact commit and evidence digest), which is not installed on this
  workstation;
- CI green on the PR;
- a human merge. Where `main` is unprotected, the human merge is the only barrier.

Every PR body states this.

## Known failures (`<loop-home>/known-failures.json`)
```json
{"schema": "zo-loop/known-failures@1", "entries": [
  {"step": "bun-tests", "test": "<exact failing test name>", "defect": "D-NN", "reason": "…",
   "approved_by": "operator", "operator_words": "<verbatim>", "recorded_utc": "…"}]}
```
- Entries need every field. `approved_by: test-fixture` is honoured only in a smoke ledger.
- The list masks only failures present on **both** base and head. A new failure always fails
  the verdict.
- Keep the list short, and remove an entry when its defect is healed.
