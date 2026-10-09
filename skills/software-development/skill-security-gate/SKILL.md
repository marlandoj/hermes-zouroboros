---
name: skill-security-gate
description: Security governance gate for AI agent skills, backed by NVIDIA SkillSpector. Statically scans a skill (local path, directory, zip, or Git URL) for 65 vulnerability patterns across 16 categories (prompt injection, data exfiltration, privilege escalation, supply chain, excessive agency, tool/MCP misuse, dangerous code via AST, YARA signatures) and returns a 0-100 risk score with a SAFE / REVIEW / DO_NOT_INSTALL recommendation. Use BEFORE adopting any third-party skill, and for the periodic baseline scan of the skills directories.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [software-development, security, supply-chain, skills, Zouroboros]
    related_skills: [destructive-op-guard]
prerequisites:
  commands: [bash, bun]
---

# Skill Security Gate

Pre-adoption + periodic security scanner for agent skills. Wraps the
**NVIDIA SkillSpector** CLI (an external tool installed separately with `uv tool`,
Apache-2.0; it is not vendored here). Hermes already scans skills it installs itself
(`hermes skills install`, hub sources); this gate covers everything else.

Paths below are relative to this skill directory.

## When to use

1. **Pre-adoption gate** — run before installing/adopting ANY third-party skill
   (Git URL, zip, or local clone). This is the primary, highest-value use.
2. **Baseline sweep** — periodic recursive scan of the distribution's `skills/` tree or
   the Hermes profile skills directory to catch drift.

## Commands

```bash
# Pre-adoption: scan a third-party skill before installing it
bash scripts/gate.sh <path-or-git-url>

# Baseline: recursive scan (dated JSON report)
bash scripts/gate.sh --skills [DIR]      # default: this distribution's skills/ tree
bash scripts/gate.sh --hermes-skills     # $HERMES_HOME/skills (default ~/.hermes/skills)
```

JSON reports go to `$SKILL_SECURITY_GATE_SCAN_DIR`, else
`$ZOUROBOROS_STATE_DIR/skill-security-gate/scans`. Without SkillSpector on `PATH`
(or in `$UV_TOOL_BIN_DIR`, default `~/.local/bin`) the gate prints install guidance and
exits 127.

### Governed lifecycle validation (default off)

Lifecycle validation is an optional additive check over a local skill directory and
its versioned lifecycle manifest. The checked-in and authorized default is `off`:
with no lifecycle options, `gate.sh` preserves the incumbent SkillSpector commands,
output, reports, and exit behavior and writes no lifecycle state.

```bash
# Advisory only: run SkillSpector, then validate the manifest without blocking
bash scripts/gate.sh \
  --lifecycle-mode shadow \
  --lifecycle-manifest /path/to/skill-lifecycle.json \
  /path/to/skill

# The environment variable is equivalent; the CLI flag overrides it
ZOUROBOROS_SKILL_LIFECYCLE_MODE=shadow \
  bash scripts/gate.sh \
  --lifecycle-manifest /path/to/skill-lifecycle.json \
  /path/to/skill
```

Allowed `ZOUROBOROS_SKILL_LIFECYCLE_MODE` / `--lifecycle-mode` values:

- `off` (default) — do not invoke the lifecycle gate; no lifecycle output or state.
- `shadow` — after the incumbent scan succeeds, run
  `bun scripts/lifecycle/gate.ts --manifest <json> --subject <directory>`.
  A lifecycle `HOLD`, `DENY`, missing manifest, or malformed manifest is emitted as
  advisory `WOULD_HOLD` evidence and never changes the incumbent scan result.
- `enforce` — require a manifest and a lifecycle `PASS`. Missing, malformed,
  `HOLD`, `DENY`, or otherwise unsuccessful evidence fails closed. Enforcement is
  implemented for later operator authorization but is **not activated by this seed**.

The shared lifecycle CLI emits JSON and exits `0` for `PASS`, `3` for `HOLD`, and
`4` for `DENY`. It is deterministic and does not invoke a model.

## Reading the score — IMPORTANT calibration note

SkillSpector's static (`--no-llm`) heuristics are tuned to be suspicious of
**untrusted** skills. They flag legitimate, expected behavior as risky:

- `subprocess.run(...)` / shell calls -> "Dangerous Code Execution"
- outbound `fetch`/`curl`/API calls -> "Data Exfiltration"
- file writes + tool use -> "Excessive Agency" / "Tool Misuse"

Because of this, **first-party trusted skills routinely score
CRITICAL** (e.g. `zo-swarm-orchestrator`) — that is noise,
not a real verdict. Treat the gate as a signal for **new / third-party** skills:

- **SAFE / LOW (0-29)** -> adopt.
- **REVIEW / MEDIUM-HIGH (30-69)** -> read the flagged findings; adopt only if
  each is explained by intended behavior.
