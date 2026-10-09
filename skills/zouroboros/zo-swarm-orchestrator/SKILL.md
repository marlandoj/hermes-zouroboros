---
name: zo-swarm-orchestrator
description: "Plan and run a Zouroboros swarm from Hermes: score whether a task warrants multi-agent orchestration (decision gate), write a bounded task DAG, validate it, save it for operator review, and execute it through one-shot Hermes workers only after explicit opt-in. Use for multi-step work that splits into independent or dependent subtasks."
version: 5.0.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Swarm, Orchestration, Multi-Agent, Planning]
    related_skills: [zo-swarm-executors, tier-resolver, zo-memory-system]
prerequisites:
  commands: [bun]
---

# Zouroboros swarm orchestration

Runs a dependency-ordered set of tasks through the distribution's `zouroboros-swarm`
orchestrator. Each task is executed by a fresh, one-shot Hermes Agent (`hermes-vps` executor)
in the configured workspace. Planning is free and local; execution is opt-in and bounded.

## Workflow

1. **Score the plan.** Score the scoped plan, not just the request:

   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/swarm.ts" gate "<scoped plan in one paragraph>"
   ```

   `decision` is `DIRECT` (do it yourself), `SUGGEST` (offer a swarm, default to direct),
   `SWARM` or `FORCE_SWARM` (the user explicitly asked). A SWARM result still needs operator
   approval before anything runs.

2. **Write the task DAG** as a JSON array. Each task is
   `{ "id", "task", "priority"?, "dependsOn"?, "timeoutSeconds"? }`:
   - `id`: 1-64 characters of `[A-Za-z0-9_-]`, unique;
   - `task`: a self-contained instruction (the worker sees nothing else);
   - `priority`: `critical | high | medium | low`;
   - `dependsOn`: ids that must finish first (no cycles);
   - `timeoutSeconds`: 10-600 (default 300).

   At most 20 tasks. No other fields are accepted: a task cannot pick its executor, model or host
   configuration.

3. **Validate and prepare** a reviewable campaign file in the profile:

   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/swarm.ts" validate tasks.json
   bun "${HERMES_SKILL_DIR}/scripts/swarm.ts" prepare tasks.json   # prints {"taskFile": ...}
   ```

   The `zouroboros` MCP server's `swarm_prepare` tool does the same from inside a session.

4. **Show the campaign to the operator.** Execution needs their go-ahead.

5. **Run (operator opt-in only):**

   ```bash
   HERMES_ZOUROBOROS_ALLOW_SWARM=1 bun "${HERMES_SKILL_DIR}/scripts/swarm.ts" run <taskFile>
   ```

   This delegates to `bun integration/cli.ts swarm`, which runs at most two tasks concurrently,
   does not retry, and prints a JSON summary (`ok`, per-task `success`, `output`, `error`).
   Workers run with `HERMES_ZOUROBOROS_ALLOW_SWARM=0`, so a worker cannot start another swarm.

6. **Record the outcome** with the `zo-memory-system` skill (`zmem.ts episode ...`) if it should be
   remembered.

## Writing good tasks

- Put every input a worker needs in its `task` text: files, acceptance criteria, output format.
- Split by independent write scopes. Two tasks must not edit the same file concurrently.
- Make dependent tasks summarize or verify. Do not make them redo work.
- Keep tasks under the timeout. Split long work instead of raising limits.

## Limits of this distribution

- Only the `hermes-vps` executor is configured (see `zo-swarm-executors`). The source system's
  multi-executor routing (Claude Code, Codex, Gemini, ...), persona registry, campaign examples,
  RAG enrichment and seed/gap audit gates are not enabled here.
- Post-flight result evaluation stays on. This is a bounded runner, not a Software Factory.
