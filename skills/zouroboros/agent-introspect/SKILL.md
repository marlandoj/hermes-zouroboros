---
name: agent-introspect
description: "Weekly self-audit of the distribution's skill tree, workspace identity files and script health: checks every SKILL.md, probes each skill script's --help under a bounded retry budget, and optionally compares a persona registry with a caller-supplied snapshot without changing anything. Use when running or scheduling the skills audit, investigating its findings, or changing its skip list."
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [Zouroboros, self-improvement, audit, skills]
    related_skills: [agent-doctor, zouroboros-introspect, operator-digest]
prerequisites:
  commands: [python3, bun, bash]
---

# Agent Introspect

A version-controlled, hardened skills audit. It writes a markdown report and an atomic status
file, takes a concurrency lock, and never changes the skills it audits.

```bash
# Normal run: report + status file under $ZOUROBOROS_STATE_DIR/agent-introspect/
python3 "${HERMES_SKILL_DIR}/scripts/introspect.py"

# Read-only findings as JSON (no report, status file or lock)
python3 "${HERMES_SKILL_DIR}/scripts/introspect.py" --findings-only

# Tests
python3 "${HERMES_SKILL_DIR}/scripts/test_introspect.py"
python3 "${HERMES_SKILL_DIR}/scripts/test_persona_audit.py"
```

## What it checks

1. **Skills:** every `SKILL.md` under the skills tree (category directories are nested) for an
   empty `description:`. It also flags a `scripts/` directory with no runnable file
   (`.ts/.py/.sh/.mjs/.js`).
2. **Identity:** `AGENTS.md` present in the workspace (`ZOUROBOROS_WORKSPACE`, else the current
   directory). Files in `IDENTITY/` older than 30 days are flagged if that directory exists.
3. **Script health:** probes each skill script with `--help` (`.ts→bun --no-install`,
   `.py→python3`, `.sh→bash`, stdin closed). Exit codes outside `{0,1}` and timeouts are flagged.
   Files named in `config.json:skip_health` are skipped.
4. **Persona registry (optional):** `persona_audit.py` compares a caller-supplied snapshot with a
   registry file by immutable ID. It reports missing or live-only records, name/model/scope
   drift, duplicate IDs or slugs, malformed input, and model IDs absent from an optional catalog.

```bash
python3 "${HERMES_SKILL_DIR}/scripts/persona_audit.py" \
  --registry registry.json --snapshot live-personas.json [--model-catalog models.json]
```

The persona checker has no API client and no apply path. It reads the explicit files and prints
one JSON result: exit `0` clean, `2` drift, `1` malformed or unavailable input. Entries marked
`redacted: true` keep their ID but skip only the name comparison.

## Locations

| What | Default | Override |
|---|---|---|
| skills tree | the tree this skill ships in | `AGENT_INTROSPECT_SKILLS_DIR` |
| report + status + lock | `$ZOUROBOROS_STATE_DIR/agent-introspect/` | `AGENT_INTROSPECT_REPORTS_DIR` |
| identity directory | `<workspace>/IDENTITY` | `AGENT_INTROSPECT_IDENTITY_DIR` |

`ZOUROBOROS_STATE_DIR` falls back to the profile's `state/` directory.

## Architecture hotspots (advisory)

If `CODEBASE_MEMORY_BIN` points at a `codebase-memory-mcp` binary and
`AGENT_INTROSPECT_ARCH_PROJECTS` lists indexed projects (comma-separated), the report gains an
appendix: top fan-in functions and lowest-cohesion clusters. It is context, not a finding. It
never changes the findings count or exit code. Without them the report carries a one-line note.

## Contract (for a scheduled job)

- Delete `.introspect-status.json` before the run and require it afterwards. A missing file
  means ERROR.
- **Exit codes:** `0` OK, `1` ERROR, `3` PARTIAL (budget exhausted), `4` another run holds
  the lock. PARTIAL and ERROR are non-zero.
- **Status keys:** `status, exit_code, findings, report, partial_reason, unprobed,
  unprobeable_ext, error, ran_at`.
- **Delivery:** schedule it with Hermes cron and let the job's delivery report ERROR or
  PARTIAL always, and OK only when `findings > 0`.

## config.json

Every key is validated, and any failure is an ERROR. There are no defaults and no fail-open.

| key | meaning | range |
|---|---|---|
| `version` | config schema version | must equal 1 |
| `probe_timeout_s` | per-attempt `--help` timeout | 1..120 |
| `retries` | extra attempts on timeout only | 0..3 |
| `audit_budget_s` | global monotonic deadline | 60..3600 |
| `max_timeouts` | timeout events before retries disable | 1..100 |
| `skip_health` | filenames skipped by the health probe | list, no dups |

Changing `skip_health` means editing both `config.json` and `FROZEN_SKIP_HEALTH` in
`test_introspect.py`, so the skip list cannot drift silently. It currently skips only
`update-check.sh`, whose purpose is a network update check.

## Hardening notes

- **No spoofing.** Probe output is captured, never echoed, so a probed script cannot spoof
  the status.
- **Bounded retries.** Retry is timeout-only, with one timeout event per script.
- **No silent passes.** A missing interpreter becomes a finding. Unprobeable files
  (`.mjs/.js`) are counted and listed.
- **No secrets.** None are read, passed on argv or logged.
