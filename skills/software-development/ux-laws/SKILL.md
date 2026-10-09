---
name: ux-laws
description: "Twenty research-based UX principles (Hick-Hyman, Fitts, Jakob, Gestalt grouping, Miller, response-time limits, von Restorff, serial position, peak-end, Zeigarnik, Tesler, Postel, Parkinson, Occam, Pareto, goal gradient, chunking) written as testable rules with primary citations and an evidence class for each. Use when building, reviewing or auditing a user interface, when adding design constraints to a project's agent instruction file (AGENTS.md, .hermes.md, CLAUDE.md, .cursorrules and similar), or when a UI pull request needs a review checklist."
version: 2.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, ux, design, review, Zouroboros]
    related_skills: [impeccable, design-md-drift-guard, visual-verifier]
prerequisites:
  commands: [bun]
---

# UX laws

Twenty principles about human perception, memory, movement and choice, each turned into a rule with a
number or a test attached. They describe users, not tools, so the same rules serve Hermes, any
other coding agent and a human design review.

## When to use

- **Building UI:** load the rules into context before any interface code exists.
- **Reviewing UI:** answer the checklist for the changed screens, using the diff, a mockup or the live app.
- **Project setup:** install the rules block into the project's instruction file once.
- **Design disagreements:** the tensions table decides which rule gives way.

For hands-on design execution (layout, tokens, motion, live iteration), use the Hermes
`impeccable` skill where it is installed. This skill provides the principles and the review.

## Files

| File | Contents |
|---|---|
| `references/ux-laws.md` | Each principle: the finding, the rule, the check, primary sources and the evidence class; then the tensions table and related reading |
| `assets/ux-principles.md` | The rules block to paste into an instruction file; names no tool |
| `assets/review-checklist.md` | Review checklist, one defect question per principle |
| `scripts/ux-laws.ts` | Prints the block, checklist or JSON; writes or refreshes the block in a project's instruction file; reports status |
| `scripts/ux-laws.test.ts` | Offline tests for the script and the assets |

## Commands

```bash
# Print the rules block, the checklist, or the rules as JSON
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" render
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" render --format checklist
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" render --format json

# Install into a project's instruction file (default AGENTS.md); re-running updates in place
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" install --target <project-dir>
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" install --target <project-dir> --file .hermes.md
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" install --target <project-dir> --file CLAUDE.md --dry-run

# List the known instruction files in a project and whether each carries the block
bun "${HERMES_SKILL_DIR}/scripts/ux-laws.ts" status --target <project-dir>
```

`install` writes the block between `<!-- ux-laws:start -->` and `<!-- ux-laws:end -->`. Running it
again replaces that region instead of adding a second copy. Hermes reads `AGENTS.md`, `CLAUDE.md`,
`.cursorrules` and `.hermes.md` from a project, so any of them works. The script writes only the
file named by `--target` and `--file`, and never anything inside the skill directory.

## The rules at a glance

1. **Hick:** one main decision per screen; about seven options at most per decision point.
2. **Fitts:** targets 44 x 44 px or larger (never below 24 x 24 CSS px), 8 px apart; main action near the pointer.
3. **Jakob:** familiar patterns by default; a new pattern needs a stated user benefit.
4. **Proximity:** space between groups at least twice the space inside them.
5. **Miller:** labelled groups of three to five; long lists get grouping, search or filters.
6. **Response time:** feedback within 100 ms, routine work within 1 s, progress beyond that.
7. **Von Restorff:** one dominant action per screen, distinct in greyscale.
8. **Serial position:** key items at the start and end of lists.
9. **Peak-end:** a designed success screen with a next step; care at the hardest moment.
10. **Zeigarnik:** show steps, position and what remains; unfinished work is resumable.
11. **Prägnanz:** plain, aligned layouts; simplify whatever needs explaining.
12. **Similarity:** one function, one look, product-wide.
13. **Uniform connectedness:** related controls share a container; unrelated ones do not.
14. **Tesler:** the system carries complexity through defaults and inference.
15. **Postel:** tolerant input, inline validation, errors that state the fix, undo or confirm for destruction.
16. **Parkinson:** fewest steps and fields the result needs.
17. **Occam:** every visible element serves the current task.
18. **Pareto:** the most-used features get the best places, by data or a labelled guess.
19. **Goal gradient:** honest progress; a head start only for real completed work.
20. **Chunking:** group long codes and numbers; section long content.

## Weight of evidence

The reference labels every entry, because they are not equally solid:

- **Empirical** (controlled, replicated experiments): Hick, Fitts, proximity, Miller, von Restorff,
  serial position, peak-end, Zeigarnik (mixed replication), Prägnanz, similarity, uniform
  connectedness, goal gradient, chunking.
- **Observational** (industry measurement or practitioner experience): Jakob, response time.
- **Heuristic** (maxims, not findings): Tesler, Postel, Parkinson, Occam, Pareto. Use them to
  guide a choice, not to win an argument.

Several empirical entries are applied beyond the setting in which they were measured; the
reference says where.

## Conflicts between rules

Before letting one rule override another, read `references/ux-laws.md#tensions`. In short: Tesler
limits Hick (move needed options, do not delete them); Similarity limits von Restorff (only one
thing stands out); convention beats novelty unless a benefit is stated; Postel governs input and
errors while Occam governs presentation; and honesty limits the goal gradient (progress shown
must be real).

## Provenance

Rewritten from primary research for this distribution. Every principle is re-derived from the
original publications cited in `references/ux-laws.md`; no text or presentation from third-party
summaries is reproduced. The installer script and the rules/checklist/tensions design come from
the Zouroboros `ux-laws` skill.
