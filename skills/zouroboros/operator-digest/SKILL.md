---
name: operator-digest
description: "Weekly plain-language briefing of what the Zouroboros loop did on its own: autonomous self-heal changes and reverts, model failovers and health, governance ledger evidence, and the short list of items that actually need the operator's judgment. Read-only. Use when producing or scheduling the weekly digest, or when asked what the system changed by itself."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, reporting, governance]
    related_skills: [zouroboros-evolve, agent-model-healer, zouroboros-governance, agent-introspect]
prerequisites:
  commands: [bun]
---

# Operator Digest

The loop runs unattended: self-heal (introspect → prescribe → evolve), the model healer and the
governance gate each write structured JSON. On their own those files are hard to read. As the
loop closes without supervision, the risk is **comprehension debt**: the system keeps changing
itself and the operator loses track of what changed, why, and where their judgment is still
required.

`digest.ts` reads that state for a time window and renders one briefing:

- what changed and why;
- what the verification layer is watching;
- the verified autonomy ledger;
- the short list of things that need a human.

It never changes loop state. It writes markdown, a styled HTML body and optionally a PDF, and
prints a JSON manifest.

```bash
bun "${HERMES_SKILL_DIR}/scripts/digest.ts"                     # last 7 days
bun "${HERMES_SKILL_DIR}/scripts/digest.ts" --days 14 --no-pdf
bun "${HERMES_SKILL_DIR}/scripts/digest.ts" --since 2026-06-01 --out /tmp/digest
```

## Data sources

All sources are optional. A missing file degrades to "nothing this week", never a crash.

| Source | Default location | Contributes |
|---|---|---|
| `evolution-history.json`, `intervention-ledger.json` | `$ZOUROBOROS_DATA_DIR` | autonomous interventions, kept or reverted, anti-Goodhart drift flags |
| `chronicle.json` + `chronicle-votes.json` | `$ZOUROBOROS_DATA_DIR` | curiosity proposals; accepted votes are escalations |
| `reputation.json` | `$ZOUROBOROS_DATA_DIR` | voter reputation, if a consensus loop writes one |
| healer state | `$ZOUROBOROS_STATE_DIR/agent-model-healer/state.json` | model failovers and health probes |
| healer chain | `$ZOUROBOROS_CONFIG_DIR/agent-model-healer/fallback-chain.json` | model labels and retired models |
| governance ledger + anchor | the `zouroboros-governance` skill's state | T0 counts, T1 actions, T2 denials, anomalies |
| runtime adapter inventory | `$ZOUROBOROS_CONFIG_DIR/governance/runtime-adapters.json` | which runtimes count as governed execution |
| `confirmation-prompt-events.jsonl` | `$ZOUROBOROS_DATA_DIR` | matched before/after confirmation-prompt counts |
| governance graph | the `graphrag-relational` skill, if installed | bounded read-only relationship evidence |

Each default falls back to the profile data directory. Overrides: `--data-dir`, `--healer-state`,
`--fallback-chain`, `--prompt-metrics`, `--adapter-inventory`, `--graph-query-script`, `--graph-db`,
`--skip-graph`.

- **Adapter inventory:** without one, no runtime is treated as governed execution, and the
  digest says so.
- **Prompt evidence:** only one exact before/after pair (same workload hash and action count)
  contributes to a reduction metric. One-sided, duplicate, mismatched, malformed or
  mixed-source records are reported and excluded.

## Severity model

- **`❌ action`:** an anti-Goodhart drift flag tripped (a change improved its visible metric
  while the hidden held-out set moved against it), the governance ledger is invalid, or a T2
  allow had no approval.
- **`⚠️ review`:** items need judgment but the loop is behaving. Examples: accepted curiosity
  proposals, live models failing their last health probe, unsupported runtime calls, or missing
  prompt or graph evidence.
- **`✅ clear`:** nothing waiting.

The ledger check fails closed. A profile whose governance ledger does not exist yet (nothing has
been recorded through `zouroboros-governance`) reports `❌ action`, because a missing ledger cannot
be integrity-valid evidence.

Reverts are informational: the loop self-correcting is reported with a ↩️ tag, never escalated.
Models the healer retired (`_removed*` blocks in the chain) are filtered out of the health alarms.

## Output

Files go to `$ZOUROBOROS_STATE_DIR/operator-digest/operator-digest-<YYYY-MM-DD>.{md,html,pdf}`
unless `--out` is given. PDF rendering tries `wkhtmltopdf`, then `weasyprint`, then `chromium`.
If none works, there is no PDF.

The manifest on stdout:

```json
{ "status": "action|review|clear", "subject": "…", "summary": "…", "windowLabel": "…",
  "mdPath": "…", "htmlPath": "…", "pdfPath": "… or null", "changedCount": 0,
  "needsJudgment": 0, "driftDetected": false, "reverts": 0, "healthOk": true }
```

The summary is the deterministic bottom line; the digest makes no model calls.

## Scheduling

Run it weekly with Hermes cron. Have the job read the manifest and deliver
`manifest.subject` with the markdown or HTML through the job's own delivery target. The
script does the work; the job only delivers. Never email it anywhere the operator has not
configured.

## Tests

`bun test "${HERMES_SKILL_DIR}/scripts/governance-evidence.test.ts"` covers ledger integrity,
prompt matching, adapters, the graph consumer and the CLI end to end on temporary paths.
