# zouroboros-rag

Corpus-qualification library for the Zouroboros RAG stack. This package does
**not** talk to Qdrant directly (no vector-DB dependencies) — it prepares,
chunks, and qualifies the corpora that Qdrant collections are built from, and
provides the shadow-retrieval path used to A/B a candidate embedding model
against the incumbent.

> Distribution note: the script-heavy RAG runtime (`qdrant-rag-mcp.ts`,
> `rag-pipeline.ts`, `daily-rag-maintenance.ts`, …) lives in the upstream
> monorepo, not in this distribution. This package ships the library
> half: chunking, corpus assembly, qualification policy, and retrieval
> through injected dependencies.

## What's here (`src/`)

| File | Purpose |
|---|---|
| `index.ts` | RAG area config (`swarm`/`vault`/`autoloop`/`eval`/`persona`); re-exports |
| `ingestion.ts` | Text chunking (1500 chars / 200 overlap), deterministic `sha256:` chunk IDs |
| `candidate-corpus-builder.ts` | Candidate corpus assembly |
| `candidate-collection.ts` | Corpus manifest: candidate embedding path = local `sentence-transformers/all-MiniLM-L6-v2` (384-dim, pinned revision) vs incumbent OpenAI `text-embedding-3-small` (1536-dim); minimums (500 docs / 2,000 chunks / 200 held-out queries); strata: code, documentation, governance, workflow_and_swarm, rag_and_memory_public_docs |
| `candidate-qualification.ts` | Qualification batch format (sha-pinned batches for embedding) |
| `candidate-policy.ts` | Fail-closed policy: the public candidate corpus may come from exactly one approved https repo (`ZOUROBOROS_CANDIDATE_REPOSITORY`; unset = no corpus) |
| `candidate-retrieval.ts` | Retrieval through injected deps (embed via HTTP + Qdrant `/points/search` via `fetch`); shadow-only — results are telemetry, never consumed |

## Consumer

The only in-repo consumer is `packages/swarm` (`src/rag/shadow-comparator.ts`),
which runs the 384-dim MiniLM candidate path alongside the incumbent on swarm
tasks when `MODAL_RAG_SHADOW_ENABLED=1`. Candidate results are never used for
enrichment — see the shadow experiment's decision status in the swarm docs.

## The rest of the RAG picture

- **Qdrant access**: raw REST in `packages/swarm/src/rag/enrichment.ts` and
  `integration/qdrant-corpus.ts` (default `http://127.0.0.1:6333`); no Qdrant
  client library is vendored.
- **Collections are host-provisioned**: `zouroboros-code` and `code-docs`
  (plus `zouroboros-research`, `commerce-a-knowledge` upstream) are
  expected to pre-exist on the Qdrant host. This distribution ships no indexer
  and no Qdrant server — see `deploy/` (SQLite memory gate only). Missing
  collections fail soft per query and are reported in RAG telemetry.
  (`shared-memory-facts` was retired 2026-10-13 — redundant with SQLite
  hybrid search.)
- **Relational/graph questions**: `skills/zouroboros/graphrag-relational/`
  (embedded FalkorDB, read-only Cypher over execution/ticket/gate/cost data).
  Rule of thumb: vector RAG for prose similarity; the graph for multi-hop
  joins and "does this edge exist" questions.
