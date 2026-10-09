---
name: zouroboros
description: "Entry point for Zouroboros on Hermes: what the self-improving stack is, which Zouroboros skill to use for memory, swarm orchestration, routing, optimization loops, evaluation and governance, a read-only health check of the hermes-zouroboros profile, and exact-phrase operator shortcuts (/status, /doctor, /governance verify, /memory search, /swarm status). Use when someone asks about Zouroboros itself or types one of those shortcuts."
version: 2.0.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Index, Health, Shortcuts]
    related_skills: [zo-memory-system, zo-swarm-orchestrator, zo-swarm-executors, tier-resolver, autoloop, zouroboros-governance, three-stage-eval, unstuck-lateral]
prerequisites:
  commands: [bun]
---

# Zouroboros

Zouroboros is a self-improving agent stack: a closed loop of memory, evaluation, prescription and
evolution around frozen models, governed by a constitution. In this distribution it runs as Hermes
skills over the hermes-zouroboros packages, an isolated Hermes profile and the `zouroboros` MCP
server.

## Setup and health

The distribution is set up from its checkout (this replaces the old one-command installer):

```bash
bash scripts/setup.sh                                   # install + build + typecheck
bun integration/cli.ts init --workspace /abs/workspace  # isolated profile, registry, skills registration
```

Then check it from any session:

```bash
bun "${HERMES_SKILL_DIR}/scripts/zouroboros.ts" doctor   # JSON; exit 0 healthy, 1 not
bun "${HERMES_SKILL_DIR}/scripts/zouroboros.ts" skills   # every shipped skill by category
```

`doctor` is read-only. It reports the profile prerequisites (`integration/cli.ts doctor`), the
governing documents (`zouroboros-governance` `verify-docs`) and the skill tree. It has no
`--fix` mode: repair is an explicit operator action.

## Read-only operator shortcuts

When a message **exactly** matches one of these phrases or a listed paraphrase, run it and return
the output:

```bash
bun "${HERMES_SKILL_DIR}/scripts/zouroboros.ts" shortcut "<the message>"
```

| Shortcut | Runs |
| --- | --- |
| `/status` | the `doctor` report above (the self-heal scorecard is not ported yet) |
| `/doctor` | the `doctor` report above |
| `/governance verify` | `zouroboros-governance` `constitution-gate.ts verify-docs` |
| `/memory search "query"` | `zo-memory-system` `zmem.ts search` against the profile database |
| `/swarm status` | `zo-swarm-executors` `executors.ts doctor` |

`shortcuts` lists every accepted paraphrase. Resolution uses the exact-match catalog in
`zouroboros-core` (`resolveOperatorShortcut`). There is no fuzzy matching. Anything else,
including added flags, returns `no-op` with help (exit 2) and runs nothing. Do not reinterpret an
unsupported phrase. These shortcuts never authorize fixes, writes, trades, publication,
deployment, merges or governance changes.

## Which skill

| Need | Skill |
| --- | --- |
| Store or recall facts and episodes | `zo-memory-system` (or the `zouroboros` MCP `memory_*` tools) |
| Decide whether to use a swarm, write and run a task DAG | `zo-swarm-orchestrator` |
| Inspect or health-check executors | `zo-swarm-executors` |
| Pick a model tier for a task | `tier-resolver` |
| Optimize one metric by repeated experiments | `autoloop` (template: `autoloop/templates/program.md`) |
| Evaluate an artifact against a spec | `three-stage-eval` |
| Stuck in a loop | `unstuck-lateral` |
| Check a self-modifying change against the constitution, audit verdicts | `zouroboros-governance` |
| Monitor the stack | `zouroboros-observatory` |

## Self-modification rule

Any change to scheduling, routing, memory, prompts, gates or governance runs the
`zouroboros-governance` constitution gate first and stops on `BLOCK`. Certified promotion is not
available in this distribution: changes ship through ordinary review and CI.

## What is not here

- The self-heal loop (introspect, prescribe, evolve) and the spec-first interview are separate
  entries and are tracked in `docs/SKILLS-PARITY.md`.
- The old monolithic installer, the standalone memory and swarm script copies, and their MCP
  servers are replaced by the packages, `integration/` and the `zouroboros` MCP server.
- Hosted embeddings and local model downloads are not set up by this skill.