- **DO_NOT_INSTALL / CRITICAL (70-100)** on an *unknown third-party* skill ->
  do not adopt without manual line-by-line review.

For high-stakes third-party adoptions, re-run with `gate.sh --llm <target>` (drops
`--no-llm`) and a provider key that SkillSpector supports for semantic confirmation.

## Supply-chain checks (deterministic, advisory)

The SkillSpector wrapper above lints skill **code**. The supply-chain gate covers
three surfaces it does NOT see — all deterministic (no LLM, no network by default):

```bash
# All three checks over the repo (advisory: prints + writes a report, exits 0)
bun scripts/supply-chain/gate.ts --root /path/to/repo

bun .../gate.ts --actions     # GitHub Action SHA-pin audit only
bun .../gate.ts --mcp         # MCP injection scan + inventory/policy only
bun .../gate.ts --strict      # exit 1 on any critical (or SUPPLY_CHAIN_ENFORCE=1)
bun .../gate.ts --resolve     # resolve mutable tags -> commit SHA via git ls-remote (network)
bun .../gate.ts --hermes-config  # also inventory mcp_servers from $HERMES_HOME/config.yaml
```

Scan root: `--root`, else `SUPPLY_CHAIN_ROOT`, else the current git checkout, else
`ZOUROBOROS_WORKSPACE`; with none of them the gate exits 2.

1. **action-pin-audit** — flags every `uses:` in `.github/workflows/*.yml` pinned to
   a mutable tag/branch instead of a 40-hex commit SHA (the TJ-Actions re-point
   vector) **[critical]**. `--resolve` fills in the exact SHA to pin to. Local `./`
   and `docker://` refs are skipped. Audit only — it never rewrites workflow files.
2. **mcp-inject-scan** — scans MCP tool **descriptions** and **local server source**
   for smuggled directives: imperative override ("ignore previous instructions") and
   exfil instructions **[critical]**, hidden/zero-width unicode **[warning]**,
   secret-keyword / long base64 in a description **[info]**. Calibrated so that
   normal env-reads / fetch calls in server *source* are NOT flagged (FP guard).
3. **mcp-inventory + policy** — enumerates every `.mcp.json` server (handles both the
   `mcpServers` and `servers` keys), classifies local-source vs third-party
   (uvx/npx/remote-url), and checks each against `mcp-policy.json`
   (`allow`/`restrict`/`approve`/`block`; unlisted ⇒ `approve`). block ⇒ critical,
   restrict ⇒ warning, approve ⇒ info, allow ⇒ silent.

**Posture:** advisory-first (exits 0 even with criticals) so it is safe in CI as a
visible signal; `--strict` / `SUPPLY_CHAIN_ENFORCE=1` is the operator opt-in. Reports
land in `$SUPPLY_CHAIN_REPORT_DIR`, else `$ZOUROBOROS_STATE_DIR/skill-security-gate/supply-chain`.
The shipped `mcp-policy.json` is an empty default (`approve` for everything). Record your
allow/block decisions per server in `$ZOUROBOROS_CONFIG_DIR/skill-security-gate/mcp-policy.json`
(or `--policy` / `SUPPLY_CHAIN_POLICY`); it uses the same shape.

## Optional terminal adoption hook

Hermes scans what `hermes skills install` fetches, but a terminal `git clone` or `cp -r`
into a skills directory bypasses that. `scripts/adoption-hook.ts` is a Hermes
`pre_tool_call` shell hook (matcher `terminal`) that closes the gap with offline checks:
remote or archive sources into a skills directory would block (quarantine, scan, then copy);
local copies get the action-pin, MCP and markdown directive scans plus the lifecycle gate.
Modes (`--mode` or `SKILL_SECURITY_GATE_HOOK_MODE`): `off` (default), `advisory` (logs
would-block decisions as JSON lines under `$ZOUROBOROS_LOG_DIR`), `enforce` (blocks).
It fails open on malformed input. Register it in the profile `config.yaml`:

```yaml
hooks:
  pre_tool_call:
    - matcher: terminal
      command: "bun /absolute/path/to/checkout/skills/software-development/skill-security-gate/scripts/adoption-hook.ts --mode advisory"
      timeout: 10
```

## Underlying tool

- Binary: `skillspector` (NVIDIA SkillSpector, Apache-2.0), installed by the operator:
  `uv tool install --python 3.12 <SkillSpector git URL or local clone>`; make sure
  `$(uv tool dir --bin)` is on `PATH`.
- Supply-chain checks: `scripts/supply-chain/` (Bun/TS, pure cores + `gate.ts` CLI).
- Tests: `bun test scripts/` (lifecycle, supply-chain and adoption hook).
