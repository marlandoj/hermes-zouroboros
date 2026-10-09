---
name: tier-resolver
description: "Estimate a task's complexity tier (trivial/simple/moderate/complex/apex) and type from its text with a 12-signal heuristic, and map it to a model slot from an operator-editable catalog. Use to pick a cheaper or stronger model for a task, to explain why a task is complex, or to tune routing from corrected feedback. Also documents the swarm decision gate."
version: 2.1.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Model Routing, Complexity, Planning]
    related_skills: [zo-swarm-orchestrator, autoloop]
prerequisites:
  commands: [bun]
---

# Tier resolver

Local and deterministic: no network or model calls (about 1-5 ms per prompt).

1. **Complexity**: 12 weighted signals, including word count, file references, multi-step
   markers, tool usage, analysis depth, domain/tech stack, concept count, verb complexity,
   scope breadth, feature lists and operational risk. They produce a score and one of five tiers.
2. **Task type**: coding, review, planning, analysis, debugging, documentation, data_science,
   devops, security, content or general.
3. **Model slot**: tier → catalog entry, with task-type, persona and constraint overrides.

## Usage

```bash
R="${HERMES_SKILL_DIR}/scripts/persona-tier-resolve.ts"
bun "$R" --json --no-feedback "Design a microservices architecture with an API gateway"
bun "$R" --budget low "Summarize this article"     # also --latency/--quality/--speed low|medium|high
bun "$R" --models                                  # catalog in use
```

Without `--json` it prints the selected model id only. **An empty line means "use the Hermes
profile's configured model"**. That is what the shipped default catalog returns for every tier
until you configure ids.

## Model catalog

The skill ships `assets/models.default.json`. It defines three logical slots (`fast`, `balanced`,
`deep`) with empty ids and no host-specific models. To route tiers to real models, copy it and
fill in ids your Hermes providers accept:

```bash
mkdir -p "$ZOUROBOROS_CONFIG_DIR/tier-resolver"
cp "${HERMES_SKILL_DIR}/assets/models.default.json" "$ZOUROBOROS_CONFIG_DIR/tier-resolver/models.json"
```

The resolver reads `$TIER_RESOLVER_CONFIG_DIR/models.json` or
`$ZOUROBOROS_CONFIG_DIR/tier-resolver/models.json` when present, and falls back to the default.
`personaOverrides` maps a persona slug to per-tier slot overrides (`--persona <slug>`).
`autoloop` passes a non-empty id to the Hermes bridge as the model override.

## Feedback and tuning (optional)

When `ZOUROBOROS_STATE_DIR` (or `TIER_RESOLVER_STATE_DIR`) is set, every resolution without
`--no-feedback` appends a sanitized record to `<state>/tier-resolver/feedback.jsonl`. Without
a state directory, nothing is recorded. Records hold the task text (truncated and sanitized).
Do not resolve secrets.

```bash
bun "$R" feedback audit                                   # corpus quality and readiness
bun "$R" feedback correct --task-id <id> --tier complex   # label a misrouted task
bun "$R" feedback tune                                    # evaluate a held-out calibration candidate
bun "$R" feedback tune --promote                          # persist weights only if held-out accuracy improves
```

Tuned weights are written to `<state>/tier-resolver/weights.json`. The built-in reference
weights are used otherwise. The skill tree is never written.

## Regression suite

```bash
bun "${HERMES_SKILL_DIR}/scripts/run-test-suite.ts"   # 50 synthetic prompts; floors: tier 84%, type 68%
bun test "${HERMES_SKILL_DIR}/scripts"                # calibration + swarm decision gate tests
```

## Swarm decision gate

Use the gate to decide whether a plan should become a swarm. It lives in the distribution package
(`packages/swarm/src/routing/swarm-decision-gate.ts`) and is wrapped by
`zo-swarm-orchestrator` (`swarm.ts gate "<plan>"`). It scores 7 signals: SWARM above 0.45,
SUGGEST from 0.30 to 0.45, DIRECT below that. An explicit "use a swarm" forces SWARM.
