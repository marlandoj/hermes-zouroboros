---
name: graphrag-relational
description: "Build a GraphRAG index over relational and execution data (a swarm/factory database, factory-log JSONL, execution-state files and ticket exports) in an embedded FalkorDB graph, then answer typed relationship questions (execution -> ticket -> gate decision -> cost) with read-only Cypher. Use for multi-hop joins and 'does this edge exist' questions; use vector RAG for prose similarity."
version: 0.2.0
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [rag, graphrag, graph, cypher, falkordb, Zouroboros]
    related_skills: [rag-telemetry, operator-digest]
  graph_store: falkordblite@0.3.0
  decision: adr/0001-graph-store.md
prerequisites:
  commands: [bun]
---

# GraphRAG Relational

Use this skill when a task needs relational structure and rows turned into a property graph for
retrieval, traversal or agent context assembly. Graph traversal wins on typed relationships,
execution/ticket/gate/cost state, multi-hop joins and proof that an edge is absent. Vector RAG
wins on conceptual similarity, prose and code snippets. When a question has both a seed entity
and an open concept, use vector search to find candidates, then the graph to traverse them.

## Install (once per checkout)

```bash
cd <this skill directory>
bun install            # falkordblite 0.3.0 + the pinned Linux module; lifecycle scripts stay blocked
```

The dependency is confined to this skill directory; the rest of the distribution never loads it.
Extraction (`scripts/extract.ts`) needs nothing beyond Bun.

## Third-party runtime dependency: Redis built from source on first use

The graph store is **FalkorDB Lite 0.3.0** (MIT) with the module from
`@falkordblite/linux-x64@8.2.3-falkordb.4.16.3`. See [ADR-0001](adr/0001-graph-store.md).

- The **first** index or query downloads the Redis **8.2.3** source archive from GitHub,
  verifies its pinned SHA-256 (`REDIS_SOURCE_SHA256` in `scripts/runtime.ts`), compiles
  `redis-server` with `MALLOC=libc` and caches it with a receipt (versions, digests, build time;
  no credentials). Later calls re-verify the receipt and binary digest before reuse.
- Nothing is downloaded or built at install time. The build needs network access, `make` and a
  C toolchain on that first use, and takes a few minutes.
- The FalkorDB module's SHA-256 is pinned too. Every checksum check fails closed.
- Each operation starts a child Redis on a private Unix socket (no TCP listener, no service, no
  Docker) and closes it afterwards.
- **CI never builds Redis.** The build is refused when `CI` is set or `GRAPHRAG_NO_BUILD=1`.
- Offline or audited hosts can supply a pre-verified binary instead:
  `FALKORDBLITE_REDIS_SERVER=/absolute/path/redis-server`.

Run the build explicitly instead of on first use with `bun scripts/runtime.ts prepare` (prints the
verified binary path).

## Locations

Nothing is written inside the skill tree.

| What | Location |
|---|---|
| Source inputs | `--factory-dir <dir>` or `GRAPHRAG_FACTORY_DIR`: `<dir>/swarm.db`, `<dir>/state/factory-log.jsonl`, `<dir>/state/exec-*.json`. No default: the skill refuses to guess. |
| Ticket exports | `--tickets-json <path>` (repeatable): JSON array, `{ "issues": [...] }` or JSONL from any tracker |
| Graph data + index state | `GRAPHRAG_DB_DIR`, else `$ZOUROBOROS_STATE_DIR/graphrag-relational/` (`falkordblite/`, `graphrag-state.json`) |
| Redis build cache | `GRAPHRAG_CACHE_DIR`, else `$ZOUROBOROS_CACHE_DIR/falkordblite/` |
| Telemetry | the rag-telemetry sink (`RAG_TELEMETRY_PATH`, else `$ZOUROBOROS_LOG_DIR/rag-telemetry.jsonl`) |

The state, cache and log roots fall back to the hermes-zouroboros profile data directory.

## Workflow

1. **Extract** the property graph (read-only on the sources):
   `bun scripts/extract.ts --factory-dir <dir> [--tickets-json <export>] --pretty`.
   SQLite sources are introspected directly; DuckDB sources need the `duckdb` CLI.
2. **Index** it: `bun scripts/index.ts --factory-dir <dir>` (or `--graph <extracted.json>`).
   Node and edge IDs are deterministic; reruns write only changed entities, and source
   truncation or rotation is reported. `--reset` removes only the selected graph data and state.
3. **Query**: `bun scripts/query.ts --question "What did the gate say about tasks related to module X?"`.
   Templates: related tasks, gate by module, co-failed executions, cost breakdown. Results are
   ranked `{content, score, metadata}` blobs in the same shape as vector RAG hits.
   `--cypher` accepts one read-only statement; write and schema clauses are rejected.
4. Keep source reads separate from graph writes so extraction can be replayed from scratch.

Graph schema: `Execution`, `Ticket`, `CostEntry`, `GateDecision`, `FactoryRecord` nodes;
`IMPLEMENTS`, `INCURRED_COST`, `GATED_BY`, `HAS_RECORD` edges.

Query wording matters: a question containing both "gate" and "co-failed" selects the gate
template. Use unambiguous wording or `--cypher` when the template matters.

## Tests

- `bun test scripts`: offline suite (extraction, paths, build refusal, read-only Cypher, failure
  telemetry). Graph-backed tests are skipped and marked `[live: GRAPHRAG_LIVE_TESTS=1, ...]`.
- `bun run test:live`: prepares the runtime (first-use build if needed), then runs everything.
