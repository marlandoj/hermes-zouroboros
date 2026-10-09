---
name: ponytail-review
description: Code review focused exclusively on over-engineering. Finds what to delete - reinvented standard library, unneeded dependencies, speculative abstractions, dead flexibility. One line per finding - location, what to cut, what replaces it. Use when the user says "review for over-engineering", "what can we delete", "is this over-engineered", "simplify review", or invokes /ponytail-review. Complements correctness-focused review, this one only hunts complexity.
version: 1.0.0
license: MIT
metadata:
  upstream: https://github.com/DietrichGebert/ponytail
  upstream_version: 4.7.0
  hermes:
    tags: [code-review, simplification, Zouroboros]
    related_skills: [ponytail-audit, ponytail-debt, ask-governor]
prerequisites:
  commands: [bun]
---

Review diffs for unnecessary complexity. One line per finding: location, what
to cut, what replaces it. The diff's best outcome is getting shorter.

## Format

`L<line>: <tag> <what>. <replacement>.`, or `<file>:L<line>: ...` for
multi-file diffs.

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Examples

❌ "This EmailValidator class might be more complex than necessary, have you
considered whether all these validation rules are needed at this stage?"

✅ `L12-38: stdlib: 27-line validator class. "@" in email, 1 line, real validation is the confirmation mail.`

✅ `L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`

✅ `repo.py:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.`

✅ `L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`

✅ `L30-44: shrink: manual loop builds dict. dict(zip(keys, values)), 1 line.`

## Scoring

End with the only metric that matters: `net: -<N> lines possible.`

If there is nothing to cut, say `Lean already. Ship.` and stop.

## Boundaries

Complexity only, correctness bugs, security holes, and performance go to a
normal review pass, not this one. A single smoke test or `assert`-based
self-check is the ponytail minimum, not bloat, never flag it for deletion.
Does not apply the fixes, only lists them.
"stop ponytail-review" or "normal mode": revert to verbose review style.

## Mechanized (scripted pass)

The ruleset is also available as a single-model pass that emits machine-readable findings:

```bash
bun "${HERMES_SKILL_DIR}/scripts/ponytail-review.ts" --file <path> --json
git diff | bun "${HERMES_SKILL_DIR}/scripts/ponytail-review.ts" --stdin --json
```

It is **advisory only**: it never fails its caller. A model or parse error is reported as an
empty review with a `note`. It makes one model call per file, through `ask-governor`, which uses
the hermes-zouroboros profile's executor registry (default `hermes-vps`). The provider and
credentials come from the Hermes profile. The model is the profile's model unless `--model`
or `PONYTAIL_REVIEW_MODEL` is set. The script needs a hermes-zouroboros checkout with an
initialized profile.

Use it alongside a correctness review, never as a replacement.
