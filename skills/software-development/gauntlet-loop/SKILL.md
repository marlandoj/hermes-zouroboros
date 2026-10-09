---
name: gauntlet-loop
description: "Generate, plan, run, resume, or evaluate a Gauntlet Loop for an ambitious artifact that can be decomposed and inspected against a concrete quality bar. Use when a user asks for a Gauntlet Loop, a short Claude Code or Codex launch prompt, independent builder-critic iteration, blind comparison against references, or repeated improvement of a complex product. Do not use for one-shot tasks, work without inspectable evidence, or narrow one-file numeric optimization better handled by Autoloop."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, quality, builder-critic, evaluation, Zouroboros]
    related_skills: [autoloop, zo-swarm-orchestrator]
---
# Gauntlet Loop

Turn an ambitious goal into either a minimal launch prompt or a bounded builder-critic campaign. Preserve the method's pressure toward quality without granting unbounded authority.

Read [references/mechanics.md](references/mechanics.md) when choosing a quality bar, adapting the method to a new domain, or checking whether a proposed workflow is a real Gauntlet Loop.

## Select the mode

- **Generate:** Choose an inspectable bar and produce a short prompt for Claude Code or Codex. Use this by default when the user supplies a goal and optional references but does not ask to execute the run.
- **Plan:** Define the goal, bar, evidence, limits, authority, and receipt without changing the artifact.
- **Run:** Execute builder-critic rounds after the user authorizes changes and the required harness, evidence, isolation, and limits exist.
- **Resume:** Re-read the current artifact, incumbent, ledger, limits, and approvals. Never resume from narrative memory alone.
- **Evaluate:** Inspect an existing receipt and its evidence without mutating the artifact.

Use a simpler workflow when feedback cannot change the next action. If independent builders or fresh-context critics are unavailable, return `BLOCKED` instead of claiming a Gauntlet run.

## Generate the launch prompt

1. Restate the requested outcome as a goal, not an implementation plan.
2. Choose the strongest concrete bar an agent can inspect directly. Prefer supplied references, real comparison artifacts, reproducible tests, measurable targets, or a reference implementation.
3. If no bar is supplied, propose one that plays the same role for this goal that real Call of Duty screenshots played for Claude of Duty. Explain its value in one sentence.
4. Write one compact, paste-ready prompt as a single Markdown blockquote paragraph. Aim for 90-150 words and exceed 180 only when a safety or authority boundary requires it. Keep it outcome-oriented and let the lead agent choose the architecture, decomposition, tools, and number of rounds.

The prompt must tell the lead agent to:

- pursue the goal against the named bar and choose its own approach;
- divide the work into the smallest important pieces that can be improved and judged independently;
- fan out a builder and a separate critic with fresh context for each important piece;
- make each critic inspect the actual output, compare it directly with the bar, and use blind A/B ordering when practical;
- return the largest remaining gap to the builder and repeat until the output wins, progress stops being material, a limit is reached, or the operator stops the run;
- maintain a simple live progress page showing the artifact, evidence, verdicts, largest gaps, and evolution over time;
- use subagents and ultracode.

Do not prescribe an architecture, exact decomposition, fixed round count, or elaborate reporting format. Return exactly:

```markdown
Bar: <one sentence>

Prompt:
> <one compact prompt>
```

Before returning, verify that the bar is one concrete, accessible sentence; the prompt is one blockquote paragraph; every critic sees the real artifact; and the prompt contains no invented architecture, decomposition, or round count. Revise silently if any check fails.

When the harness does not expose `ultracode`, keep the generated instruction intact and use the highest supported reasoning effort during execution.

## Establish the run contract

Before decomposition, require:

1. An outcome stated as a goal.
2. A concrete bar the critic can inspect.
3. The actual artifact or a harness that can produce it.
4. Authorized read and write scope, protected files, and approval boundaries.
5. A frozen incumbent and rollback reference.
6. A finite time, cost, or operator-stop boundary plus a no-progress stop. Do not impose an arbitrary fixed number of rounds.
7. Working evidence separated from fresh or held-out final acceptance evidence.
8. A durable receipt location when the project already has one.

If the bar is missing, propose one and explain why it represents the goal. Obtain approval before running against a consequential subjective bar. Never let a builder create or modify its own rubric, reference set, held-out cases, score ledger, or promotion threshold.

## Run the cycle

### Supervised runtimes

The source workspace pairs browser-game runs with a supervised runtime (admission preflight,
hash-chained round receipts, critic isolation and rollback checks). That runtime is not part of
this distribution. When a project supplies its own supervised runner, call its read-only admission
gate before each builder round and proceed only when it allows the round. Without one, keep the
receipt yourself as described under **Record**, and never describe a run as runtime-supervised.
Software-renderer evidence such as SwiftShader is smoke evidence only and cannot satisfy a
target-hardware claim.

