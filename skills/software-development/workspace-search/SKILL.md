---
name: workspace-search
description: "Bounded exact content or filename search inside a configured workspace root, with enforced ignore rules, result caps, an internal deadline, process-group cleanup, partial results and query-hashed telemetry. Use when an exact text, configuration or freshness check is needed and the agent's own search tools or an index cannot answer it."
version: 1.0.0
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [software-development, search, ripgrep, Zouroboros]
    related_skills: []
prerequisites:
  commands: [bun, rg]
---

# Workspace Search

Prefer the agent's built-in file search, or a code index if one is configured, for structure,
callers and definitions. Use this skill for exact or unindexed searches that need a hard deadline
and a result cap.

## Allowed root

Every search is confined to one allowed root, resolved in this order:

1. `--allowed-root <dir>`
2. `WORKSPACE_SEARCH_ROOT`
3. `ZOUROBOROS_WORKSPACE`

If none is set, the command refuses to run and exits `2`. It never falls back to `/`, `HOME` or
the current directory, because a silent default would turn a bounded search into an unbounded one.
Both the allowed root and `--root` are resolved with `realpath` before the containment check, so a
symlink inside the allowed root that points outside it is rejected (exit `2`).

## Run

```bash
bun "${HERMES_SKILL_DIR}/scripts/workspace-search.ts" \
  --root "$ZOUROBOROS_WORKSPACE/<smallest-known-directory>" \
  --query '<pattern>' \
  --kind content
```

Use `--kind filename` to locate files. Add `--include '<glob>'`, repeatable
`--exclude '<glob>'`, `--ignore-case`, or `--regex` only when required.

The command:

- rejects roots that do not resolve inside the allowed root;
- excludes dependency, build and cache directories, and also applies `<allowed root>/.ignore` when present;
- defaults to a 30-second deadline and 200 results;
- terminates the full ripgrep process group on timeout or result cap;
- emits JSON with `status`, `partial`, `results`, and phase telemetry;
- appends query-hashed telemetry (the query text is not stored) to
  `$ZOUROBOROS_LOG_DIR/workspace-search.jsonl`. When `ZOUROBOROS_LOG_DIR` is unset this falls back
  to `logs/` in the hermes-zouroboros profile data directory. Override the file with `--log-file`
  or disable it with `--no-log`.

Always inspect `status`. A `timeout` result is partial and exits `124`; keep its
results, narrow the root or include glob, and retry once. Do not replace it with
an unscoped search of the whole workspace. `error`, a missing `rg`, and a rejected root exit `2`.
