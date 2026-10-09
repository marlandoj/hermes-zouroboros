---
name: zouroboros-prescribe
description: "Turn a Zouroboros introspection scorecard into an improvement prescription: pick the weakest (or a named) metric, map it to a remediation playbook, generate a spec-first seed and an autoloop program.md, and run the governor that flags risky changes for human approval. Use after zouroboros-introspect, before zouroboros-evolve."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, planning, governance]
    related_skills: [zouroboros-introspect, zouroboros-evolve, autoloop]
prerequisites:
  commands: [bun]
---

# Zouroboros Prescribe

Phase 2 of the self-heal loop.

```bash
bun "${HERMES_SKILL_DIR}/scripts/prescribe.ts"                          # live scorecard, weakest metric
bun "${HERMES_SKILL_DIR}/scripts/prescribe.ts" --scorecard scorecard.json
bun "${HERMES_SKILL_DIR}/scripts/prescribe.ts" --target "Graph Connectivity"
bun "${HERMES_SKILL_DIR}/scripts/prescribe.ts" --dry-run                # print, write no prescription file
bun "${HERMES_SKILL_DIR}/scripts/prescribe.ts" --output DIR
```

Without `--scorecard` it runs introspection live. The prescription JSON is written to
`$ZOUROBOROS_STATE_DIR/selfheal/prescriptions/` unless `--output` is given, and a summary
(path, metric, playbook, governor verdict) is printed. Every prescription is also recorded as a
memory episode tagged `zouroboros.prescription` in the profile's memory database.

## Governor

The playbooks, seed and program generators and the governor come from `packages/selfheal`.
The governor blocks unattended execution and asks for human review when a prescription touches
schema or database structure, modifies more than three files, changes executor bridges or routing
weights beyond ±10%, has a seed ambiguity above 0.20, or targets a metric with no baseline.
Show the governor's reason to the operator; never bypass it on your own.

## Limits

Playbook target files follow the Zouroboros workspace layout (for example the memory skill's
scripts and fixtures). In a workspace without those files the prescription is still produced,
but zouroboros-evolve will report the missing target instead of changing anything.
