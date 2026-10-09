---
name: repo-drift-autofix
description: "Repo drift remediation: clusters uncommitted files by branch scope, runs a secret/large-file scan and a tsc quality gate, commits only the in-scope clusters, pushes the feature branch and opens a draft GitHub PR. Refuses protected and spent branches. Use when a feature branch has accumulated uncommitted work that should be preserved as a reviewable draft PR; --dry-run to preview."
version: 1.0.0
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [devops, git, github, drift, Zouroboros]
    related_skills: [github]
prerequisites:
  commands: [bun, git, gh]
---

# repo-drift-autofix

## Usage

```bash
# Preview: classify drift and run the checks, change nothing in git or on GitHub
bun "${HERMES_SKILL_DIR}/scripts/autofix.ts" --repo /path/to/repo --dry-run

# Commit in-scope clusters, push the branch, open a draft PR
bun "${HERMES_SKILL_DIR}/scripts/autofix.ts" --repo /path/to/repo
```

`--repo` defaults to the current directory. `--help` prints usage and does nothing else.

**Output:** a JSON result on stdout. One audit line per run is appended to
`$ZOUROBOROS_LOG_DIR/repo-drift-autofix.log` (override: `REPO_DRIFT_AUTOFIX_LOG`). When
`ZOUROBOROS_LOG_DIR` is unset, the log goes to `logs/` in the hermes-zouroboros profile data
directory.

Run it on demand, or from a scheduled job or drift monitor of your own. It sends no
notifications; the caller reads the JSON result.

## What it does

1. **Branch guards** — refuses detached HEAD, `autoloop/*` and protected branches (`main`,
   `master`, `develop`, `release`), and skips a branch whose PR has already merged (a "spent" branch).
2. **Clusters** uncommitted files (including files inside untracked directories) by their top two
   directories (`packages/swarm`, `skills/devops`, ...).
3. **Scope-matches** clusters against the branch name tokens (e.g. `feat/swarm-t3-refactor` →
   `swarm`, `refactor`; tokens shorter than three characters are ignored).
4. **Safety scan** — blocks if any in-scope file exceeds 5MB or matches a secret pattern.
5. **Quality gate** — when the repo has a root `tsconfig.json`, runs the locally installed
   `tsc --noEmit` (via pnpm, bun or `npx --no-install`) with a 120s timeout and aborts on failure.
   It never downloads a compiler. Repos without a root `tsconfig.json` skip the gate and say so in
   `qualityGateNote`.
6. **Commits** each in-scope cluster with a template message (`git commit -F -`, no shell).
7. **Pushes** the branch to `origin`.
8. **Opens a draft PR** with `gh pr create --draft`, or reports the existing PR for the branch.
9. **Outliers** (clusters outside the branch scope) stay uncommitted and are listed in the JSON
   result and the PR body.

`--dry-run` stops after step 5: it reports the in-scope clusters (`skippedReason: "dry-run"`)
and outliers, and its only write is the audit line in the log directory. It still makes the
read-only `gh pr list` call for the spent-branch check.

## Safety guarantees

- Never commits to `autoloop/*` or protected branches.
- Never merges; only creates draft PRs.
- Aborts if TypeScript fails.
- Blocks secrets and large files.
- Every git and gh call uses an argument vector, never a shell string.
- Kill switch: `REPO_DRIFT_GITHUB_WRITES_DISABLED=1` (or the shared
  `ZOUROBOROS_GITHUB_WRITES_DISABLED=1`) blocks every `git push` and `gh` write and records the block
  in the audit log. Local commits still happen; use `--dry-run` to avoid those too.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success, nothing to do, or a policy skip (reason in the JSON `error` field) |
| 1    | Unrecoverable error (missing repo path, etc.) |
| 2    | Usage error |
