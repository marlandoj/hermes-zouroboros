---
name: verity
description: Verity is a cross-harness done-gate built on Canny (qkal/Canny by Kal, MIT). It records every edit and check in Hermes, Claude Code, Codex CLI, Kimi Code and Gemini CLI, and refuses a "done" claim when code changed with no passing test, build, lint or type-check since; it also guards against secrets in written files, deleted tests and piped test commands. Defaults to shadow mode (log only); `scripts/verity.sh mode live` enforces, scoped per harness and per check. Use to install it, review verdicts, switch shadow/live, decide promotion, or disable it.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, verification, hooks, quality-gate, Zouroboros]
    related_skills: [destructive-op-guard, three-stage-eval, zouroboros-governance]
prerequisites:
  commands: [bash, jq, node, git]
---

# Verity

**Engine:** Canny by Kal (`qkal/Canny`, MIT), cloned by `install.sh` at pinned commit `f2c5e53` (v0.3.0); it is not vendored here. Credit it in anything public.

Paths below are relative to this skill directory.

## How it works

Every harness hook entry calls `scripts/verity-hook.sh <harness>`. The hook feeds the event to Canny so its ledger fills, logs any verdict, and applies the verdict only in live mode. Shadow mode always answers `{}`.

Two governance rules apply over the plain Canny hook (see `zouroboros-governance`):

- **Fail closed in live mode.** A missing, disabled, crashed or unreadable analyzer may not silently pass a finish or a governed tool call. In shadow mode every failure path answers `{}` (fail open).
- **The verdict ledger records decisions, not text.** File contents, shell commands and their output are reduced to a length before being written.

Jev (Canny's remote analyzer) is off in both modes: no key is passed to the child and its endpoint points at a dead port.

## Install

```bash
bash scripts/install.sh --dry-run                    # show what would happen
bash scripts/install.sh                              # clone Canny at the pin, print the Hermes hooks snippet
bash scripts/install.sh --harness hermes,claude --project /path/to/project
```

- **Hermes** (default): the installer only **prints** a `hooks:` snippet for the profile's `config.yaml` (`on_session_start`, `pre_tool_call` / `post_tool_call` for `terminal|write_file|patch`, and `pre_verify`). It never writes into a Hermes profile; merge the snippet yourself and approve the hooks on first use. A `done` block arrives as a `pre_verify` continue message, so the agent keeps working instead of finishing.
- **Claude Code / Codex CLI:** `<project>/.claude/settings.json` and `<project>/.codex/hooks.json`, merged idempotently with a backup.
- **Kimi Code / Gemini CLI:** user-global configs, translated through `scripts/adapter.mjs`.

Canny is cloned to `$CANNY_DIR` (default `$ZOUROBOROS_DATA_DIR/integrations/canny`); backups go to `$VERITY_HOME/backups`.

## Mode

The default is **shadow** everywhere. Switching to live is an operator decision; do not do it on your own.

```bash
bash scripts/verity.sh status
bash scripts/verity.sh mode live [--harness NAME] [--checks done,deny,ask,rewrite,note,warn]
bash scripts/verity.sh mode shadow [--harness NAME]
bash scripts/verity.sh reset [--harness NAME]
VERITY_MODE=shadow|live  VERITY_CHECKS=...  VERITY_DISABLE=1      # per-process overrides
```

Harness names: `hermes`, `claude`, `codex`, `kimi`, `gemini`. Config: `$VERITY_HOME/config.json` (default `$ZOUROBOROS_STATE_DIR/verity`), read on every hook call (no restart needed).

## Files

| Path | Holds |
|---|---|
| `~/.canny/sessions/*.jsonl` | Canny's ledger. Command lines can contain secrets (owner-only dir) |
| `$VERITY_HOME/verdicts.jsonl` | Every non-empty verdict with harness, mode, kind, `applied`, latency |
| `~/.canny/errors.log` | Canny crashes |

## Commands

```bash
bash test/run.sh                 # hermetic tests (temporary HOME, fake Canny)
bash scripts/report.sh           # verdicts, applied count, latency, crashes
node "$CANNY_DIR/dist/cli.js" status   # latest session ledger
```

## Promotion criteria

1. `done` blocks: sample each against its session. It is a false positive when the verification was something Canny doesn't count (a skill's own `bun …test.ts`, curl smoke tests); add those as `verify` regexes in a trusted `.canny.json` first.
2. `deny`: every one must be a real secret or test deletion. Promote first: `verity.sh mode live --checks deny`.
3. p50 under 250 ms per tool call, zero crashes.
4. Then add `done`.
