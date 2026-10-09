---
name: instinct-harvester
description: "Behavioral pattern store: confidence-weighted trigger→action instincts (when doing X in context Y, prefer Z) kept in the profile's state directory, a layer above fact memory because behavioral patterns compound where facts decay. Fed by the extract-patterns gate. Use when adding, reviewing, reinforcing, superseding or querying instincts, when briefing a session with learned preferences, or when running the daily lifecycle."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, memory, learning]
    related_skills: [extract-patterns, zo-memory-system]
prerequisites:
  commands: [bun]
---

# instinct-harvester

Stores confidence-weighted trigger→action patterns in a YAML store. Adapted from the ECC
`skills/continuous-learning-v2/` design (MIT).

## Where things live

| File | Default |
|---|---|
| store | `$ZOUROBOROS_STATE_DIR/instincts/instincts.yaml` |
| tombstones (sanctioned deletes) | next to the store, `tombstones.jsonl` |
| use journal / evidence | `instincts/use-journal.jsonl`, `instincts/use-evidence.md` |
| lifecycle reports | `instincts/lifecycle-reports/<date>.md` |

`ZOUROBOROS_STATE_DIR` falls back to the profile's `state/` directory. `INSTINCT_DIR` moves the
whole directory; `INSTINCT_STORE_PATH`, `INSTINCT_TOMBSTONE_PATH` and `INSTINCT_USE_JOURNAL`
override single files. Nothing is written inside the skill tree.

## Architecture

- **Observer:** the session agent itself. When the extract-patterns gate finds a pattern that
  passes all four criteria (project-specific, repeatedly applicable, non-obvious,
  trigger→action), the agent records it with `observer.ts add`. The scripts make no model calls.
- **Store:** id, trigger, action, domain, confidence, source (`session-observation` |
  `repo-curated` | `daily-synthesis`), reinforced_count and last_seen. A corrupt store is
  snapshotted to `*.corrupt-<ts>` before any fail-safe empty read, so writers cannot clobber it.
- **Dedup and conflict** (`merge.ts`, pure): the key is the normalized trigger plus domain. A
  same-key candidate reinforces the existing entry, and the higher-confidence fields win.
- **Admission** (`lifecycle.ts`, the single eviction policy): under the cap, a candidate merges
  normally. At the cap, a `critical: true` candidate evicts the weakest non-critical row; any
  other candidate is refused with exit 1 rather than silently dropped. `prune.ts` is kept only
  for ranking inspection.
- **Lifecycle:** liveness from `last_seen`, relative protection (critical, `reinforced_count ≥ 8`,
  or top 10% by blended score), supersession (the only path that lowers confidence), a blended
  `confidence · liveness` prune, an optional per-domain cap and a readiness gate. `--apply` is
  refused unless the lifecycle sees real signal. A corpus where everything is protected is
  reported as a red flag.
- **Measure link** (`use-flush.ts` + `store-surgery.ts`): each briefing that injects patterns may
  append a line to the use journal. The flush drains it into `times_injected`,
  `distinct_prompts` and `last_seen`. It never increments `reinforced_count`: injection is
  reach, not correctness. The store is edited surgically, row by row.

## Session briefing

At the start of a task, brief yourself with the top instincts for the prompt's domains:

```bash
bun "${HERMES_SKILL_DIR}/scripts/observer.ts" brief --top 5 --context "<the user's request>"
```

Treat the briefing as advisory preferences. It never overrides the operator, governance or
safety rules.

## CLI

```
bun scripts/observer.ts add --trigger T --action A --domain D [--confidence 0.7] [--critical true] [--source session-observation]
bun scripts/observer.ts brief [--top 5] [--context "prompt text"]
bun scripts/observer.ts list [--domain D]
bun scripts/observer.ts stats
bun scripts/observer.ts reinforce --id inst_NNN --evidence "<episode id or quoted outcome>"   # --evidence required
bun scripts/observer.ts supersede --id inst_OLD --by inst_NEW
bun scripts/observer.ts supersede-candidates [--domain D] [--limit 20]                      # proposal-only
bun scripts/lifecycle.ts [--apply] [--report PATH] [--store PATH] [--cap 200] [--per-domain-cap N] [--today YYYY-MM-DD] [--no-use-flush]
bun scripts/use-flush.ts [--journal PATH] [--store PATH] [--evidence-out PATH] [--dry-run]
```

Run `scripts/…` paths as `"${HERMES_SKILL_DIR}/scripts/…"`. Other settings: `INSTINCT_CAP`
(default 200), `INSTINCT_LIFECYCLE_ENFORCE=1` (same as `--apply`), `INSTINCT_USE_JOURNAL=off`
(disable journalling). Schedule the daily lifecycle with Hermes cron if you want it unattended.

## Tests

All tests use temporary stores and never touch the live one:

```bash
bun scripts/selftest.ts              # validation, merge, pruning, YAML round-trip, briefing
bun scripts/lifecycle-selftest.ts    # liveness, protection, admission, readiness, report
bun scripts/supersede-selftest.ts    # supersession producer
bun scripts/use-flush-selftest.ts    # measure link
bun scripts/remove-verify-selftest.ts
```
