# Zouroboros closed loop — contract

The loop that gives Zouroboros its name: **introspect → prescribe → evolve → verify**, repeated.
This contract is shared by these skills:

| Phase | Skill | Writes |
|---|---|---|
| Introspect | `zouroboros-platform-assessment` | assessment dir (`REPORT.md`, `TEST-MATRIX.md`, `DEFECTS.md`, `evidence/`) |
| Prescribe | `zouroboros-loop-prescribe` | `prescriptions/<rx>.json`, `PRESCRIPTIONS.md` |
| Evolve | `zouroboros-loop-evolve` | worktree branch, commits, `evolve/<rx>.json`, draft PR (if approved) |
| Verify | `zouroboros-loop-verify` | `verify/<rx>.json`, `VERIFY-<rx>.md` |
| Orchestrate | `zouroboros-loop` | `ledger.jsonl`, `CYCLE.md`, `PROGRESS.md` |

It implements the Zouroboros Constitution (`skills/zouroboros/zouroboros-governance/references/CONSTITUTION.md`).
Where an article's mechanism is missing on this host, the loop says so and fails closed. It never
claims the missing guarantee.

## Constitution mapping
| Article | How the loop enforces it |
|---|---|
| I Frozen weights | Prescriptions may change code, config, prompts, gates and docs only. Any prescription that trains or fine-tunes a model is rejected by the governor. |
| II No evolution without verification | Only verify can set `certified`. Nothing is called done until a human merges a certified PR and the next introspect confirms it. |
| III The metric is not the target | Verify adds **held-out** checks the evolve phase never receives. A tamper check rejects diffs that weaken tests, skip checks, or edit the verify harness or held-out catalog. A 100% pass rate on a saturated suite is reported as uninformative. |
| IV Reversibility | Every change is a discrete commit on a `zo-loop/*` branch, delivered as a PR. Rollback means closing the PR and deleting the branch, or `git revert <sha>` after a merge. Prescriptions must state their rollback. |
| V Human sovereignty | The skills never merge, deploy, change repo settings or visibility, or send messages. Pushing a branch or opening a PR needs an approval recorded for that prescription. Where `main` has no branch protection, a human merge is the only selection barrier, and every PR states the actual protection status (checked live). |
| VI Provenance | The hash-chained `ledger.jsonl` records every transition with actor, evidence digest and previous hash. Commits carry the prescription ID, the defect IDs and the evidence digest. |
| VII Resource governance | Each cycle has an operator-approved budget: live model calls, embedding calls and dollars. Every call is logged. When the budget is exhausted the loop pauses. |
| VIII Layer integrity | A prescription that touches the loop's own skills, gates, governance, or the verify harness is tier **G** (governance). It needs separate human approval and is never auto-advanced. |
| IX Fail-safe defaults | Missing approval, a broken ledger chain, unknown state, dirty worktree, failed base reproduction or missing evidence each produce a **block**, never a pass. |
| X Amendment | This contract and the skills change only through reviewed edits with a recorded rationale. The loop may prescribe changes to itself (tier G) but may not apply them without a human. |

## Heal vs evolve (`ZOUROBOROS.md`)
Every prescription declares a `kind`:
- **heal** restores a fixed, declared spec. Examples: a defect against documented behaviour,
  a broken contract, a security property. The proof is red→green on an executable check that
  encodes the spec, plus no regressions.
- **evolve** moves the spec to a new, better target. Examples: higher retrieval hit@k, lower
  latency, new capability. The proof is a measured improvement on a **held-out** metric against
  the incumbent baseline, with variance reported, plus no regressions. If the prescription has
  no baseline it cannot be verified, so it is blocked (Article II).

## Identifiers
- Cycle: `C<YYYYMMDD>-<n>`, for example `C20261013-1`.
- Prescription: `RX-<cycle>-<nn>`, for example `RX-C20261013-1-01`.
- Branch: `zo-loop/<cycle>/<rx-suffix>-<slug>`.
- Loop home: `<loop home>/`, with one folder per cycle under
  `cycles/<cycle>/`.

