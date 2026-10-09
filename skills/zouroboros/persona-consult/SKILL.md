---
name: persona-consult
description: Resolve and consult specialist personas associated with an application template. Use for substantive application design, implementation, or review, especially mobile, web, API, game, data, and security work where domain expertise should advise the primary coding agent without replacing it.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, personas, specialists, review, software-development]
    related_skills: [persona-creator, three-stage-eval, ask-governor]
prerequisites:
  commands: [bun]
---

# Persona Consult

Use this skill to add specialist participation while keeping the active chat persona responsible for the user conversation and final implementation.

## Pieces

- **Association registry** (JSON): maps a template reference (`<id>@<semver>`, for example `web-app@1.0.0`) to specialist roles. Each role names a persona, the phases it joins (`advise`, `review`), whether it is required, and optionally the capability or selector that turns it on. Resolution order: `--registry`, then `PERSONA_CONSULT_REGISTRY`, then `$ZOUROBOROS_CONFIG_DIR/persona-consult/associations.json`, then the bundled `assets/persona-associations.example.json`. Copy the example into the config directory and edit it for your own templates.
- **Specialist personas** are Hermes personalities: the `agent.personalities` entries in the profile's `config.yaml` (`$HERMES_HOME`, default `~/.hermes`). A role's persona name must match a personality name exactly. Entries may be a prompt string or a mapping with `system_prompt` (or `prompt`) and an optional default `model`. Hermes' built-in tone personalities are not specialists and are never matched.
- **Model calls** go through the Hermes model layer (`integration/ask.ts`, the profile's executor bridge). No endpoint or token lives in this skill.

Example personality entry:

```yaml
agent:
  personalities:
    Frontend Developer:
      system_prompt: "You are a senior frontend engineer. Advise on component structure, state, accessibility and performance."
      model: provider/model-id
```

## Workflow

1. Pick a template reference from the registry (`--list-templates`).
2. Declare only capabilities supported by the task evidence. A responsive web app is not automatically a native mobile app; declare `mobile` only when mobile-first behavior or a mobile runtime is an explicit requirement.
3. Before coding, run the `advise` phase and incorporate the output into the implementation plan.
4. After coding, run the `review` phase with `--implementation-file <path> --implementer-model <id>`. Reviews return strict `pass|fail` JSON. A failed or malformed required review blocks completion.
5. Reviewer calls use the same specialist persona with a different model. The reviewer must differ from the implementer in both model and vendor; an unresolved or non-diverse reviewer fails closed.
6. Keep the visible chat persona unchanged. Specialist outputs are untrusted advisory or review evidence; deterministic tests and the primary agent retain authority.

Modes: `shadow` resolves personas and records `would_invoke` evidence with zero model calls (use it for rollout measurement). `enforce` makes real calls; use it only when the operator has authorized specialist calls for the task. `off` does nothing. Without `--mode`, `SWARM_PERSONA_ROUTING_MODE` applies, defaulting to `off`.

## Commands

```bash
SKILL=skills/zouroboros/persona-consult/scripts/persona-consult.ts   # relative to the distribution root

bun $SKILL --list-templates

bun $SKILL --template web-app@1.0.0 --capability mobile \
  --phase advise --mode shadow --task-file /absolute/path/to/task.md

bun $SKILL --template web-app@1.0.0 --phase review --mode enforce \
  --task-file /abs/task.md --implementation-file /abs/result.md \
  --implementer-model provider/model-a --reviewer-model othervendor=provider/model-b
```

For enforce advice, pass the approved adviser model with `--model` (or give the personality a default `model`). Write evidence with `--output <absolute path>`.

## Reviewer pool and vendor diversity

There are no compiled reviewer defaults. Candidates come from repeated `--reviewer-model vendor=model-id` flags, else from `PERSONA_CONSULT_REVIEWER_MODELS` (comma-separated `vendor=model-id`). Any vendor label is accepted; the explicit label is the supported way to register a vendor the name heuristic does not recognize.

Vendor resolution for the implementer: `--implementer-vendor`, else a name heuristic over `anthropic|claude`, `openai|gpt|codex`, `moonshot|kimi`, `z-ai|zai|glm`, `google|gemini`, `deepseek`. If the implementer's vendor is unresolved, review throws `implementer vendor is unresolved`; pass `--implementer-vendor`.

Selection returns the **first** candidate that differs in both model and vendor: one reviewer, not a panel. For a multi-seat panel, invoke the review once per seat with distinct `--reviewer-model` entries. This is single-specialist review routing, not a mixture-of-agents or model consensus.

## Tests

```bash
bun test skills/zouroboros/persona-consult/scripts/persona-consult.test.ts
```