### Observe

Read the fresh artifact, incumbent, bar, constraints, prior comparable evidence, unresolved gaps, resource use, and current approvals. Certify that the artifact can be rendered, executed, compiled, measured, or otherwise inspected under recorded conditions.

Return `INVALID_EVIDENCE` when the artifact, harness, controls, references, or evidence cannot support a verdict. Never convert missing evidence into a low score.

### Decompose

Let the lead agent divide the goal into the smallest components that can be improved and judged independently. Record dependencies and assign non-overlapping write scopes. Parallelize only components that cannot overwrite or invalidate one another's work or evidence.

### Build

Give each builder the goal, component, authorized scope, relevant bar, protected state, and current largest gap. Require one bounded, reversible hypothesis per round. Use isolated branches or worktrees for code changes.

Builders may inspect working evidence but may not write critic evidence, final acceptance evidence, rubrics, thresholds, or approval records.

### Judge independently

Use a separate critic with fresh context. Give it the goal, bar, relevant rules, actual candidate artifact, incumbent or reference, and certified evidence. Do not provide the builder's rationale or reveal which candidate should win.

Use blind A/B ordering when practical. The critic must inspect real pixels, running behavior, tests, measurements, or finished content rather than a builder-authored summary. Require one verdict:

- `CANDIDATE_WINS`: cite the evidence and name the next largest gap, if any.
- `REFERENCE_WINS`: name the largest meaningful gap to address next.
- `INVALID_EVIDENCE`: identify what must be repaired before judgment.

A favorable critic cannot override a failed deterministic test, hard requirement, authority check, or evidence-integrity check.

### Promote or restore

Promote the candidate to incumbent only when targeted evidence materially improves or clears its threshold and all protected gates remain green. Otherwise discard the candidate or restore the prior incumbent. Record regressions explicitly.

### Integrate

After each multi-component wave, use a fresh integrator or critic to inspect the complete artifact. Repair cross-component conflicts and coherence regressions, then rerun whole-artifact functional and acceptance checks.

### Show progress

Maintain a simple read-only live progress page for substantive runs. Derive it from the run ledger and show the goal, bar, incumbent, current components, actual artifacts, comparison evidence, verdicts, largest gaps, resource use, and terminal state. The page must not mutate control state or grant approval.

### Record

Append a receipt containing the goal, bar, reference versions, authorized scope, candidate and incumbent identifiers, rollback reference, component, hypothesis, builder, critic, changed files, commands, evidence locators, verdict, largest gap, protected-gate results, resource use, approvals, and terminal state.

Treat the receipt as evidence, not promotion authority.

### Repeat or stop

Continue while a distinct evidence-backed strategy remains, limits allow another round, and the next action stays within authority. Use these terminal states:

- `SUCCESS`: bars, protected gates, fresh acceptance checks, and integration checks pass.
- `CLEAN_NOOP`: fresh observation shows the reported gap is absent or already fixed.
- `INVALID_EVIDENCE`: the artifact, harness, bar, controls, lineage, or evidence cannot support a verdict.
- `REGRESSED`: the candidate worsens a protected gate; restore the incumbent.
- `STRATEGY_REVIEW`: repeated attempts using the same strategy fail to make material progress.
- `STAGNATED`: no distinct evidence-backed in-scope strategy remains.
- `EXHAUSTED`: an operator-supplied resource limit is reached.
- `APPROVAL_REQUIRED`: the next action crosses scope, authority, cost, architecture, production, or promotion boundaries.
- `BLOCKED`: a required tool, environment, reference, data source, or enforcement mechanism is unavailable.
- `ABORTED`: the operator cancels the run.

Never report a non-success terminal state as success.

## Route narrow optimization

Use Autoloop instead when the subproblem has exactly one tracked target file, one deterministic numeric metric, a clean isolated worktree, frozen held-out cases, and explicit experiment, duration, stagnation, and cost limits.

An Autoloop `KEEP` receipt is only working evidence. Run independent component and whole-artifact Gauntlet checks before promotion.

## Preserve authority

This skill does not authorize merge, deployment, publication, protected-branch promotion, external communication, destructive action, spending beyond an approved cap, scheduling, or self-modification. Stop at `APPROVAL_REQUIRED` when the next action crosses those boundaries.

For self-modifying systems, keep product optimization separate from control-plane evolution. A Gauntlet result may propose a process change, but only a separate held-out evaluation and authorized promotion path may adopt it.
