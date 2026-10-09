---
name: persona-creator
description: "Create a domain persona (constitution, identity, safety rules, system prompt) with the zouroboros-personas generator and register it as a Hermes personality in the hermes-zouroboros profile. Use when the user wants a specialist persona for a domain (health, legal, finance, devops, ...) with explicit safety rules, or wants to review, validate or install one."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, personas, personality, safety]
    related_skills: [zouroboros-governance]
prerequisites:
  commands: [bun]
---

# Persona Creator

Replaces the source workspace's `zo-persona-creator`, which created Zo Computer personas. In
Hermes, a persona is a **personality**: a named system-prompt overlay in the profile's
`agent.personalities`, selected with `/personality <name>`. This skill generates the persona
files with the distribution's `zouroboros-personas` package. It writes them into the profile
only when you install them.

## Workflow

1. **Plan:**
   - the domain and the persona's role;
   - what it may and may not do;
   - the risks: advice it must not give, actions that need confirmation, data it must not
     expose.
2. **Generate.** Files go to `$ZOUROBOROS_STATE_DIR/personas/<slug>/`, never into the skill
   tree:

   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/persona.ts" create --name "Health Coach" --domain healthcare \
     --expertise "Nutrition,Exercise,Behavior change" \
     --rules "Never diagnose or prescribe|Recommend a clinician for symptoms|Never store health data outside the workspace"
   ```

   The persona directory contains:
   - `SOUL.md` (shared constitution);
   - `IDENTITY/<slug>.md` (presentation: role, tone, boundaries);
   - `SAFETY.md` (guardrails);
   - `PROMPT.md` (system prompt).

   `--with-skill` also writes a starter skill under `Skills/<slug>-skill/` for domain scripts.
3. **Review and edit.** The generated text is a starting point. Tighten the safety rules for
   the domain. `templates/safety-rules-template.md` has universal and domain-specific rule
   patterns, and `templates/persona-prompt-template.md` shows a full prompt layout.
4. **Validate:**

   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/persona.ts" validate health-coach
   ```

   This checks that the required files exist and that `PROMPT.md` has no unfilled
   `[PLACEHOLDER]` markers.
5. **Install:**

   ```bash
   bun "${HERMES_SKILL_DIR}/scripts/persona.ts" install health-coach
   ```

   - It adds `agent.personalities.health-coach` (description plus `PROMPT.md` and `SAFETY.md`
     as the system prompt) to the hermes-zouroboros profile's `config.yaml`. Other settings
     and comments are kept.
   - It never selects the personality.
   - It refuses to replace an installed personality or a Hermes built-in name (such as
     `concise` or `technical`) without `--force`.
6. **Use it.** Start a new Hermes session and run `/personality health-coach`.
   `/personality none` turns it off.

`persona.ts list` shows generated personas and installed personalities.

## Safety rules for any persona

- **Verify information:** cite sources or state uncertainty.
- **Confirm before acting:** present exactly what will happen and wait for approval.
- **Protect privacy:** expose no secrets or personal data, and access only what the task needs.
- **Enforce scope:** decline outside the persona's expertise and say why.
- **Regulated domains** (finance, health, legal) need domain rules. Examples:
  - finance: explicit confirmation with full order details, position-size limits, a
    "not financial advice" disclaimer;
  - health: "not a medical professional", refer symptoms to a clinician;
  - legal: "not legal advice", jurisdiction caveats.

A personality changes how Hermes talks and what it prioritizes. It does not grant or remove
tools. Enforce hard limits with Hermes tool configuration and approvals, or with
`zouroboros-governance`, not with prompt text alone.

## Not carried over from the source workspace

- the Zo persona settings flow;
- the Zo rule tool;
- per-persona MCP wrapper scripts that read keys from the Zo vault;
- the source's setup guides and example persona write-ups, which describe Zo Computer setup.

The SkillsMP and Agency Agents references remain available in the `zouroboros-personas`
package (`packages/personas`).
