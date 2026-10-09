---
name: ai-character-builder
description: "Workflow for designing an AI character end to end: identity profile, avatar images, voice configuration and a content workflow blueprint, composed from the fal-ai-media, persona-creator and text-to-speech skills. Use when the user wants to create a new AI character, avatar persona or virtual presenter."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [media, characters, personas, avatars, Zouroboros]
    related_skills: [fal-ai-media, persona-creator, heygen-avatar]
---

# AI Character Builder

Design and assemble an AI character from existing skills. This skill is a workflow, not a
toolkit: it carries no scripts of its own and writes nothing until the user approves each
artifact.

## Outputs

Keep every artifact in one character folder in the operator's workspace, for example
`characters/<slug>/` under `ZOUROBOROS_WORKSPACE`, never inside the skill directory:

| Artifact | File | Produced by |
|---|---|---|
| Identity profile | `identity.md` | this workflow (step 1) |
| Avatar images | `avatar/*.png` | `fal-ai-media` |
| Voice configuration | `voice.json` | the profile's text-to-speech provider |
| Agent persona (optional) | persona files | `persona-creator` |
| Content workflow | `workflow.md` | this workflow (step 5) |

## Workflow

1. **Identity profile.** Interview the user for name, role, audience, personality traits,
   tone, values, boundaries, visual style and do/don't lists. Write `identity.md`. A character
   must never impersonate a real person without that person's documented consent.
2. **Avatar.** Turn the visual section of the profile into prompts and generate 2-4
   candidates with `fal-ai-media` (`generate`, then `edit` for consistent variations such as
   poses or outfits). Keep the chosen seed prompt in `identity.md` so later images stay
   consistent. Confirm cost with the user before batches or video.
3. **Voice.** Pick a voice from the profile's text-to-speech provider that matches the tone,
   and record provider, voice id and settings (speed, stability, style) in `voice.json`.
   Generate one short sample line for approval. Do not clone a real person's voice without
   documented consent.
4. **Persona (optional).** If the character should also act as an agent persona, generate it
   with `persona-creator` from `identity.md`. `persona-creator` installs a Hermes personality
   but never switches to it.
5. **Content workflow.** Write `workflow.md`: channels, formats, cadence, a reusable prompt
   template per format, and the review step before anything is published. For talking-head
   video, route through `heygen-avatar` / `heygen-video`.
6. **Review.** Show the user the folder contents and the outstanding decisions. Publishing,
   account creation and paid generation always need the user's explicit approval.
