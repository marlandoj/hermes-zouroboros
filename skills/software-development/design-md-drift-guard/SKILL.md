---
name: design-md-drift-guard
description: "Audit + self-healing pipeline for brand DESIGN.md files. Lints each configured DESIGN.md against the Google Labs design.md spec, diffs declared color tokens against live site CSS, plans (and, when asked, applies or PRs) mechanical OKLCH approximation fixes, and surfaces judgment-call findings (WCAG, missing slots, rogue hexes) for human review. Also includes a personal-detail leak scan for marketing copy."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, design-systems, brand, CSS, Zouroboros]
    related_skills: []
prerequisites:
  commands: [bun, npx, git]
---

# design-md-drift-guard

Keeps brand DESIGN.md files and live site code in sync. Every brand that ships a DESIGN.md
implicitly promises that the site's Tailwind/CSS tokens match it — this skill catches the moment
they stop matching, and remediates the safe cases.

## Configure

List the projects to audit in `$ZOUROBOROS_CONFIG_DIR/design-md-drift-guard/projects.json`
(override: `DESIGN_DRIFT_PROJECTS`). Start from `config/projects.example.json`:

```bash
mkdir -p "$ZOUROBOROS_CONFIG_DIR/design-md-drift-guard"
cp "${HERMES_SKILL_DIR}/config/projects.example.json" "$ZOUROBOROS_CONFIG_DIR/design-md-drift-guard/projects.json"
```

Each record maps a DESIGN.md to its site CSS file(s) with absolute paths; `exemptScopes` lists
CSS selectors whose colors are deliberately off-spec. Reports go to
`$ZOUROBOROS_STATE_DIR/design-md-drift-guard/reports/` (override: `DESIGN_DRIFT_REPORTS_DIR`).
When the `ZOUROBOROS_*` variables are unset, both fall back to the hermes-zouroboros profile data
directory. Nothing is written inside the skill directory.

## What it checks

For every configured DESIGN.md:

1. **Spec lint** — `npx -y @google/design.md lint` (errors, warnings, WCAG contrast). The first
   run downloads that package from npm.
2. **Token drift** — declared hex colors vs hex colors actually used in the configured site CSS.
3. **Orphan tokens** — tokens in DESIGN.md not referenced by the live site (warn).
4. **Rogue tokens** — hex values in site CSS that don't appear in DESIGN.md (warn).

## Pipeline

```
drift-guard.ts  →  auto-heal.ts  →  orchestrate.ts
   (audit)        (planner+applier)   (digest, optional PR)
```

### `drift-guard.ts` — audit only
Lints + diffs. Writes `drift-YYYY-MM-DD.{md,json}` to the reports directory. Read-only for
project files.

- `--json` — machine-readable output
- `--fail-on-error` — exit non-zero if any DESIGN.md has lint errors or drift (for CI)
- `--project <slug>` — check one project only

### `auto-heal.ts` — planner + applier
Reads the guard JSON. For each `declaredOnly` finding (a hex declared in DESIGN.md but absent
from the live CSS), checks whether a CSS variable defined as `oklch(...)` renders to within
**5 RGB units** of the spec hex. If so, it's a mechanical encoding drift and the planner emits an
edit that swaps the OKLCH for the literal hex. Findings outside that window become **judgment
calls** for a human (approximation drift, ambiguous matches between multiple declared colors,
missing slots, WCAG warnings, large rogue-hex sets).

```bash
bun "${HERMES_SKILL_DIR}/scripts/auto-heal.ts"            # dry-run plan
bun "${HERMES_SKILL_DIR}/scripts/auto-heal.ts" --apply    # write edits in place (operator approval first)
bun "${HERMES_SKILL_DIR}/scripts/auto-heal.ts" --json     # machine-readable
```

Defensive: skips any file using `oklch(from var(...))` derived colors — those are spec-relative
and not safe to mechanically rewrite.

### `orchestrate.ts` — digest, optional PR
Per project: runs the planner and prints a markdown digest (also written as
`orchestrate-YYYY-MM-DD.md` in the reports directory). By default it changes nothing.

With `--open-pr`, for projects with mechanical edits it creates an isolated `git worktree` in
the temp directory off `origin/<default branch>`, applies the edits there, commits, pushes a
`drift-guard-autoheal-<date>` branch and opens a PR with `gh`. The user's checkout is never
touched and the worktree is removed on every code path. It never merges. Pushing and opening a
PR are outward-facing: run `--open-pr` only with the operator's approval.
`DESIGN_DRIFT_GITHUB_WRITES_DISABLED=1` forces plan-only mode.

```bash
bun "${HERMES_SKILL_DIR}/scripts/orchestrate.ts"                    # plan + digest
bun "${HERMES_SKILL_DIR}/scripts/orchestrate.ts" --open-pr          # also open PRs
bun "${HERMES_SKILL_DIR}/scripts/orchestrate.ts" --project <slug>
```

Judgment calls are listed in the digest as-is; deliver the digest to the operator through the
profile's normal channel (email drafts need the operator's approval to send).

## Tolerance design

| RGB distance | Classification | Action |
|---|---|---|
| ≤ 5 | mechanical encoding drift | auto-heal plan (apply / PR on request) |
| 6 – 35 | approximation drift | judgment call |
| > 35 | unrelated; missing slot | judgment call |

The 5-unit window is conservative — only fires for OKLCH approximations that are perceptually
identical to the spec hex. Anything visually distinguishable stays a human call.

## Personal-detail leak scan

`scripts/pii-leak-scan.ts [--json] [--project <slug>]` scans copy, posts, drafts, blog and
marketing Markdown under `<workspace>/Projects/*` (workspace: `ZOUROBOROS_WORKSPACE`, else the
current directory) for personal identifiers that should not appear in public material. The
shipped `config/pii.json` holds placeholders only; copy it to
`$ZOUROBOROS_CONFIG_DIR/design-md-drift-guard/pii.json` (override: `DESIGN_DRIFT_PII_CONFIG`) and
put the real patterns there. Surface only: it never edits, and always exits 0.

## Scheduling

To run weekly, schedule `orchestrate.ts` (plan-only) with `hermes cron` and have the job
deliver the digest. All logic lives in this skill; PRs are reviewed and merged manually.
