---
name: unstuck-lateral
description: "Break through stagnation with five lateral-thinking perspectives: Hacker, Researcher, Simplifier, Architect and Contrarian. Each attacks the problem from a different angle. Use when stuck in loops, fighting the same error after two or more fixes, or spinning on an approach decision. Adapted from Q00/ouroboros."
version: 1.0.0
author: Zouroboros (adapted from Q00/ouroboros)
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, Problem-Solving, Debugging, Lateral-Thinking]
    related_skills: [three-stage-eval, autoloop]
    origin: https://github.com/Q00/ouroboros
---

# Unstuck — Lateral Thinking Toolkit

> When you're stuck, you don't need more effort. You need a different angle.

## When to Use

- Same error keeps recurring after 2+ fix attempts
- You're going in circles on an approach decision
- A `three-stage-eval` keeps returning NEEDS WORK with no clear path forward
- The conversation has been on the same problem for too long
- You feel like you're fighting the architecture, the tooling, or the constraints

## Quick Start

Pick the persona that matches your stagnation pattern:

| Stuck Pattern | Persona | How |
|--------------|---------|---------|
| "I can't get past this error/constraint" | **Hacker** | Adopt `references/hacker.md` |
| "I don't understand why this is happening" | **Researcher** | Adopt `references/researcher.md` |
| "This is too complex / scope is too big" | **Simplifier** | Adopt `references/simplifier.md` |
| "Simple changes require touching everything" | **Architect** | Adopt `references/architect.md` |
| "Are we even solving the right problem?" | **Contrarian** | Adopt `references/contrarian.md` |

To adopt a perspective, read its reference file with `skill_view` (for example
`skill_view(name="unstuck-lateral", file_path="references/hacker.md")`) and answer the stuck problem
in that voice, following its Approach and Output sections. For a fresh angle that is not anchored on
the current conversation, hand the problem statement and the reference text to a subagent with
`delegate_task`. When the user only says "I'm stuck", pick the perspective with the auto-selection
table below.

## The 5 Personas

### 1. Hacker — "Make it work first, elegance later"

**Philosophy:** You don't accept "impossible" — you find the path others miss.

**Approach:**
1. List every explicit and implicit constraint
2. Question which constraints are actually required
3. Look for edge cases and bypasses
4. Consider solving a completely different (easier) problem

**Best for:** Blocked by a specific error, API limitation, library bug, or "impossible" constraint.

See: `references/hacker.md`

### 2. Researcher — "Stop coding. Read the docs."

**Philosophy:** Most blocks exist because we're missing information. Stop guessing — go find the answer.

**Approach:**
1. Define exactly what is unknown
2. Gather evidence systematically (source code, docs, tests)
3. Read official documentation first (not Stack Overflow)
4. Form a specific, evidence-based hypothesis

**Best for:** Unclear behavior, undocumented APIs, version-specific bugs, "it should work but doesn't."

See: `references/researcher.md`

### 3. Simplifier — "Cut to MVP"

**Philosophy:** Complexity is the enemy of progress. Remove until only the essential remains.

**Approach:**
1. List every component involved
2. Challenge each one: "Is this truly necessary? What breaks if we remove it?"
3. Find the absolute minimum that solves the core problem
4. Ask: "What's the simplest thing that could possibly work?"

**Heuristics:** YAGNI, Concrete First, No Abstractions Without Duplication, Worse Is Better.

**Best for:** Over-engineered solutions, scope creep, analysis paralysis, too many moving parts.

See: `references/simplifier.md`

### 4. Architect — "Rebuild the foundation"

**Philosophy:** If you're fighting the architecture, the architecture is wrong.

**Approach:**
1. Identify structural symptoms (recurring bugs, high coupling, features don't fit)
2. Map the current abstractions and coupling points
3. Find the root misalignment
4. Propose the minimal structural change that unblocks progress

**Best for:** Recurring bugs in different forms, simple changes touching many files, performance problems that can't be optimized away.

See: `references/architect.md`

### 5. Contrarian — "What if we're solving the wrong problem?"

**Philosophy:** The opposite of a great truth is often another great truth.

**Approach:**
1. List every assumption being made
2. Consider: what if the opposite were true?
3. Challenge the problem statement itself
4. Ask: what would happen if we did nothing?

**Best for:** Groupthink, assumed requirements that nobody questioned, "obvious" solutions that aren't working.

See: `references/contrarian.md`

## Auto-Selection Logic

When the user says "I'm stuck" without specifying a persona, classify the problem:

| Signal | → Persona |
|--------|-----------|
| Error message, constraint, "can't", "won't let me" | Hacker |
| "Don't understand", "unexpected behavior", "why" | Researcher |
| "Too complex", "too many", "overwhelming", scope words | Simplifier |
| "Keeps breaking", "touching everything", structural words | Architect |
| No clear signal, or "wrong approach", "step back" | Contrarian |

## Integration

- **After failed `three-stage-eval`**: If evaluation fails twice, suggest running unstuck
- **In swarm campaigns**: Add an unstuck step for tasks that exceed retry limits
- **With `spec-first-interview`**: If the interview reveals the original problem was wrong, use Contrarian to reframe
- **Manual**: User says "I'm stuck" or "unstuck" in conversation → activate this skill

## Limits

Lateral thinking questions *assumed* constraints, never real ones. No perspective, including the
Hacker, bypasses security controls, credentials, governance gates (`zouroboros-governance`),
operator approvals or a user's explicit instruction. If the only way forward crosses one of those,
say so and ask the user.
