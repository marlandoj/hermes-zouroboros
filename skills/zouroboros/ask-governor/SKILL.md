---
name: ask-governor
description: "Govern one-shot model calls made through the Hermes profile with bounded concurrency, named request budgets, deduplication, a circuit breaker, safe retries and privacy-preserving telemetry. Use when building, operating or diagnosing scripts and skills that call models unattended (deep-research, broll-injector, ponytail-review, agent-model-healer)."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, models, governance, automation]
    related_skills: [ask-retry, deep-research, agent-model-healer]
prerequisites:
  commands: [bun, hermes]
---

# Ask Governor

Replaces the source workspace's `zo-ask-governor`, which governed Zo `/zo/ask` traffic.
Upstream calls now go through `integration/ask.ts`: the profile's executor registry, with
`hermes-vps` (a one-shot `hermes -z`) as the default. The provider, model and credentials
come from the Hermes profile. The governor holds no token and no endpoint.

Route unattended model calls through `governedAsk` in `scripts/client.ts`:

```ts
import { governedAsk } from "<checkout>/skills/zouroboros/ask-governor/scripts/client.ts";
const { output } = await governedAsk({ input: prompt }, { caller: "my-job", budgetKey: "my-job", budgetLimit: 24 });
```

## Invariants

- Never log prompts, outputs or credentials. Telemetry records the caller, timings, attempts,
  error class, circuit state and budget key only.
- Treat empty output as a failure.
- Retry only transient failures: timeout, or a Hermes failure. Never retry a usage error, an
  unavailable Hermes CLI or profile, or an interrupt.
- Bound every request by a timeout, an attempt count (1-5), a queue deadline and a named
  budget. The remaining deadline is passed to the bridge as its timeout.
- When `ZOUROBOROS_ASK_GOVERNOR_URL` is set and that service is unavailable, fail closed.
  There is no silent fallback to an ungoverned path.
- Use deterministic code instead of a model call when no model judgement is needed.

## Modes

| Mode | When | Concurrency scope |
|---|---|---|
| in-process (default) | `ZOUROBOROS_ASK_GOVERNOR_URL` unset | per process; budgets and circuit persist in the state directory |
| service | `bun "${HERMES_SKILL_DIR}/scripts/governor.ts" serve`, then set `ZOUROBOROS_ASK_GOVERNOR_URL=http://127.0.0.1:7821/v1/ask` | shared by every caller |

The service binds `127.0.0.1` only. Set the port with `ZOUROBOROS_ASK_GOVERNOR_PORT`. Other
tuning variables are `ZOUROBOROS_ASK_GOVERNOR_CONCURRENCY` (2),
`_QUEUE_CAPACITY` (100), `_FAILURE_THRESHOLD` (5) and `_COOLDOWN_MS` (60000).

## State

Budgets, the circuit snapshot and the redacted NDJSON telemetry live in
`$ZOUROBOROS_STATE_DIR/ask-governor/`. If that variable is unset, they go in `state/` in the
profile. Override the directory with `ZOUROBOROS_ASK_GOVERNOR_STATE_DIR`.

```bash
bun "${HERMES_SKILL_DIR}/scripts/governor.ts" health   # persisted circuit and budget state
bun "${HERMES_SKILL_DIR}/scripts/governor.ts" where    # state directory
```

When the service is running, `GET http://127.0.0.1:7821/health` shows the queue, circuit and
budget state.

## Verification

```bash
bun test "${HERMES_SKILL_DIR}/scripts/governor.test.ts"   # offline: upstream calls are injected
```
