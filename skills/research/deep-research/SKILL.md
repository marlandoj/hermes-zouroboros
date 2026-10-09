---
name: deep-research
description: "Mechanical deep-research pipeline. Chains peer-reviewed literature, open web and the profile's own memory into a single provenance-tracked synthesis, emitted as a markdown report. Use when the user asks to \"research X deeply\", \"do a deep dive on X\", \"what does the research/evidence say about X\", or wants a sourced report fusing what we already know with what's published. Runs as a resumable, fail-loud, file-based DAG - plan -> gather (parallel) -> fuse -> synthesize -> claim-check -> report -> persist."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [research, synthesis, citations, Zouroboros]
    related_skills: [ask-governor, zo-memory-system]
prerequisites:
  commands: [bun, hermes]
---

# Deep Research Pipeline

A single conductor (`scripts/research.ts`) runs a 7-stage research DAG. Every model call is
a one-shot Hermes run through `ask-governor`, using the hermes-zouroboros profile's executor
registry (default `hermes-vps`). The provider, model, credentials and research tools therefore
come from the Hermes profile. The skill needs a hermes-zouroboros checkout with an
initialized profile.

## Run it

```bash
bun "${HERMES_SKILL_DIR}/scripts/research.ts" "<your research question>"
```

Flags:
- `--no-external`: skip the literature and web gather (internal memory only).
- `--no-internal`: skip the profile memory search (literature and web only).
- `--no-persist`: do not store a record of the run in profile memory.
- `--force`: re-run all stages even if their artifacts exist.
- `--run-dir <path>`: override the output directory.
- `--max-papers N` / `--max-web N` / `--max-internal N`: per-sub-question caps (defaults 6 / 6 / 5).
- `--model ID`: model for every call (or `DEEP_RESEARCH_MODEL`). The default is the profile's model.

Output: `<workspace>/reports/deep-research/<slug>-<date>/report.md`, where `<workspace>` is
the profile workspace. Per-stage artifacts sit beside it (`00-plan.json` … `04-validated.json`).

## Architecture

| Stage | Source |
|-------|--------|
| plan | model call (governed, budget `deep-research-reasoning`) |
| gather: literature | Hermes agent with the profile's literature tool (for example a Consensus or Semantic Scholar MCP), else scholarly web search; budget `deep-research-external-gather` |
| gather: web | Hermes agent with the profile's web search tool; same budget |
| gather: internal | profile memory facts via `zo-memory-system` (`zmem.ts search`) |
| fuse | deterministic ranking per sub-question |
| synthesize / claim-check | model calls (claim-check uses the literature tool, best effort) |
| report | deterministic Markdown with a grouped bibliography |
| persist | `zmem.ts store` into the profile memory (soft-fail) |

Design notes:
- **Fail-loud:** a hard stage failure exits non-zero and names the stage. Partial artifacts are kept.
- **Idempotent:** each stage skips if its artifact exists. `--force` overrides.
- **Provenance:** every synthesized claim carries an `[S#]` marker that resolves to the
  bibliography. Orphan markers are reported.
- **Gather protocol:** each gather call asks the agent to use its own tools and reply with
  JSON only. Literature and web quality therefore depend on the tools enabled in the profile.
  With no web tool, the gather returns nothing and the run falls back to internal memory. If
  every channel is empty, the gather stage fails loud.
- **Governed:** concurrency, budgets, retries and the circuit breaker come from
  `ask-governor`. Prompts and outputs are never logged.

## Triggering via natural language

"Research X deeply" or "deep dive on X": run the conductor via the terminal and surface
`report.md`. In an interactive session you can also do the research directly with your own
tools. The conductor makes it repeatable and headless (CLI or a Hermes cron job).

## Not carried over from the source workspace

The source pipeline also used host Qdrant collections (a leaf-chunk corpus, RAPTOR summary
nodes and a compounding corpus), GraphRAG community summaries from the host memory database,
direct OpenAI calls and an opt-in audio overview. Those depended on host services and keys,
so they are not part of this port. The audio overview can be rebuilt on Hermes text-to-speech.
