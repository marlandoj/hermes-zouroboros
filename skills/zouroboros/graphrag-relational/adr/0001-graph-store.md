# ADR-0001: Graph Store for GraphRAG over Relational Data

Date: 2026-07-13; amended 2026-08-11

## Status

Accepted, amended 2026-08-11 (source-built Redis); adapted for the hermes-zouroboros distribution.

## Decision

Use **FalkorDB Lite v0.3.0** with the pinned Linux module and a source-built,
checksum-verified Redis 8.2.3 child process. The child listens only on a private
Unix socket and is closed after each operation.

## Context

The decision was between:

- **Kuzu**: embedded property graph database, npm package `kuzu`, Cypher support,
  no server process.
- **FalkorDB**: production-grade graph database with OpenCypher support, npm
  package `falkordb`, requires a running FalkorDB/Redis-compatible server, most
  commonly via Docker.

The original decision chose Kuzu because the source host had no Docker or compatible
FalkorDB server. Kuzu is now archived, while the maintained FalkorDB Lite package
provides an embedded lifecycle and persistent graph storage. The platform
package's bundled Redis binary requires glibc 2.38, which older distributions
(for example Debian 12, glibc 2.36) lack, so the runtime supplies a compatible
Redis 8 binary, built from pinned and checksum-verified source, without creating a
service or opening a network listener.

## Evidence

Kuzu upstream status:

- `https://github.com/kuzudb/kuzu` is a public archive.
- GitHub reports: "This repository was archived by the owner on Oct 10, 2025. It
  is now read-only."
- The README note says KuzuDB is being archived, prior releases remain usable,
  and v0.11.3 bundles several extensions.
- Latest GitHub release shown during verification: `v0.11.3`, dated 2025-10-10.

FalkorDB upstream status:

- `https://github.com/FalkorDB/FalkorDB` is public and not archived in the
  verified GitHub view.
- The README describes FalkorDB as an ultra-fast multi-tenant graph database for
  GraphRAG and knowledge graphs.
- The README's quick start uses Docker:
  `docker run -p 6379:6379 -p 3000:3000 ... falkordb/falkordb`.
- The README lists `falkordb-ts` / npm as an official Node.js client.

Bun/runtime probes:

- `bun --version` returned `1.2.21`.
- `bun add kuzu` installed `kuzu@0.11.3`; Bun blocked Kuzu's native install
  lifecycle until `bun pm trust kuzu`.
- After trust, the Bun probe created a Kuzu database, ran `CREATE NODE TABLE`,
  inserted `(:Person {name:'Ada'})`, and `MATCH` returned `[{"name":"Ada"}]`.
- `falkordblite@0.3.0` and `@falkordblite/linux-x64@8.2.3-falkordb.4.16.3`
  load successfully under Bun 1.2.21.
- The package's declared optional binary version is not published, and the
  available Linux bundle's Redis binary requires glibc 2.38.
- Redis 8.2.3 built from the official tag on the source host with `MALLOC=libc`; the
  source archive SHA-256 is pinned in `scripts/runtime.ts`.
- A no-override first-use run downloaded, verified, compiled, cached, indexed,
  reopened, and queried the graph. The focused suite passed 3/3 in 28.19 seconds.
- The verified cache receipt was written atomically, no build directory remained,
  and no Redis child remained after the tests.

Distribution notes (hermes-zouroboros):

- The first-use build compiles only `redis-server` with `OPTIMIZATION=-O2`:
  Redis' default `-flto` crashes GCC 15's LTO plugin under `make -j`.
- The build is refused in CI and when `GRAPHRAG_NO_BUILD=1`; graph-backed tests
  run only with `GRAPHRAG_LIVE_TESTS=1`.
- Lifecycle scripts of `falkordblite` are not trusted; the runtime never needs
  its postinstall.

## Consequences

Positive:

- FalkorDB keeps the local embedded shape without Docker, TCP, or service
  provisioning.
- Bun compatibility is proven with real index, reopen, traversal, and cleanup
  checks.
- Extraction jobs can create disposable graph directories in a scratch
  directory or the profile state root and replay from the source database.

Negative:

- First use requires source download and a C/C++ build toolchain.
- Each invocation starts a bounded local child process, so callers must close
  the returned session in `finally` blocks.
- The source and module digests must be reviewed deliberately when upgrading.

Reevaluation trigger:

- Reevaluate the child-process shape if concurrent workloads require a
  long-lived graph service or if a future platform bundle supports the target host's
  glibc directly.
