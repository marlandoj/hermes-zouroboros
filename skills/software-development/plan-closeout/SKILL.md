---
name: plan-closeout
description: "Mechanized Definition of Done for an implementation plan. Runs four gates over a change set and emits one consolidated pass/fail report: (1) EVAL, the deterministic checks (tests/compile/dry-run), a hard gate and the real correctness guarantee; (2) GAP AUDIT, a wire-what-you-build scan for placeholder/stub markers and declared-but-unreferenced functions/exports (advisory); (3) CONSENSUS, an optional external multi-model reviewer per changed file, off unless one is configured (advisory; mine the findings, not the verdict); (4) COMPLEXITY, a single-axis over-engineering review per changed file via ponytail-review (advisory ONLY, never gates). A Hermes pre_verify hook sends the agent back once to close out an armed plan. Use at the end of every plan so closeout does not depend on remembering to do it."
version: 1.1.0
license: MIT
metadata:
  hermes:
    tags: [software-development, verification, hooks, definition-of-done, Zouroboros]
    related_skills: [ponytail-review, ask-governor, three-stage-eval, spec-first-interview]
prerequisites:
  commands: [python3, git, jq]
---

# Plan Closeout

A single command that runs the **Definition of Done** for a finished plan and
prints one report. It exists so the closeout (eval + gap audit + optional
consensus + complexity) is mechanized rather than dependent on the agent
remembering each gate.

## Philosophy (read before trusting the output)

The four gates are **not** equal:

1. **EVAL is the guarantee.** The deterministic checks a change declares —
   unit tests, `py_compile`/`tsc`, A/B parity, an end-to-end dry run — are the
   real correctness signal. This is the only **hard gate**: if any eval command
   exits non-zero, the closeout fails (exit 1).
2. **GAP AUDIT is advisory.** It catches the common wire-what-you-build misses:
   stub/placeholder markers and top-level functions/exports that nothing
   references. Some flagged exports are intentional public APIs or future hooks
   — confirm each, don't blindly delete.
