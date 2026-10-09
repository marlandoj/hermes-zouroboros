---
name: classifier-fallback
description: Detector for model classifier SOFT-blocks — refusals, filtered-to-empty, truncated-with-disclaimer, content-policy flags — that masquerade as successful empty output to existing infrastructure (healers usually only catch HARD failures - HTTP 4xx/5xx, timeouts, genuine empties). Classifies an output as soft_block / genuine_empty / ok using a per-provider signal catalog, then routes a per-domain fallback (security → configured broader-tolerance model, bio/chem → human review, distillation → refuse-by-design, never routed around). Every block + fallback is appended to an audit ledger. A quarterly system-card-diff flags expanded classifier scope so the catalog stays current.
version: 1.0.0
author: Zouroboros
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, Safety, Model Routing, Reliability]
    related_skills: [zouroboros-observatory]
prerequisites:
  commands: [bun]
classifier-surfaces:
  - security
  - bio
  - chem
  - distillation
fallback-behavior: >-
  Detects and routes soft blocks; does NOT route around refuse-by-design domains
  (distillation) — those are intentional provider guardrails, not failures.
---

# Classifier-Fallback — Detector for model soft-blocks (SIL-14)

Detects and routes classifier SOFT blocks — refusals, filtered-to-empty,
truncated-with-disclaimer, content-policy flags — that look like successful
empty output to existing infrastructure (model healers usually only catch hard
failures: HTTP 4xx/5xx, timeouts, genuine empties).

## When to use

- After any model output is received, before treating it as a successful result
- In a model-healer probe loop (standalone today; import `classifyOutput` / `routeFallback` from `scripts/detector.ts`)
- In any pipeline that sends security/bio/chem/distillation-classified tasks

## Commands

```bash
# Classify a single output (returns JSON: block-type, confidence, fallback-action)
bun "${HERMES_SKILL_DIR}/scripts/detector.ts" classify \
  --output "I can't help with that" --provider anthropic --domain security

# Run the built-in test suite (T2/T3/T4 acceptance); keep the test ledger off real state
CLASSIFIER_FALLBACK_LEDGER="$(mktemp)" bun "${HERMES_SKILL_DIR}/scripts/detector.ts" test

# Show the fallback map for a task domain
bun "${HERMES_SKILL_DIR}/scripts/detector.ts" map --domain security

# Quarterly classifier-scope audit: baseline, then scan each quarter
bun "${HERMES_SKILL_DIR}/scripts/system-card-diff.ts" baseline   # seed snapshots
bun "${HERMES_SKILL_DIR}/scripts/system-card-diff.ts" scan --json # detect expansions
```

## Configuration & artifacts

- `assets/classifier-catalog.json` — per-provider signal patterns (refusal,
  filtered_empty, truncated_disclaimer, policy_flag) + generic fallback tier
- `assets/fallback-map.json` — per-domain fallback routing. It ships with no
  fallback models. Set `CLASSIFIER_FALLBACK_MODEL` (or
  `CLASSIFIER_FALLBACK_MODEL_<DOMAIN>`, for example `CLASSIFIER_FALLBACK_MODEL_SECURITY`)
  to a model id from your own provider configuration. With no configured model, a
  `fallback` route degrades to `human_review`.
- `assets/system-card-urls.json` — provider policy pages the quarterly diff watches
- Audit ledger: `$ZOUROBOROS_STATE_DIR/classifier-fallback/classifier-blocks.jsonl`
  (default state dir `~/.local/state/zouroboros`; override the file with
  `CLASSIFIER_FALLBACK_LEDGER`). Append-only runtime state, never committed. One JSON object per line:
  `{ timestamp, provider, model, task_class, domain, detection{result,block_type,confidence,matches[],output_length}, fallback{action,fallback_model?,...}, task_id? }`
- Policy-page snapshots for the diff: `$ZOUROBOROS_STATE_DIR/classifier-fallback/card-snapshots/`
  (override with `CLASSIFIER_FALLBACK_SNAPSHOTS`). Runtime state, never committed.

## Skill frontmatter contract

Skills that may emit classifier-touching tasks declare which surfaces they touch,
so the detector's per-domain fallback map applies:

```yaml
classifier-surfaces: [security, bio, chem, distillation]
```
