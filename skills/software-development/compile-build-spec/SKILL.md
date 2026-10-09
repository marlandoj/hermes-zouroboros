---
name: compile-build-spec
description: "Convert, normalize, lint, review, and export free-form software build prompts as provenance-preserving Agentic Build Specifications. Use when refining an internet prompt, making requirements measurable, preparing a prompt for independent review, generating a Software Factory ticket or seed, or defining a swarm-ready task DAG without dispatching execution."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, specifications, requirements, factory, Zouroboros]
    related_skills: [ask-governor, zo-swarm-orchestrator, gauntlet-loop]
prerequisites:
  commands: [bun]
---
# Compile Build Spec

Turn a free-form build prompt into a typed, reviewable specification while preserving what the source actually said and distinguishing proposed improvements from unresolved decisions.

## Choose a Mode

- **Simple prompt:** Use `assets/build-spec-template.prompt.md` directly and retain only applicable sections.
- **Normalized specification:** Follow the full workflow below and produce canonical JSON plus rendered Markdown.
- **Independent review:** Run the deterministic validator first, then the governed review panel.
- **Factory or swarm preparation:** Export a contract-shaped ticket and immutable seed candidate. Never label or dispatch automatically.

## Full Workflow

### 1. Preserve the Source

```bash
bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" ingest \
  --input /absolute/source.prompt.md \
  --output /absolute/source-manifest.json
```

Do not edit the source prompt. Use the SHA-256 manifest as provenance.

### 2. Author the Canonical Specification

Read `references/specification-schema.md`, then convert the source into canonical JSON.

Rules:

1. Mark requirements copied or faithfully paraphrased from the source as `source`.
2. Mark quality or engineering improvements absent from the source as `proposed`.
3. Put decisions that cannot be inferred safely in `unresolved`.
4. Preserve every load-bearing source requirement or list it explicitly as an intentional exclusion.
5. Give requirements, verifications, scenarios, acceptance criteria, contracts, and milestones stable IDs.
6. Link every acceptance criterion to requirements and verification evidence.
7. Assign one owner to shared contracts and avoid unordered overlapping milestone paths.
8. Do not invent a repository, target hardware result, credential, budget, or human approval.

### 3. Validate and Render

```bash
bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" validate \
  --spec /absolute/build-spec.json \
  --source /absolute/source.prompt.md

bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" render \
  --spec /absolute/build-spec.json \
  --output /absolute/build-spec.prompt.md
```

Validation returns:

- `PASS`: structurally valid, score at least 80, no unresolved decisions.
- `HOLD`: structurally valid but incomplete, under-scored, or unresolved.
- `FAIL`: broken references, provenance, IDs, DAG, or required fields.

Never reinterpret `HOLD` as approval.

### 4. Run Independent Review

```bash
bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" review \
  --spec /absolute/build-spec.json \
  --output /absolute/review.json \
  --label project-build-spec
```

Each reviewer is one governed one-shot model call through the `ask-governor` skill, so the
provider, model and credentials come from the hermes-zouroboros profile and the call counts
against the `compile-build-spec` budget. Set `COMPILE_BUILD_SPEC_REVIEW_MODELS` to a
comma-separated list of model ids for a multi-model panel; unset means one review by the
profile's configured model. Default criteria are:

`source-fidelity,requirement-completeness,technical-feasibility,falsifiability,architecture-coherence,scope-control,verification-quality,execution-safety`

Any `revise` verdict yields `REVISE`. All `pass` plus a deterministic `PASS` yields `PASS`.
Provider failure, unparseable output or escalation yields `HOLD`. Review never rewrites the
artifact. Apply only verified findings, rerun deterministic validation, and stop after two repair
rounds for human review.

Use `--dry-run` to inspect the review request without calling a model.

### 5. Export for the Software Factory

Read `references/factory-integration.md` before exporting.

```bash
bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" export-ticket \
  --spec /absolute/build-spec.json \
  --output /absolute/factory-ticket.md

bun "${HERMES_SKILL_DIR}/scripts/spec-tool.ts" export-seed \
  --spec /absolute/build-spec.json \
  --output /absolute/factory-seed.yaml
```

Export requires deterministic validation to pass and factory fields to be complete. The skill creates candidate artifacts only. It must not:

- Create or update a Hermes Kanban task.
- Apply `factory-ready`.
- Invoke the dispatcher or conveyor.
- Execute the generated specification.
- Merge or publish anything.

The operator retains those authorities.

## Required Outputs

For a full conversion, retain:

- Immutable source prompt.
- Source manifest with SHA-256.
- Canonical Build Specification JSON.
- Rendered `.prompt.md` view.
- Deterministic validation report.
- Review report when requested.
- Factory ticket and seed candidates when requested.
- A conversion report naming retained, proposed, unresolved, and intentionally excluded requirements.

## Fixtures

No source prompt ships with the skill. Use any prompt the user supplies as the ingestion fixture
and identify it by its SHA-256 manifest, not by informal version labels.