## Prescription states (enforced by `scripts/ledger.py`)
```
proposed ──approve──▶ approved ──start──▶ evolving ──branch-ready──▶ evolved ──verify──▶ verifying
   │                     │                    │                                          │
   └─reject─▶ rejected   └─withdraw─▶ withdrawn└─abandon─▶ abandoned       ┌──────────────┼──────────────┐
                                                                         certified     failed      inconclusive
certified ──pr-opened──▶ pr-open ──merged(human)──▶ merged ──confirmed(next introspect)──▶ confirmed
                              └─closed──▶ closed            └─regressed──▶ regressed (→ new heal prescription)
failed / inconclusive ──retry(approve again)──▶ approved   (max 2 retries per prescription)
failed / inconclusive ──abandon(operator)──▶ abandoned
verifying ──verify-abort(recovery, --note)──▶ evolved

delivery "operator" (runbook performed by a human, or by the agent on the operator's direction):
proposed ──approve(operator-runbook)──▶ approved ──applied(operator, words + evidence)──▶ applied
applied ──confirmed(acceptance re-run / next introspect)──▶ confirmed     applied ──regressed──▶ regressed
```
- `approve`, `withdraw`, `retry`, `applied`, `pr-opened` (push and PR), `merged` and `closed` need
  `actor: operator`, or evidence of a human action. `merged` is recorded from the GitHub API,
  never asserted.
- `certified`, `failed` and `inconclusive` can only be written by the verify skill with a
  verify report digest.
- `confirmed` and `regressed` can only be written from a later introspect, citing the matrix
  row that re-tested the defect. They follow `merged` (PR delivery) or `applied` (operator
  delivery).
- `applied` records that an operator-delivered runbook was performed. It needs the operator's
  words (who performed it, or their direction to the agent), at least one evidence file (the
  acceptance-check result), and the prescription unchanged since approval. Evolve never
  `start`s an operator-delivered prescription.

## Approval record
An approval is a ledger event `{"event":"approve", "actor":"operator", "scope":[...], "rx":..., "rx_digest":...}`.
- `rx_digest` is the SHA-256 of the canonical prescription JSON. Editing the prescription
  after approval invalidates the approval, which is fail-closed.
- `scope` lists what is authorized. For `delivery: pr`: `evolve-local` (worktree and commits
  only), `push-branch`, `open-draft-pr`. For `delivery: operator`: `operator-runbook` only.
  Either may add `live-calls:<n>`. The ledger refuses a scope that doesn't match the
  prescription's delivery, and records the delivery in the approval.
- Approvals come from the operator in the conversation. The agent records them verbatim and
  never infers them.

## Governor tiers (`zouroboros-loop-prescribe/scripts/governor.py`)
| Tier | Meaning | Flags that set it |
|---|---|---|
| L (low) | Local, reversible, small | ≤3 files; tests/docs/isolated code; no flags below |
| M (medium) | Broader change | >3 files, public interface or CLI behaviour change, dependency change, config defaults |
| H (high) | Shared state or security | DB schema/migrations, data-format changes, auth/secret handling, network exposure, executor bridges, routing weights beyond ±10 %, process/signal handling, concurrency/locking |
| G (governance) | Self-referential | Touches the loop skills, verify harness or held-out catalog, governance/constitution files, CI workflows, branch protection, or the gates (decision gate, governor, plan gate) |
| BLOCK | Not allowed | Model weights (Art. I); no executable acceptance check; heal without base reproduction; evolve without baseline; ambiguity > 0.20; touches the deployed checkout or production data directly |

Every tier needs operator approval under the current autonomy setting. The tier controls how
much evidence verify demands, and whether a separate review is recommended (H and G).

## Stop conditions (orchestrator)
Pause and report when any of these happens:
- Any transition needs operator approval.
- The budget is exhausted.
- 2 consecutive `failed` results in a cycle.
- A prescription hits its retry limit (2).
- A `regressed` is detected.
- The ledger chain fails verification.
- The worktree or base is dirty or unknown.
- Stagnation: no `confirmed` result across 2 completed cycles.
- At most 3 PR-delivery prescriptions are active per cycle (operator-delivered runbooks are not counted), which keeps the blast radius small.

## Handoffs
- **introspect → prescribe:** assessment directory path plus `DEFECTS.md` digest. Optionally,
  the upstream metric scorecard (`zouroboros-introspect --json`) when available, labelled
  "metric track".
- **prescribe → evolve:** an approved `prescriptions/<rx>.json` whose `rx_digest` matches the
  approval.
- **evolve → verify:** `evolve/<rx>.json` with base SHA, head SHA, branch, files touched and the
  local check results. The worktree must be clean at head SHA.
- **verify → orchestrator:** `verify/<rx>.json` with a verdict and evidence digest.
- **merge → next introspect:** the merged SHA. A later assessment run re-tests the defect IDs
  and the orchestrator records `confirmed` or `regressed`.
