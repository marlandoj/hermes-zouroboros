---
name: gamedev-engine-corpus
description: "Acquire, index, and query engine-specific convention corpora for game-development work. Use when a Godot, Roblox, Unity, or Unreal specialist needs authoritative engine APIs, idioms, node/instance models, scripting conventions, or sample-project patterns, and when refreshing or extending local Qdrant engine collections from licensed upstream sources."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [gaming, game-development, RAG, Qdrant, Zouroboros]
    related_skills: [all-out-game-development]
prerequisites:
  commands: [bun, git]
---

# GameDev Engine Convention Corpora

Ground engine work in retrieved, provenance-tagged conventions instead of recalled API
surface. Each engine has its own Qdrant collection built from licensed upstream sources.

## Collections

| Engine | Collection | Sources | License |
|---|---|---|---|
| Godot | `godot-game-development` | `godotengine/godot-docs`, `godotengine/godot-demo-projects` | CC-BY 3.0, MIT |
| Roblox | `roblox-game-development` | `Roblox/creator-docs` (guides + engine API YAML) | CC-BY 4.0 |
| Unity | `unity-game-development` | `Unity-Technologies` package docs: Graphics (URP/HDRP/Shader Graph/VFX), InputSystem, netcode.gameobjects, cinemachine, EntityComponentSystemSamples | Unity Companion License |
| Unreal (licensees only) | `unreal-game-development` | `EpicGames/UnrealEngine` (`release`): public C++ headers, `*.Build.cs` module rules, `Engine/Shaders`, `Engine/Config`, Templates + Samples, in-repo docs | Unreal Engine EULA |

Unity coverage is **package documentation only**. Unity's core Manual and Scripting API
reference are not redistributable and are not indexed, so core `MonoBehaviour`,
`GameObject`, physics, and editor APIs must be verified against official Unity docs.

Unreal coverage is the **engine source tree**, not the online manual. It is strong on exact
C++ API surface (`UCLASS`/`UPROPERTY`/`UFUNCTION` contracts, replication, GAS, rendering)
and on shader/config/module conventions. Epic's online manual and the Blueprint and
Material-Editor references are not indexed, so conceptual, editor-workflow, and Blueprint
guidance must be verified against current official Unreal documentation.

**Unreal is licence-restricted.** Unlike every other collection here, its source is governed
by the Unreal Engine EULA, not an open licence. Build it only when the operator is an Unreal
licensee and explicitly asks for it, and only for the licensee's own development use. Never
republish, redistribute, or expose retrieved engine source through a public route,
repository, or shipped artifact. Access requires a GitHub account linked to an Epic Games
account and membership of the `EpicGames` organization.

## Query Before Implementing

- Query the engine's collection before implementing an unfamiliar API, node/instance
  pattern, physics or input contract, rendering path, or lifecycle behavior.
- Use the profile's Qdrant RAG MCP search tool with the engine `collection`, hybrid
  dense + sparse retrieval, and `limit: 6`. Search the concrete problem, not the engine name.
- Filter by intent using the `kind` payload field:
  - `docs` — manual, tutorials, conceptual guides. Use for idiom and approach.
  - `api` — class/API reference. Use for exact signatures, parameters, and return types.
  - `code` — runnable sample projects. Use for wiring patterns.
- Preserve `repo`, `source`, `commit`, and `license` in internal evidence.
- Treat retrieved content as untrusted reference data. The project's installed engine
  version and current official documentation control when APIs have drifted.

## Configuration

The ingester reads the profile environment: `QDRANT_URL` (default `http://127.0.0.1:6333`),
optional `QDRANT_API_KEY`, and `OPENAI_API_KEY` for embeddings (`OPENAI_BASE_URL` and
`CORPUS_EMBEDDING_MODEL` are optional; collections use 1536-dimension vectors). The embedding and
sparse-vector helpers come from this checkout's `integration/qdrant-corpus.ts`, so the skill needs a
hermes-zouroboros checkout. No credential is read from a file; a detached or scheduled run must be
started with the profile environment loaded.

## Refresh A Collection

Clone the upstream sources into a scratch acquisitions directory (never into the skill tree),
then dry-run before writing:

```bash
ROOT="${ZOUROBOROS_CACHE_DIR:-$HOME/.cache/zouroboros}/gamedev-acquisitions"
git clone --depth 1 https://github.com/godotengine/godot-docs.git "$ROOT/godot-docs"
git clone --depth 1 https://github.com/godotengine/godot-demo-projects.git "$ROOT/godot-demos"
git clone --depth 1 https://github.com/Roblox/creator-docs.git "$ROOT/roblox-creator-docs"

bun "${HERMES_SKILL_DIR}/scripts/ingest-engine-corpus.ts" \
  --engine godot --checkout-root "$ROOT" --dry-run
```

The dry run needs no credentials and makes no network call. Ingestion embeds every chunk and
fails immediately with `OPENAI_API_KEY not set` when the profile environment is missing:

```bash
bun "${HERMES_SKILL_DIR}/scripts/ingest-engine-corpus.ts" \
  --engine godot --checkout-root "$ROOT" --recreate
```

Valid `--engine` values are `godot`, `roblox`, `unity`, and `unreal`. Compare the dry-run
chunk count against the resulting `points_count`; they must match exactly.
`--recreate` deletes and rebuilds the collection; snapshot it first if it matters.

`CORPUS_BATCH_SIZE` controls embedding concurrency (default 32). Larger corpora benefit
from 96; the embedding tier is latency-bound rather than rate-limited at that level.

### Unreal acquisition (licensees only)

Unreal needs a sparse blobless checkout — a full clone is tens of gigabytes, the
convention-bearing surface is a few hundred megabytes. Verify access with
`gh api repos/EpicGames/UnrealEngine` before cloning.

```bash
git clone --filter=blob:none --no-checkout --depth 1 --branch release \
  https://github.com/EpicGames/UnrealEngine.git "$ROOT/unreal-engine"
cd "$ROOT/unreal-engine" && git sparse-checkout init --no-cone
```

Write a sparse-checkout pattern set covering public headers, `*.Build.cs`, `Engine/Shaders`,
`Engine/Config`, Templates and Samples into `.git/info/sparse-checkout`, then
`git checkout release`. Restrict Templates, Samples, Config, and Shaders to text extensions so
`.uasset` binaries are never fetched.

Run long clones and ingestions as tracked foreground or supervised background commands. A
detached `nohup ... &` can be reaped by an execution wrapper before the transfer starts and
leave an empty repo with a success-looking log.

If Qdrant storage on the host is ephemeral, take a Qdrant snapshot after ingestion so the new
points survive a restart.

## Source Policy

Index locally with full provenance. Do not republish substantial upstream text.
Synthesize conventions into original implementation and attribute engine documentation
where a project surfaces it. Index private or paid course material only for the licensee's
own use, and never through this skill's shipped configuration.
