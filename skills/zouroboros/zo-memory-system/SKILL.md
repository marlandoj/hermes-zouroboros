---
name: zo-memory-system
description: "Zouroboros persistent memory for Hermes: store and recall work facts and decisions, and record what happened (episodes with outcomes) in the hermes-zouroboros profile's SQLite store. Use to remember a decision across sessions, look up prior context before saying 'I don't know', or log a task outcome."
version: 4.0.0-hermes.1
author: Zouroboros
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Zouroboros, Memory, Knowledge, Context]
    related_skills: [zo-swarm-orchestrator, autoloop]
prerequisites:
  commands: [bun]
---

# Zouroboros memory

Persistent, local memory for the hermes-zouroboros distribution. Facts (entity, key, value) and
episodes (what happened, with an outcome) live in **one** SQLite database owned by the
distribution profile: `$HERMES_ZOUROBOROS_HOME/memory.db`. It is the same database the
profile's `zouroboros` MCP server reads and writes. Nothing here calls a remote embedding or
model API.

## When to use

- Before answering "I don't know" about earlier work: search memory first.
- After a decision, convention or preference is settled: store it.
- After a task finishes (or fails): record an episode so later sessions can see what happened.

Do **not** store credentials, tokens, personal data or anything the operator has not agreed to
retain. The store applies a secret/PII defense scan and redacts matches by default, but treat
that as a safety net, not permission.

## Preferred: the `zouroboros` MCP tools

The profile created by `bun integration/cli.ts init` registers an MCP server named `zouroboros`:

| Tool | Use |
| --- | --- |
| `memory_store` | `{entity, key?, value}` store one fact |
| `memory_search` | `{query, limit?}` keyword search (SQLite FTS) |
| `workshop_status` | memory statistics and execution mode |

## Command line (facts, episodes, stats)

`zmem.ts` uses the distribution's `zouroboros-memory` package against the same profile database.
It always resolves the database from the profile (`HERMES_ZOUROBOROS_HOME`, default
`~/.local/share/hermes-zouroboros`) and ignores any `ZO_MEMORY_DB` / `ZOUROBOROS_MEMORY_DB`
inherited from the environment, so it cannot write into another installation's memory.

```bash
Z="${HERMES_SKILL_DIR}/scripts/zmem.ts"
bun "$Z" store --entity project.api --key auth --value "Use short-lived tokens with refresh" --category decision
bun "$Z" search "auth tokens" --limit 5
bun "$Z" episode --summary "Migrated the API to v2" --outcome success --entities project.api,migration
bun "$Z" episodes --since 7d --outcome failure
bun "$Z" stats
bun "$Z" where        # prints the database path in use
```

All commands print JSON on stdout. Options:

- `--category`: `preference | fact | decision | convention | reference | project | other` (default `fact`)
- `--decay`: `permanent | long | medium | short` (default `medium`)
- `--outcome`: `success | failure | resolved | ongoing`
- `--since` / `--until`: ISO date or a window such as `30m`, `24h`, `7d`, `4w`

## Conventions

- Entities are dotted, lower-case nouns: `project.<name>`, `service.<name>`, `user.preferences`.
- Keep one fact per entity+key and make the value self-contained (what, why, when).
- Use `--decay permanent` only for durable conventions; task context should be `short` or `medium`.
- Swarm and autoloop runs do not write to memory automatically. Record outcomes explicitly with an
  episode when they matter.

## Requirements and limits

- Requires an initialized profile (`bun integration/cli.ts init --workspace PATH`) and a built
  checkout (`bash scripts/setup.sh`).
- Search is keyword (FTS5). The source system's hosted-embedding hybrid search, HyDE expansion,
  memory gate hook, conversation auto-capture, vault/wikilink tooling and RAG freshness daemons are
  not part of this distribution.
