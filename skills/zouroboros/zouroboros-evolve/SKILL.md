---
name: zouroboros-evolve
description: "Execute a Zouroboros self-heal prescription and validate it: autoloop mode for file-targeting playbooks, script mode for procedural ones, with before/after measurement, automatic revert on regression and results recorded as memory episodes. Use after zouroboros-prescribe, once the operator has reviewed the prescription."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, evolution, autoloop]
    related_skills: [zouroboros-prescribe, zouroboros-introspect, autoloop, operator-digest]
prerequisites:
  commands: [bun]
---

# Zouroboros Evolve

Phase 3 of the self-heal loop.

```bash
bun "${HERMES_SKILL_DIR}/scripts/evolve.ts" --prescription rx.json --dry-run   # show the plan, change nothing
HERMES_ZOUROBOROS_ALLOW_SWARM=1 bun "${HERMES_SKILL_DIR}/scripts/evolve.ts" --prescription rx.json
```

`--skip-governor` overrides a blocked prescription. Use it only when the operator has
explicitly approved that prescription.

## Execution modes

1. **Autoloop mode:** used when the prescription carries a `program.md`. The program is
   written to the workspace root and run with the distribution's `autoloop` skill
   (`skills/zouroboros/autoloop`), which proposes changes through the profile's executor
   registry (default `hermes-vps`).
2. **Script mode:** used when there is no target file. It runs the playbook's procedural
   remediation.

## Safety

- **Opt-in.** Anything other than `--dry-run` changes files, so it refuses to run (exit 2)
  unless `HERMES_ZOUROBOROS_ALLOW_SWARM=1` is set. That is the same switch swarm and autoloop
  runs use. Set it only after reviewing the prescription, its program and the target repository.
- **Validated.** The baseline and post-flight are measured with introspection, and a metric
  regression beyond tolerance is reverted.
- **Recorded.** Results go to `$ZOUROBOROS_STATE_DIR/selfheal/results/`, and each run is
  recorded as a `zouroboros.evolution` episode in the profile's memory database.
- **Separate logs.** Invocation logs from the crystallization path go to `$ZOUROBOROS_LOG_DIR`,
  not a shared tmpfs.
- **Exit codes:** 0 success, 1 failed or reverted, 2 not authorised.
