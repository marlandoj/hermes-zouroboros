---
name: agent-model-healer
description: "Self-healing model fallback for the Hermes profile's scheduled agents (cron jobs). Probes the models in an operator-defined fallback chain through the Hermes profile, moves jobs pinned to an unhealthy model to the first healthy fallback, and restores them when the original recovers. Dry run until the operator enables healing. Use to keep cron jobs running through provider outages, credit exhaustion or rate limits."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, cron, scheduled-agents, models, self-healing]
    related_skills: [agent-doctor, ask-governor]
prerequisites:
  commands: [bun, hermes]
---

## Agent Model Healer

Replaces the source workspace's model healer, which managed Zo scheduled agents and probed
models through Zo `/zo/ask` or host executor bridges.

### Problem

A Hermes cron job can pin a model (`hermes cron edit <id> --model …`). When that model becomes
unavailable through an outage, exhausted credits or rate limits, every run of the job fails
until someone notices.

### How it works

`healer.ts auto` is deterministic code. The only model cost is one short probe prompt per chain model.

1. **Probe:** each model in the fallback chain gets a short prompt through the Hermes
   provider/model layer: the profile's executor registry (default `hermes-vps`, a one-shot
   `hermes -z` with `--model` and, if the chain entry sets one, `--provider`).
2. **List:** the profile's cron jobs are read from `$HERMES_HOME/cron/jobs.json`. Only active
   jobs that pin a model are patients. Jobs on the profile default model are never moved.
3. **Heal:** a job on an unhealthy model moves to the first healthy, non-excluded fallback with
   `hermes cron edit <id> --model <fallback> [--provider …]`.
4. **Restore:** when the original model has recovered, the job moves back, with its original
   provider.
5. **Report:** a JSON summary goes to stdout. A Hermes cron job delivers it, so you are
   notified through your normal delivery target. A log line goes to
   `$ZOUROBOROS_LOG_DIR/agent-model-healer.log`.
6. **State:** switches, last probes and streaks are kept in
   `$ZOUROBOROS_STATE_DIR/agent-model-healer/state.json`. A job reassigned by hand is dropped
   from the state at the next run.

### Probe semantics

- **Healthy threshold:** `healthyResponseMs` (default 10000). A *completed* response at or
  above it is **degraded**, with its real elapsed time. So is a completed response that lacks
  the expected marker. Degraded models are still usable.
- **Timeout:** `timeoutMs` must be strictly greater than `healthyResponseMs` and in whole
  seconds (it becomes the bridge's `HERMES_TIMEOUT`). A timeout records `latencyMs: null` and
  `failureCategory: "timeout"`.
- **Failure categories:** `timeout`, `provider_error` and `empty_response`. The bridge never
  reflects provider stderr; look in the private Hermes session logs for details.
- **Probe path unavailable:** if the Hermes CLI, the profile or the registry is missing, the
  run aborts with exit 2. It does not declare every model unhealthy, which could reassign the
  whole fleet.

### Safety

- **Healing gate:** `healingEnabled` defaults to **false**. Until then, `auto` reports the heal
  and restore actions it *would* take and applies none.
- **Hysteresis:** by default a job moves only after 2 consecutive unhealthy probes and moves
  back only after 3 consecutive healthy ones. An absent or invalid setting fails closed to these
  values.
- **Chain policy (`validate`):**
  - every fallback must itself be a chain model;
  - each chain's last rung must be open-weight;
  - a proprietary chain needs at least one open-weight rung.
  - Exhaustion produces an alert (exit 3), never a cascade.
- **Operator exclusions (`excludedFromAutoFallback`):** a model listed there, by exact or
  case-insensitive substring match, is never a fallback target. Jobs on it are never
  auto-healed away.
- **Watchmen independence:** run the healer as a `no_agent` Hermes cron job whose script runs
  `bun …/healer.ts auto`. It then has no model dependency of its own. `validate` warns if the
  healer's job runs through a model.
  - The healer never edits its own job. It recognizes that job by `agent-model-healer` or
    `model healer` in the name, prompt, script or skills.

### Usage

```bash
bun "${HERMES_SKILL_DIR}/scripts/healer.ts" validate   # chain shape, probe timing, exclusions, own job
bun "${HERMES_SKILL_DIR}/scripts/healer.ts" probe      # probe every chain model now
bun "${HERMES_SKILL_DIR}/scripts/healer.ts" diagnose   # pinned-model jobs grouped by model
bun "${HERMES_SKILL_DIR}/scripts/healer.ts" status     # switches and last probes
bun "${HERMES_SKILL_DIR}/scripts/healer.ts" auto       # the scheduled pipeline
```

Exit codes for `auto`:

| Code | Meaning |
|---|---|
| 0 | complete |
| 2 | validation failed, or the probe path is unavailable |
| 3 | operator action needed: an exhausted chain or a failed `hermes cron edit` |

### Configuration

Copy `assets/fallback-chain.example.json` to
`$ZOUROBOROS_CONFIG_DIR/agent-model-healer/fallback-chain.json`, or set
`AGENT_MODEL_HEALER_CONFIG`. Then:

- name your own models: the keys of `fallbackChains`, each with an optional `provider`;
- set the probe thresholds and retries;
- keep `excludedFromAutoFallback` current;
- flip `healingEnabled` only after reviewing a dry run.

Run `healer.ts validate` after every edit.

### Files

- `scripts/healer.ts`: the healer engine (validate, probe, diagnose, status, auto).
- `scripts/healer.test.ts`: chain policy, probe semantics, exclusions, hysteresis and probe
  classification. Runs offline.
- `assets/fallback-chain.example.json`: the reference policy, validated in tests.
- Cron access is shared with `agent-doctor` (`../agent-doctor/scripts/hermes-cron.ts`).
