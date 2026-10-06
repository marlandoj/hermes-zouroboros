# zouroboros-memory

Hybrid SQLite + vector memory for Zouroboros, plus a standalone **memory-gate
daemon** that injects prior context into any host's prompts via a
`UserPromptSubmit`-style hook.

The package ships three executables:

| bin | purpose |
|---|---|
| `zouroboros-memory` | memory CLI (search, store, stats, …) |
| `zouroboros-memory-mcp` | MCP server (stdio) |
| `zouroboros-memory-gate` | HTTP gate daemon (this document) |

## The memory-gate daemon

A small HTTP service that classifies an incoming prompt, retrieves relevant
stored facts, and returns them for injection. It is built entirely on this
package's own library exports — no external services required. Vector retrieval
is used when `OPENAI_API_KEY` is set; otherwise it degrades to text/FTS search.

### Start it

After `npm i -g zouroboros-cli && zouroboros init`:

```bash
zouroboros gate start            # foreground, port 7820
zouroboros gate start --port 8100
zouroboros gate status           # GET /health

# or directly:
zouroboros-memory-gate
```

`zouroboros init` generates a `ZO_GATE_TOKEN` into `~/.zouroboros/.env`. Source
it (or export the token) before starting the daemon:

```bash
set -a; . ~/.zouroboros/.env; set +a
zouroboros gate start
```

### Configuration

| env / flag | default | meaning |
|---|---|---|
| `PORT` | `7820` | listen port |
| `ZO_GATE_HOST` | `127.0.0.1` | bind host |
| `ZO_GATE_TOKEN` | — | bearer token; **fail-closed** when unset |
| `ZOUROBOROS_MEMORY_DB` / `ZO_MEMORY_DB` | `~/.zouroboros/memory.db` | backend DB |
| `--insecure` | off | disable auth **and** force a `127.0.0.1` bind (localhost dev only) |

Auth is fail-closed: with no token set, protected endpoints deny every request.
The `--insecure` flag is a documented escape hatch for single-user local
installs — it turns auth off but refuses to bind anywhere except loopback, so an
unauthenticated daemon is never reachable off-box. Off by default.

### Endpoints

```
GET  /health    open        → { status, uptime_s, port, backend, vector_enabled, auth }
POST /gate      bearer      → { exit_code, method, output, latency_ms, backend }
POST /briefing  bearer      → { exit_code, output, latency_ms, backend }
```

## Hook contract (host-agnostic)

Any host can inject memory by pointing its pre-prompt hook at the shipped shim
(`hooks/memory-gate-hook.sh`) or by implementing this contract directly:

```
stdin  (host → hook):  JSON { "prompt": "<user text>", "persona": "<slug, optional>" }
call   (hook → gate):  POST http://$HOST:$PORT/gate
                       Authorization: Bearer $ZO_GATE_TOKEN
                       body { "message": "<prompt>", "persona": "<slug>" }
resp   (gate → hook):  JSON { "exit_code": 0|2|3|1, "output": "<memory context>", ... }
                       0 = context found → inject   2 = not needed
                       3 = needed but empty          1 = error
stdout (hook → host):  if exit_code==0 && output:  <memory-gate>\n{output}\n</memory-gate>
exit                :  ALWAYS 0 (fail-open — never block the prompt)
```

The gate does **additive** context injection, not access control. A failed,
absent, or unreachable daemon injects nothing and never blocks the prompt.
When the request omits `persona`, the shim defaults it to `shared`.

### Wiring it into Claude Code

Add a `UserPromptSubmit` hook in `settings.json`, pointing at the shipped shim
(resolve its path via your global npm prefix, e.g.
`$(npm root -g)/zouroboros-memory/hooks/memory-gate-hook.sh`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/zouroboros-memory/hooks/memory-gate-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The shim reads `ZO_GATE_TOKEN` from the environment or `~/.zouroboros/.env`, and
honors `ZO_GATE_HOST` / `ZO_GATE_PORT` / `ZO_GATE_PERSONA` overrides. It requires
`jq` and `curl` on `PATH`.

### Quick verification

```bash
export ZO_GATE_TOKEN=$(openssl rand -hex 32)
zouroboros gate start &
curl -s localhost:7820/health | jq .
curl -s -X POST localhost:7820/gate \
  -H "Authorization: Bearer $ZO_GATE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"what did we decide about the deploy pipeline?","persona":"shared"}' | jq .
```

## Library

The package also exports the memory library (`initDatabase`, `searchFacts`,
`searchFactsHybrid`, episodes, graph, reranker, routing-gate, …). See
`src/index.ts` for the full surface.

## Adopted memory concepts (hindsight / OpenViking evaluation)

Three concepts adopted from the 2026-09 evaluation of
[vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) and
[volcengine/OpenViking](https://github.com/volcengine/OpenViking). Each maps
onto a layer the package already had, and each is fail-safe by default
(Constitution Art. IX) and reversible (Art. IV).

### Memory Defense — scan every retain before storage

`storeFact` scans the value for secrets (OpenAI/Anthropic/GitHub/AWS/Slack/
Google/Stripe keys, private-key blocks, JWTs, connection-string credentials,
`password = …`-style assignments) and, opt-in, PII (SSN, email, Luhn-verified
credit cards). Matches are **redacted** in place (`[REDACTED:<pattern>]`)
before anything reaches SQLite; the redaction event is recorded in the fact's
metadata for provenance without persisting the secret.

| env | default | meaning |
|---|---|---|
| `ZO_MEMORY_DEFENSE` | `redact` | `redact` \| `block` (reject the write) \| `off`; unrecognized values fall back to `redact` |
| `ZO_MEMORY_DEFENSE_PII` | off | `1` opts PII patterns in (secrets are always enforced) |

CLI: `zouroboros-memory defense scan --text "..."`, `… defense patterns`.

### Observations — evidence-backed consolidated beliefs

Facts don't stay a flat pile. `consolidateObservations()` groups live facts by
(persona, entity, key); groups with ≥ `minProof` (default 2) facts become an
**observation** that keeps every supporting quote in `observation_evidence`
and a proof count. Observations are **refined, never overwritten**: unchanged
beliefs just gain evidence; a pending conflict among supporting facts marks
the observation `contested`; evidence dropping below threshold marks it
`faded`. Belief text is deterministic (newest evidence wins) by default, with
optional LLM synthesis (`--llm`) that falls back to deterministic on any
failure.

CLI: `zouroboros-memory observations consolidate [--persona X] [--min-proof 2] [--llm]`, `… list|show|search`.

### Mental models — standing answers with zero-token reads

A **mental model** is a standing answer to a standing question about a
persona's memory ("What are this user's code style preferences?"). Define the
question once; `refreshMentalModel` rewrites the answer from current evidence
in the background (cheap model, deterministic-digest fallback). **Reads are
plain database reads** — no retrieval, no LLM call — so an agent boots with
settled knowledge instead of rediscovering it (the OpenViking L0/L1 tiering
principle applied to memory). `refreshDueMentalModels()` is cron-friendly and
only refreshes pages whose interval elapsed.

CLI: `zouroboros-memory mental-models define --persona X --question "…"`, `… refresh|refresh-due|read|list`.
