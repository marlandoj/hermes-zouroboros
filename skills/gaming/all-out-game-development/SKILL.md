---
name: all-out-game-development
description: "Design, implement, present, test, and prepare games for release on the All Out platform using current CSL-era documentation, role-specific workflows, and a source-attributed Qdrant corpus. Use for All Out game concepts, GDDs, mechanics, CSL code, multiplayer state, mobile UI, assets, technical art, playtesting, monetization design, publishing readiness, updates, and live operations."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [gaming, game-development, All Out, RAG, Zouroboros]
    related_skills: [gamedev-engine-corpus, gauntlet-loop]
prerequisites:
  commands: [bun]
---

# All Out Game Development

Use current evidence before relying on remembered platform behavior. Treat legacy C# material as migration context only unless the user explicitly assigns a legacy project.

## Start Every Task

1. Read the target project's `AGENTS.md` and current design or engineering contracts.
2. Select the role playbook:
   - Game Director: `references/game-director.md`
   - CSL Engineer: `references/csl-engineer.md`
   - Technical Art & UX: `references/technical-art-ux.md`
   - QA & Release: `references/qa-release.md`
3. Search the `all-out-gamedev` collection with a role-specific, task-specific query (a Qdrant RAG MCP server if the profile has one, otherwise `scripts/query.ts`).
4. Open the cited official source when a claim controls implementation, publication, monetization, content compliance, or legal acceptance.
5. Label each consequential statement as documented, observed, inferred, or unresolved.

For QA or release work, run `bun "${HERMES_SKILL_DIR}/scripts/check-corpus.ts"` before setting criteria. A nonzero result blocks certification until the corpus is repaired or current official sources are reviewed directly and the gap is recorded.

## Retrieval Protocol

Apply this authority order:

1. Target-project generated API references and compiler/editor output for the exact installed engine build.
2. Current official All Out documentation and terms for platform behavior, policy, publishing, monetization, and legal requirements.
3. Internal role playbooks for workflow and handoff discipline.
4. Upstream `agency-agents` references for general craft methods only.
5. Project baselines and memory for historical context only.

Lower-ranked sources may not override higher-ranked sources. `agency-agents`, playbooks, project files, and memory may never establish an All Out API, engine limit, policy, or commercial term.

When a Qdrant RAG MCP server is configured in the profile, call its search tool with:

- `collection: all-out-gamedev`
- `hybrid: true`
- `reranker: flashrank`
- `limit: 6` for focused work or `10` for release audits

Include the role and concrete system in the query. Prefer questions such as:

- `Game Director onboarding objective first 30 seconds touch multiplayer late join`
- `CSL Engineer server authority is_local_or_server save schema purchase callback idempotency`
- `Technical Art UX UIDoc safe areas aspect ratio asset loading Spine audio performance`
- `QA Release publishing checklist protocol update rollback servers error monitoring rights`

If no Qdrant MCP server is configured, run:

```bash
bun "${HERMES_SKILL_DIR}/scripts/query.ts" --role qa "publishing rollback protocol updates"
```

Fail closed on unknown APIs or policies. Ask the user to obtain written confirmation from All Out support when official sources remain ambiguous.

## MCP Capability Contract

- Qdrant retrieval (MCP server or `scripts/query.ts`): primary platform and specialty retrieval for every role.
- A code-graph MCP server, when the profile has one: CSL Engineer and QA only, for indexed repository structure, callers, impact, and verification paths.
- Zouroboros memory (`zo-memory-system` skill or the `zouroboros` MCP server): all roles, for project decisions and continuity; never treat memory as current platform authority.
- Web browsing/search: confirm current official documentation and unresolved platform changes.

Do not use academic literature search for ordinary platform implementation. It is optional only when the user explicitly asks for academic game-design evidence.

## Workflow

1. Convert intent into a bounded contract with acceptance criteria.
2. Retrieve current evidence and record cited source URLs.
3. Produce the role deliverable defined in the selected playbook.
4. Hand off through explicit state, asset, evidence, and ownership contracts.
5. Compile or validate after each coherent change.
6. Require independent QA evidence before recommending release.
7. Stop for explicit user authorization before publishing, activating monetization, changing live servers, rematchmaking players, or accepting legal/commercial terms.

## Configuration

The scripts read the profile environment: `QDRANT_URL` (default `http://127.0.0.1:6333`), optional
`QDRANT_API_KEY`, and `OPENAI_API_KEY` for embeddings (`OPENAI_BASE_URL` and `CORPUS_EMBEDDING_MODEL`
are optional; the collection expects 1536-dimension `text-embedding-3-small` vectors). Embedding and
sparse-vector helpers come from this checkout's `integration/qdrant-corpus.ts`, so the skill needs a
hermes-zouroboros checkout. No credential is read from a file.

## Corpus Operations

Refresh the corpus when All Out announces a protocol update, before a release audit if the last refresh is stale, or after changing the role playbooks:

```bash
bun "${HERMES_SKILL_DIR}/scripts/sync-corpus.ts"
bun "${HERMES_SKILL_DIR}/scripts/check-corpus.ts"
```

Preview source and chunk counts without embeddings or Qdrant mutation:

```bash
bun "${HERMES_SKILL_DIR}/scripts/sync-corpus.ts" --dry-run
```

The sync fetches all Markdown pages listed by `https://docs.allout.game/llms.txt`, converts current All Out terms with Pandoc, fetches selected upstream `agency-agents` Game Development Division references, and adds the four role playbooks. Dated project baselines are deliberately excluded so they cannot outrank current official material. The sync snapshots an existing collection before replacement.

## Completion Evidence

Record the current documentation retrieval date, corpus audit output, compile or editor evidence, multi-client evidence, mobile/device evidence or gap, performance evidence or gap, rights status, build/version identifier, rollback path, and approval checkpoint.
