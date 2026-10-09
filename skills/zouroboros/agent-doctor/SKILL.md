---
name: agent-doctor
description: "Health audit for the Hermes profile's scheduled agents (cron jobs): cost fitness against a model-tier catalog, banned models, zombies, duplicates, failing runs, stale paths, schedule pile-ups, noisy delivery, overlong instructions and unchanged outputs. Report-only by default; `apply` makes only safe fixes through `hermes cron pause|edit`. Use for a periodic fleet check-up or when cron jobs misbehave or cost too much."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, cron, scheduled-agents, health, cost]
    related_skills: [agent-model-healer, ask-governor]
prerequisites:
  commands: [bun, hermes]
---

# agent-doctor

Replaces the source workspace's Zo automation doctor. It reads the scheduled agents of the
hermes-zouroboros profile from `$HERMES_HOME/cron/jobs.json` (the profile under
`HERMES_ZOUROBOROS_HOME`). It changes them only through the Hermes CLI, which holds Hermes'
own jobs lock. It never edits `jobs.json` and makes no model calls.

```bash
bun "${HERMES_SKILL_DIR}/scripts/doctor.ts"                  # report-only (diagnose)
bun "${HERMES_SKILL_DIR}/scripts/doctor.ts" summary          # one-line summary
bun "${HERMES_SKILL_DIR}/scripts/doctor.ts" zombies          # a single check
bun "${HERMES_SKILL_DIR}/scripts/doctor.ts" apply --dry-run  # show the safe fixes it would make
bun "${HERMES_SKILL_DIR}/scripts/doctor.ts" apply            # make them (hermes cron pause|edit)
```

Add `--json` for machine-readable output. Exit codes: `0` clean, `2` findings present (or
changes applied), `1` error or a failed change.

## Checks

| Check | Command | Looks at |
|---|---|---|
| cost-fitness / model-catalog | `cost` | job model (or the profile default) vs the task's recommended tier |
| banned-model | `banned` | `bannedAgentModels` in the catalog |
| frequency-waste | `frequency` | ≥ 12 runs/day from the cron or interval schedule |
| zombie-agents | `zombies` | enabled jobs with no `next_run_at` |
| duplicates | `duplicates` | Jaccard overlap > 60% after removing fleet-wide boilerplate |
| run-errors | `errors` | `last_status: error`, failure streaks, delivery errors |
| instruction-hygiene | `hygiene` | missing script (absolute or under `$HERMES_HOME/scripts`), workdir or referenced absolute paths; Zo API references |
| schedule-collision | `collisions` | ≥ 4 jobs on one schedule |
| delivery-method | `delivery` | maintenance jobs delivering to a chat platform |
| instruction-length | `length` | long prompts on budget or standard models |
| output-delta | `delta` | last 3 saved outputs identical (`cron/output/<id>/`) |

Models never in the catalog are grouped under `model-catalog` and never ranked: a guessed tier
must not drive a downgrade.

## Safe fixes (`apply`)

- **Zombie job:** `hermes cron pause <id>`.
- **Banned model on a job that pins its own model:** `hermes cron edit <id> --model <bannedModelFallback>`.
- **Model 2+ tiers above the task:** `hermes cron edit <id> --model <byTier[recommended]>`.
- **Internal job delivering to chat:** `hermes cron edit <id> --deliver local`.

A model change happens only when the catalog names a target. Jobs that use the profile default
model are never edited per job. The doctor never touches its own jobs or the healer's. It
recognizes them by `agent-doctor` or `agent-model-healer` in the name, prompt, script or skills.
It also skips any id in `safetyExcludeIds`. Duplicates, hygiene, frequency, collisions,
length, run errors and output delta are for manual review only.

## Catalog

Copy `assets/model-tiers.example.json` to `$ZOUROBOROS_CONFIG_DIR/agent-doctor/model-tiers.json`
(or point `AGENT_DOCTOR_TIERS` at a file) and fill in your model ids and downgrade targets. A
target is a model id or `{"model": "...", "provider": "..."}`. Until then, the doctor uses the
example, so every job is reported under `model-catalog` and no model changes are planned.

## Scheduling

Run it as a Hermes cron job that is itself report-only. For example, a weekly `no_agent` job
whose script runs `bun …/doctor.ts summary`. Applying fixes stays an operator decision: review
`apply --dry-run` first.

## preflight-paths.ts

Verifies that every given path exists. It exits 0 if all are present, or 1 with a
`BROKEN PATH: <path>` line for each missing file. Use it at the top of a job script.

```bash
bun "${HERMES_SKILL_DIR}/scripts/preflight-paths.ts" /path/to/file1 /path/to/file2
```
