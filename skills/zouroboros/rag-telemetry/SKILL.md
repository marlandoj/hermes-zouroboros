---
name: rag-telemetry
description: "Shared, privacy-bounded telemetry contract (schema v2) for vector RAG and GraphRAG query and indexing operations. Use when instrumenting a retrieval or indexing path so every RAG workflow appends comparable JSONL events to one sink."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [rag, retrieval, telemetry, observability, Zouroboros]
    related_skills: [all-out-game-development, gamedev-engine-corpus]
prerequisites:
  commands: [bun]
---

# RAG Telemetry

`scripts/telemetry.ts` is a small library, not a CLI. Import it from a retrieval or indexing
script and call `writeRagTelemetry()` once per operation:

```ts
import { writeRagTelemetry } from "<path to this skill>/scripts/telemetry.ts";

writeRagTelemetry({
  method: "vector", operation: "query", source: "my-corpus",
  ok: true, durationMs: 42, resultCount: 5, query,
  details: { collections: ["my-collection"] },
});
```

Each call appends one versioned event (`schemaVersion: 2`) with `0600` permissions. Query and
error text are whitespace-collapsed and truncated (160 and 240 characters); `queryLength` keeps the
original length. Never put Cypher, retrieved content, credentials or full prompts in `details`.

## Sink

| Order | Location |
|---|---|
| 1 | explicit `path` argument |
| 2 | `RAG_TELEMETRY_PATH` |
| 3 | `$ZOUROBOROS_LOG_DIR/rag-telemetry.jsonl` |
| 4 | `logs/rag-telemetry.jsonl` in the hermes-zouroboros profile data directory (`HERMES_ZOUROBOROS_HOME`, else `$XDG_DATA_HOME/hermes-zouroboros`, else `~/.local/share/hermes-zouroboros`) |

`defaultRagTelemetryPath()` returns the resolved default. The library never writes inside the
skill tree or to a shared tmpfs.

## Consumers

No shipped skill calls this library yet. The source workspace's GraphRAG skill was its main
producer and is not part of this distribution. Natural adopters are the Qdrant corpus paths
(`integration/qdrant-corpus.ts` and the gaming corpus skills that build on it), which could wrap
their query and ingest calls with `writeRagTelemetry()`.

## Test

```bash
bun test "${HERMES_SKILL_DIR}/scripts/telemetry.test.ts"
```
