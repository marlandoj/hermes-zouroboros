---
name: extract-patterns
description: "Noise-free session pattern gate: at the end of a substantial session, extract a behavioral pattern ONLY if it is project-specific, repeatedly applicable, non-obvious and trigger→action; otherwise write nothing, so trivial sessions add no memory noise. Runs as a Hermes shell hook and feeds instinct-harvester. Use when installing or tuning the gate, answering its prompt, or investigating why a pattern was or was not extracted."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, hooks, learning]
    related_skills: [instinct-harvester]
prerequisites:
  commands: [bash, jq, bun]
---

# extract-patterns

A binary discipline check. Extract a pattern only if it is all four of:

1. **Project-specific:** not generic best practice.
2. **Repeatedly applicable:** likely to recur in future sessions on this repo.
3. **Non-obvious:** to a senior engineer already familiar with this codebase.
4. **Trigger → action:** expressible as "when X in context Y, do Z".

If not all four hold, write **nothing** (not even a "checked" entry) and say only
`No new patterns to extract.` Never force extraction; an empty harvest is the correct output for
most sessions. Adapted from the ECC `extract-patterns` hook (MIT).

## Answering the gate

When the gate prompt appears in your context:

- **A qualifying pattern:** record it with instinct-harvester
  (`bun <skills>/zouroboros/instinct-harvester/scripts/observer.ts add --trigger … --action … --domain … --confidence 0.5-0.9 --source session-observation`)
  and append `<ISO8601-UTC> session=<id> decision=extracted domain=<domain>` to the decision log.
- **Nothing qualifies:** append `<ISO8601-UTC> session=<id> decision=none` and reply only
  `No new patterns to extract.`

## Installing the hook

`scripts/extract-patterns-hook.sh` speaks the Hermes shell-hook protocol. Add it to the profile's
`config.yaml`. Hermes asks for consent on first use, or set `hooks_auto_accept: true` for
unattended gateways.

```yaml
hooks:
  pre_llm_call:
    - command: "/absolute/path/to/checkout/skills/zouroboros/extract-patterns/scripts/extract-patterns-hook.sh"
      timeout: 10
  on_session_finalize:
    - command: "/absolute/path/to/checkout/skills/zouroboros/extract-patterns/scripts/extract-patterns-hook.sh"
      timeout: 10
```

- **`pre_llm_call`:** once per session, when the conversation reaches
  `EXTRACT_PATTERNS_MIN_MESSAGES` messages (default 40), it injects the four-criteria review
  as context. Shorter sessions are skipped. A per-session sentinel makes it a single nudge.
- **`on_session_finalize`:** never injects anything. It back-fills the decision log so every
  session has exactly one outcome: `no-review` for short sessions, `prompted-unresolved` if
  the gate was never answered.

## Files and controls

| What | Where |
|---|---|
| decision log | `$ZOUROBOROS_LOG_DIR/extract-patterns.log` (override: `EXTRACT_PATTERNS_LOG`) |
| per-session sentinels | `$ZOUROBOROS_STATE_DIR/extract-patterns/` |
| kill switch | `touch $ZOUROBOROS_CONFIG_DIR/extract-patterns.off`, or `EXTRACT_PATTERNS_OFF=1` |

Each directory falls back to the profile data directory (`HERMES_ZOUROBOROS_HOME`). Patterns
themselves live in the instinct store. The hook fails open on any error. It also ignores session
ids that are not safe file names.

Log lines look like:

```
2026-07-03T03:00:00Z session=<id> decision=prompted messages=87
2026-07-03T03:01:12Z session=<id> decision=extracted domain=software-factory
2026-07-03T03:04:00Z session=<id> decision=none
2026-07-03T03:05:00Z session=<id> decision=no-review reason=below-threshold
```

## Other inputs

The same four-criteria test applies to recurring failure records that other skills write. Two
examples are visual-verification mismatches and the classifier-fallback block ledger. A failure
mode qualifies only with at least two confirmed occurrences. Intentional refusals never graduate
to a route-around instinct.

## Test

`bash scripts/selftest.sh` uses a temporary state root. It covers the threshold, prompt-once,
finalize back-fill, both kill switches, fail-open and unsafe session ids.
