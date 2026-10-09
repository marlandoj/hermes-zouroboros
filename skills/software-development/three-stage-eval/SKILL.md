---
name: three-stage-eval
description: |
  Progressive 3-stage verification pipeline for evaluating artifacts against specifications. Stage 1: mechanical checks (lint/test/$0). Stage 2: semantic evaluation against acceptance criteria. Stage 3: multi-perspective consensus for high-stakes decisions. Adapted from Q00/ouroboros.
version: 1.0.0
author: Zouroboros (adapted from Q00/ouroboros)
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, Evaluation, QA, Verification]
    related_skills: [ponytail-audit]
    origin: https://github.com/Q00/ouroboros
---


# Three-Stage Evaluation Pipeline

> Mechanical → Semantic → Consensus. Each gate must pass before the next.

## When to Use

- After implementing a spec-first-interview seed
- Before merging or deploying any significant artifact
- When reviewing skill outputs, web routes, or agent configurations
- As a quality gate in swarm campaigns
- Any time you need structured, repeatable artifact verification

## Quick Start

There is no script. The agent runs the pipeline and records the result.

1. Load the seed specification (goal, constraints, acceptance criteria) and locate the artifact.
2. Run Stage 1 with the project's own tooling. Stop on the first failure.
3. Score Stage 2 against each acceptance criterion with evidence.
4. Run Stage 3 only when a trigger below fires, or when asked to force consensus.
5. Write the report in the output format below. Save the YAML record when the project keeps evaluations.

## The Pipeline

### Stage 1: Mechanical Verification ($0)

Run automated checks — these cost nothing and catch obvious issues.

**Checks by project type:**

| Type | Checks |
|------|--------|
| TypeScript/Bun | `tsc --noEmit`, lint, `bun test`, coverage |
| Python | `py_compile`, pytest, ruff/flake8 |
| Markdown/Docs | Link checker, spell check, frontmatter validation |
| Web routes/apps | Build, route smoke test, server/browser error log |
| Config/YAML | Schema validation, required fields |

For each check, record PASS/FAIL:
- [ ] Syntax/compile: No errors
- [ ] Lint: Clean
- [ ] Tests: All passing
- [ ] Coverage: ≥ 70% (if measurable)

**GATE**: If ANY mechanical check fails → **STOP**. Report failures with suggested fixes. Do NOT proceed to Stage 2.

### Stage 2: Semantic Evaluation

For each acceptance criterion from the seed specification:

1. **Evidence** — Search the artifact for concrete proof (files, functions, test output)
2. **Completeness** — Is it fully implemented, not just partially?
3. **Quality** — Is the implementation sound? Any shortcuts or hacks?

Score each criterion as **MET** or **NOT MET** with evidence.

**Metrics:**
- **AC Compliance**: (criteria_met / total_criteria) × 100%
- **Goal Alignment**: 0.0–1.0 — how well does the whole serve the stated goal?
- **Drift Score**: `0.5 × goal_drift + 0.3 × constraint_drift + 0.2 × ontology_drift` (lower = better)
- **Overall Score**: Weighted by evaluation principles defined in seed

**GATE**: Overall score must be ≥ 0.8. If passed with no Stage 3 triggers → **APPROVED**.

### Stage 3: Consensus (Only if Triggered)

**Triggers** (any one activates):
1. Drift score > 0.3
2. Stage 2 score in uncertain range (0.7–0.8)
3. User explicitly requests deep review
4. Ontology evolved since seed creation
5. Goal was reinterpreted during implementation

**Process** — evaluate from 3 perspectives:

| Perspective | Role | Reference |
|-------------|------|-----------|
| **Proposer** | Argues FOR approval based on seed criteria | — |
| **Devil's Advocate** | Argues AGAINST using ontological questioning (what is assumed, what is missing, what would break it) | — |
| **Synthesizer** | Weighs both arguments, renders final decision | — |

Each perspective gives APPROVE or REJECT with reasoning. **2/3 majority decides.**

For multi-model consensus in Hermes, run each perspective as a separate `delegate_task` subagent, or as a separate model invocation with different prompting. Use a different provider or model for each perspective where available, so no perspective reviews its own work.

## Output Format

```
Evaluation Report
=================
Artifact: {path or description}
Seed: {seed_id}
Date: {iso_date}

Stage 1: Mechanical Verification
- [PASS] Syntax: TypeScript compiled successfully
- [PASS] Lint: No errors
- [PASS] Tests: 12/12 passing
- [PASS] Coverage: 87%
Result: PASSED

Stage 2: Semantic Evaluation
AC Compliance:
- [MET] Webhooks retry with exponential backoff
- [MET] Max 5 retries per delivery
- [MET] Failed deliveries stored in database
- [NOT MET] Idempotency key not implemented
AC Compliance: 75% (3/4)
Goal Alignment: 0.85
Drift Score: 0.12
Overall Score: 0.78
Result: FAILED (below 0.8 threshold)

Recommendations:
1. Implement idempotency key for webhook deliveries
2. Add test for duplicate delivery prevention

Stage 3: Not triggered

Final Decision: NEEDS WORK
```

## Saving Results

Save evaluations to the workspace:

```
{project}/evaluations/eval-{id}.yaml
```

```yaml
id: eval-{uuid}
seed_id: seed-{uuid}
timestamp: {iso_date}
stages:
  mechanical:
    passed: true
    checks:
      - { name: syntax, passed: true }
      - { name: lint, passed: true }
      - { name: tests, passed: true, detail: "12/12" }
      - { name: coverage, passed: true, detail: "87%" }
  semantic:
    passed: false
    score: 0.78
    ac_compliance: 0.75
    drift: 0.12
    criteria:
      - { name: "Retry with backoff", met: true }
      - { name: "Max 5 retries", met: true }
      - { name: "Persist failures", met: true }
      - { name: "Idempotency key", met: false }
  consensus: null
decision: NEEDS_WORK
recommendations:
  - "Implement idempotency key"
  - "Add duplicate delivery test"
```

## QA Judge Mode

For general-purpose quality assessment (not tied to a seed spec), use the **QA Judge** framework (see `references/qa-judge.md`):

- Score across: Correctness, Completeness, Quality, Intent Alignment, Domain-Specific
- Verdicts: `pass` (done) / `revise` (continue loop) / `fail` (escalate)
- Loop until pass or max iterations reached

## Next Steps After Evaluation

| Decision | Action |
|----------|--------|
| **APPROVED** | Proceed to **Gap Audit** (mandatory before close) |
| **NEEDS WORK** | Fix identified issues, re-evaluate |
| **REJECTED** (Stage 3) | Reframe the problem laterally or re-interview the requester |

## Gap Audit (Post-Eval, Pre-Close)

After Stage 1–3 evaluation passes, run a **gap audit** before marking work complete. This catches "built but not wired" failures — code that compiles, passes tests, but is unreachable in production.

| Check | Question |
|-------|----------|
| **Reachability** | Does every new capability have a caller/trigger? |
| **Data Prerequisites** | Are schemas populated, pools configured, bootstrap data seeded? |
| **Cross-Boundary State** | Do env vars/sentinels survive process boundaries? |

If any check fails → fix → re-run eval on affected components → re-audit. Loop until clean.

The `spec-first-interview` skill (Phase 4) carries the full gap audit protocol when it is installed.

## Integration

- Pairs with `spec-first-interview` (interview → seed → build → evaluate → gap audit → close)
- Reframe laterally (change one assumption at a time) if evaluation repeatedly fails
- Works with swarm orchestrator — eval + gap audit are mandatory pipeline stages