3. **CONSENSUS is optional and advisory — mine the findings, not the verdict.**
   The distribution ships no consensus reviewer, so this phase is **off by
   default**. It runs only when you pass an external reviewer with
   `--consensus-gate PATH` (or `consensus_gate` in a manifest); see
   [External consensus reviewer](#external-consensus-reviewer). Multi-model
   panels degrade (reviewers abstain or return unparseable output), so an
   `ESCALATE` usually just means the panel degraded and a `REJECT` is a prompt
   to look, not a veto. Resolve substantive findings; ignore infra/format noise.
4. **COMPLEXITY is advisory ONLY — suggestions, never failures.** A single-model
   `ponytail-review` pass per changed file hunts one axis: over-engineering
   (reinvented stdlib, dead flexibility, speculative abstractions). It is
   **silent on bugs and security by design**, so it complements a correctness
   review, never replaces it. It **never** affects the exit code — not even
   under `--strict`. One model call per file. Cut what is genuine, ignore the rest.

So the target is **"all deterministic checks pass + every substantive review
finding resolved"** — never "100% green from the gate." COMPLEXITY suggestions
are a bonus cleanup list, not part of the bar.

## Usage

```bash
python3 "${HERMES_SKILL_DIR}/scripts/closeout.py" [options]
```

The repository root defaults to the git top level of the current directory
(else `$ZOUROBOROS_WORKSPACE`); pass `--cwd DIR` to close out another checkout.
The change set defaults to your uncommitted work (git status, incl. untracked).
Override or narrow it with `--file` (repeatable) or extend it with `--base`.

Key options:

- `--file PATH`        Explicit file in the change set (repeatable). If given,
                       only these are audited/reviewed.
- `--base REF`         Also include files in `git diff REF...HEAD`.
- `--eval "CMD"`       A deterministic check (repeatable). **Hard gate.**
- `--manifest J.json`  `{ "eval": [...], "criteria": "...", "files": [...],
                       "consensus_gate": "path", "consensus": true|false,
                       "complexity": true|false }` — declare the checks once.
- `--cwd DIR`          Repository root (default: git top level of the cwd).
- `--consensus-gate PATH`  Optional external consensus reviewer. Without it the
                       CONSENSUS phase is skipped.
- `--criteria STR`     Consensus review criteria (default
                       `correctness,security,wiring`).
- `--no-consensus`     Skip consensus even if a gate is configured.
- `--no-arbiter`       Do not pass `--arbiter` to the consensus gate.
- `--consensus-cap N`  Max files sent to consensus (default 5; cost guard).
- `--no-complexity`    Skip the complexity (ponytail-review) phase.
- `--complexity-cap N` Max files sent to complexity review (default 5; cost guard).
- `--complexity-review PATH`  Override the review script (default: the sibling
                       `ponytail-review` skill's `scripts/ponytail-review.ts`).
- `--strict`           Also exit non-zero (2) if the **gap audit or consensus**
                       flags. COMPLEXITY is excluded — it never gates.
- `--json`             Emit the report as JSON instead of text.
- `--arm "LABEL"`      Mark a plan active for this repository (write the
                       `PLAN_ACTIVE` sentinel) and exit.
- `--disarm`           Clear the sentinel without running gates (abandon a plan).
- `--status`           Print the sentinel state for this repository as JSON.

### Typical closeout

```bash
python3 "${HERMES_SKILL_DIR}/scripts/closeout.py" \
  --file path/to/changed.ts \
  --eval "bun test path/to/test.ts" \
  --eval "bun build path/to/changed.ts --target=bun --outfile=/dev/null"
```

### Exit codes

| code | meaning |
|------|---------|
| 0    | closeout OK — eval passed (advisory gap/consensus/complexity findings may still exist) |
| 1    | EVAL failed (a declared check did not pass) — hard gate |
| 2    | `--strict` and the gap audit or consensus flagged (complexity never gates) |
| 64   | usage / configuration error (not a git repo, empty change set, bad manifest) |

## Enforcement (the Hermes `pre_verify` hook)

The skill does not rely on the agent *remembering* to close out. A plan is
**armed** with `closeout.py --arm "LABEL"`, which writes a `PLAN_ACTIVE`
sentinel for the repository under
`$ZOUROBOROS_STATE_DIR/plan-closeout/<key>/`. The key is a hash of the resolved
repository root, so separate workspaces never share a gate. Without
`ZOUROBOROS_STATE_DIR` the state falls back to
`${HERMES_ZOUROBOROS_HOME:-${XDG_DATA_HOME:-~/.local/share}/hermes-zouroboros}/state`.

`scripts/closeout-verify-hook.sh` is a Hermes shell hook for the `pre_verify`
event. Hermes fires that event once per turn when the agent has edited files and
is about to finish. The hook checks the repository of the payload `cwd` and of
every changed path. If a plan is armed there, it answers
`{"decision":"block","reason":...}`, which Hermes turns into a continue
directive carrying the exact closeout command. It answers only the first
`pre_verify` of a turn (`extra.attempt == 0`), so it nudges once rather than trap
the agent in a loop. It fails open on any error, and a turn with no file edits
is never nudged, because Hermes does not fire `pre_verify` for it.

The sentinel is cleared **only** by a closeout run whose deterministic `--eval`
gate passed (a no-eval run leaves it set, so it can't be bypassed). To walk away
from a plan without closing out, `--disarm`.

Register the hook in the profile's `config.yaml`. Hermes asks for consent on
first use (or set `hooks_auto_accept: true` for unattended gateways):

```yaml
hooks:
  pre_verify:
    - command: "/absolute/path/to/checkout/skills/software-development/plan-closeout/scripts/closeout-verify-hook.sh"
      timeout: 15
```

`agent.max_verify_nudges` (default 3) bounds all `pre_verify` continues in a
turn. Rollback: remove the entry; nothing else depends on it.

**Arming.** Hermes has no plan-approval event to hook (there is no equivalent of
an `ExitPlanMode` tool call), so there is no automatic arming hook. Arm
explicitly when a plan is agreed, as the first step of executing it:

```bash
python3 "${HERMES_SKILL_DIR}/scripts/closeout.py" --arm "short plan label"
```

## External consensus reviewer

Any script you trust can serve as the consensus gate. It is run with `bun` as

```text
bun <gate> validate --file <abs path> --criteria <criteria> --label closeout:<rel> [--arbiter]
```

and its stdout is parsed for `Consensus: PASSED|REJECTED|ESCALATE`, an
`ID: <id>` line, `<n> reviewer(s) abstained`, and `• <finding>` bullets
(infra noise such as empty responses or API errors is dropped). The closeout
never ships, configures or calls a reviewer by itself. A missing gate path is a
warning and the phase is skipped.

## Notes

- On a large/dirty working tree, pass `--file` explicitly — the git-derived
  change set walks all untracked files and can be slow.
- The reference corpus for orphan detection is built once from tracked +
  untracked-not-ignored source files (`.ts/.tsx/.js/.mjs/.py/.sh`), then reused.
- Tests: `python3 "${HERMES_SKILL_DIR}/scripts/test-closeout.py"` (33 checks,
  all in temp dirs: consensus-output parsing, eval gate semantics, gap audit over
  a temp-repo fixture, complexity parsing + advisory wiring, the per-repository
  sentinel, an end-to-end arm/close cycle and the `pre_verify` hook).
- The complexity phase shells out to `ponytail-review.ts` via `bun`. That review
  makes one governed model call per file through `ask-governor`, using the
  hermes-zouroboros profile's executor and model. Without a usable profile it
  reports a per-file skip note and contributes nothing — it can never break a
  closeout. Pass `--no-complexity` for an offline closeout.
