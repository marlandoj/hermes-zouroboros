---
name: visual-verifier
description: "Rendered-output verification station for the swarm post-flight eval. After a maker subagent produces a visual deliverable (UI, route, site), the station captures a full-page screenshot, then an independent vision model (never the author model) reads it against the seed acceptance criteria, the project DESIGN.md tokens and an optional prior screenshot. A match marks the task complete; a mismatch emits a structured visual diff for the maker's next iteration. The verifier is the exit condition, not the maker. Use when a seed task is flagged visual: true."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, verification, ui, vision, Zouroboros]
    related_skills: [extract-patterns, instinct-harvester, design-md-drift-guard, three-stage-eval]
prerequisites:
  commands: [bun]
  env_vars: [OPENAI_API_KEY]
---

# Visual Self-Verification Station

## When to use

The swarm post-flight eval (Stage 2) invokes this station when a seed task is
flagged `visual: true`. The station runs AFTER text-based acceptance criteria
pass. It is a second-order check that catches rendered-output failures text
eval structurally misses (wrong palette, broken layout, hydration flash,
overlapping elements, default Tailwind tokens instead of project DESIGN.md).

## Architecture

- **Direct multimodal read.** The verifier sends the screenshot to a
  vision-capable model through an OpenAI-compatible chat-completions endpoint
  and gets a JSON verdict plus a structured diff. The distribution's
  `ask-governor` is text-only, so image calls do not go through it; the
  endpoint, model and key come from the Hermes profile environment.
- **Verifier ≠ author.** `scripts/independence.ts` re-implements the
  author-exclusion check of the retired consensus gate. Ids match after
  lowercasing and dropping a provider scheme, or on the basename after the last
  `/`. If the verifier model is the author, the verifier switches to the first
  non-author model in `VISUAL_VERIFIER_FALLBACK_MODELS`. If there is none, it
  refuses (exit 1), so a model never verifies its own deliverable.
- **Single verifier by default.** `VISUAL_VERIFIER_PANEL_MODELS=a,b,c` runs one
  independent verifier per model, with the author removed. The task passes only
  if every verifier reports a clean match.

## Capturing the screenshot

`scripts/capture.ts` uses the `agent-browser` CLI. If it is not installed, take
a full-page screenshot with the Hermes browser tool, save it as a PNG and pass
it to the station with `--screenshot` instead of `--url`.

## Scripts

### `scripts/capture.ts`

```bash
bun "${HERMES_SKILL_DIR}/scripts/capture.ts" --url "http://localhost:3099/my-route" --output /tmp/screenshot.png
```

### `scripts/verify.ts`

Independent verifier. It reads the screenshot image, compares it against the
references and prints a JSON verdict.

```bash
bun "${HERMES_SKILL_DIR}/scripts/verify.ts" \
  --screenshot /tmp/screenshot.png \
  --criteria "The page uses the project's brand palette, not default zinc" \
  --design-md path/to/project/DESIGN.md \
  --author "provider:author-model" \
  --label "my-route"
```

### `scripts/station.ts`

Full pipeline: capture (or `--screenshot`) → verify → verdict. The post-flight harness uses it.

```bash
bun "${HERMES_SKILL_DIR}/scripts/station.ts" \
  --url "http://localhost:3099/my-route" \
  --criteria "..." \
  --design-md "..." \
  --author "..." \
  --label "my-route" \
  --project "my-project"
```

Exit codes: `0` match (or station disabled), `1` mismatch, `2` station error.

## Configuration

Set these in the Hermes profile environment. The scripts never read a key from a file.

| Variable | Default | Effect |
|------|---------|--------|
| `VISUAL_VERIFIER` | on | `0` skips the station entirely (exit 0, nothing written) |
| `VISUAL_VERIFIER_API_KEY` | `OPENAI_API_KEY` | Key for the vision endpoint; without one, `verify.ts` exits 1 |
| `VISUAL_VERIFIER_BASE_URL` | `OPENAI_BASE_URL`, else `https://api.openai.com/v1` | OpenAI-compatible base URL (`/chat/completions` is appended) |
| `VISUAL_VERIFIER_MODEL` | `gpt-4o` | Vision model id for the screenshot read |
| `VISUAL_VERIFIER_AUTHOR_MODEL` | none | Author model when `--author` is not passed |
| `VISUAL_VERIFIER_FALLBACK_MODELS` | none | Alternates used when the verifier model is the author |
| `VISUAL_VERIFIER_PANEL_MODELS` | none | Comma-separated panel; each model verifies independently |
| `VISUAL_VERIFIER_HYDRATE_MS` | 3000 | Wait after `agent-browser open` before the screenshot |
| `VISUAL_VERIFIER_TIMEOUT_MS` | 90000 | Vision request timeout |

## Where files go

Artifacts (`screenshot-<label>.png`, `verdict-<label>.json`,
`visual-diff-<label>.json`) are written to
`$ZOUROBOROS_STATE_DIR/visual-verifier/<project-or-label>/` unless
`--output-dir` is given. Without `ZOUROBOROS_STATE_DIR`, the root is the
hermes-zouroboros profile's `state/` directory. Nothing is written inside the
skill directory.

## Compounding

Every mismatch is appended to
`$ZOUROBOROS_STATE_DIR/visual-verifier/<project-or-label>/visual-failures.jsonl`.
The file is created at runtime. Review it with the `extract-patterns` skill's
four-criteria gate. A recurring failure mode with at least two confirmed
occurrences that passes the gate is recorded through `instinct-harvester`.
The station never writes instincts directly; it only feeds the gate.

## Rollback

`VISUAL_VERIFIER=0` disables the station. Non-visual deliverables are
unaffected (the `visual` flag is absent by default). Full revert: remove the
Stage 2 station call, remove this skill, and remove the `visual` flag from the
seed schema.

See `references/post-flight-wiring.md` for the Stage 2 procedure.
