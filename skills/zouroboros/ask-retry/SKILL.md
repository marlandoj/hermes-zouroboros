---
name: ask-retry
description: "Retry-wrapped one-shot model call through the Hermes profile (executor registry, default hermes-vps). Classifies failures, retries transient ones with backoff + jitter, optionally rotates a model chain, and gives scripts a done-or-fail-loud exit contract (0/1/2/3). Use when a script or scheduled job needs one model answer and must not silently lose it to a timeout or provider hiccup."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, models, retry, automation]
    related_skills: [ask-governor, zo-swarm-executors]
prerequisites:
  commands: [bun, hermes]
---
# ask-retry — retry-wrapped one-shot model calls

Replaces the source workspace's `zo-ask-retry` (a Zo `/zo/ask` runner). Calls go through
the hermes-zouroboros profile's executor registry: by default `hermes-vps`, a one-shot
`hermes -z` run through `integration/hermes-bridge.sh`. The provider, model and credentials
therefore come from the Hermes profile; this skill holds no token or endpoint.

1. **Classifies failures** from the bridge exit status.
2. **Retries** transient failures with exponential backoff and jitter. Other failures exit
   immediately without spending retries.
3. **Rotates a model chain** (optional `--chain m1,m2`) after `--same-model-retries`
   attempts on one model.
4. **Bounds every attempt** with `--timeout-sec` (the bridge's `HERMES_TIMEOUT`).

The bridge returns the final response only, so there is no partial stream to resume. A retry
re-sends the whole prompt, so prefer idempotent prompts.

## Usage

The skill needs a hermes-zouroboros checkout with an initialized profile
(`bun integration/cli.ts init --workspace PATH`).

```bash
bun "${HERMES_SKILL_DIR}/scripts/ask-retry.ts" --input "your prompt"

# Shell-friendly: stdout = final output only, attempt trail on stderr
OUT=$(echo "$PROMPT" | bun "${HERMES_SKILL_DIR}/scripts/ask-retry.ts" -v)

# Rotate across models known to the Hermes profile
bun "${HERMES_SKILL_DIR}/scripts/ask-retry.ts" --chain "model-a,model-b" --same-model-retries 2 --input "..."

# Require a JSON shape; machine-readable envelope (output, model, attempt trail)
bun "${HERMES_SKILL_DIR}/scripts/ask-retry.ts" --output-format-file schema.json --json --input "..."
```

Without `--model` or `--chain`, the profile's configured model is used. `--provider` needs a
model. Full flag list: `--help`. `--dry-run` prints the resolved configuration and makes no
call.

## Exit codes

| code | meaning |
|------|---------|
| 0 | success: stdout has the final output |
| 1 | permanent failure (usage error at the bridge, Hermes CLI unavailable, interrupted) |
| 2 | retries exhausted (transient class) |
| 3 | usage error (no prompt, bad flag value) |

## Failure classification

| Bridge result | Class |
|---|---|
| exit 124 or 137 (GNU `timeout`) | transient: timeout |
| any other Hermes failure, or exit 0 with empty output | transient: failed |
| exit 2 (bridge usage) | permanent |
| exit 126 or 127, or no profile or registry | permanent: unavailable |
| exit 130 or 143 | permanent: interrupted |

The bridge never reflects provider stderr, which may contain credentials. A failed attempt
records its class and the bridge's own message. Inspect the private Hermes session logs for
provider details.

## When to use vs not

Use it for one-shot model calls from scripts, cron-job helpers and other skills. In
TypeScript, import `askWithRetry` from `scripts/ask-retry.ts`.

Do not wrap it in another retry loop: this runner already retries, and nesting multiplies
cost. To share concurrency, budgets and a circuit breaker across callers, use `ask-governor`.
It has its own bounded retries.

Do not use it for prompts with side effects (trades, emails, deletions). A retried attempt
runs the whole instruction again.
