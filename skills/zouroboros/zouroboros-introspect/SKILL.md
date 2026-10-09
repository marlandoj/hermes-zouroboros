---
name: zouroboros-introspect
description: "Self-diagnostic health scorecard for the Zouroboros layer of this Hermes profile: memory recall, graph connectivity, episode outcomes, eval calibration, procedure freshness, skill effectiveness, RAG and wiring health. Use to check system health or to feed zouroboros-prescribe (phase 1 of introspect → prescribe → evolve)."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, diagnostics, memory]
    related_skills: [zouroboros-prescribe, zouroboros-evolve, zo-memory-system, operator-digest]
prerequisites:
  commands: [bun]
---

# Zouroboros Introspect

Phase 1 of the self-heal loop. Measures the Zouroboros subsystems and prints a ranked scorecard
with a composite score (0–100%), per-metric status (HEALTHY / WARNING / CRITICAL), the weakest
subsystem and the top improvement opportunities.

```bash
bun "${HERMES_SKILL_DIR}/scripts/introspect.ts"            # formatted scorecard
bun "${HERMES_SKILL_DIR}/scripts/introspect.ts" --json     # scorecard JSON (input for zouroboros-prescribe)
bun "${HERMES_SKILL_DIR}/scripts/introspect.ts" --store    # also save it and record a memory episode
bun "${HERMES_SKILL_DIR}/scripts/introspect.ts" --verbose
```

## How it runs

- The metrics come from `packages/selfheal` (`introspect()`), not a separate copy.
- Memory is read through the distribution's memory layer: the profile's `memory.db`, the same
  database the `zouroboros` MCP server and `zo-memory-system` use. An inherited `ZO_MEMORY_DB` or
  `ZOUROBOROS_MEMORY_DB` is overridden, so a run never reads another host's memory. The schema is
  created on first use.
- `--store` writes `scorecard-<ms>.json` to `$ZOUROBOROS_STATE_DIR/selfheal/`, a searchable
  `zouroboros.introspection` fact and an episode tagged `zouroboros.introspection`.
- Read-only otherwise. It makes no model calls.

## Reading the result

- A fresh profile has little memory, so several metrics start CRITICAL with "No episode data"
  or similar. That is a true reading, not a failure.
- Metrics that need workspace tooling the profile does not have (for example the continuation
  eval fixtures) report a low default with a recommendation instead of failing.
- Run it on a schedule with Hermes cron (`hermes cron create`) if you want a daily scorecard.
