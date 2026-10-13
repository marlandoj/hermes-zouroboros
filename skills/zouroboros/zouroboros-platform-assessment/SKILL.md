---
name: zouroboros-platform-assessment
description: Assess the Zouroboros platform with evidence.
version: 1.0.0
author: Zouroboros
license: MIT
platforms: [linux]
metadata:
  hermes:
    category: zouroboros
    tags: [zouroboros, assessment, testing, reliability, security, audit]
    related_skills: [zouroboros-loop, zouroboros-loop-prescribe, zouroboros-install, rag-telemetry, graphrag-relational]
prerequisites:
  commands: [bun, python3, git, gh, curl, podman]
---

# Zouroboros Platform Assessment Skill

Runs a comprehensive, evidence-backed health assessment of the Zouroboros platform on the
current host. It covers components, integrations, end-to-end workflows, AI reliability, data
integrity, recovery, security and performance. The output is a test matrix, a defect register
and a final report. It never deploys, restarts services, changes production data or sends
messages, and makes model calls only within a budget the operator approves. It is the
**introspect** phase of the Zouroboros closed loop (`zouroboros-loop`).

## When to Use
- The operator asks to assess, audit or health-check Zouroboros, Hermes × Zouroboros, or "the
  platform" end to end.
- After major upgrades or deployments, to compare against the 2026-10-13 baseline in
  previous assessment directory in the profile workspace.
- To verify that defects from a previous assessment are fixed.

Not for a quick status check (use `workshop_status`) or for fixing defects (fixes are separate,
reviewed work).

## Prerequisites
- MCP servers: `codebase-memory` (graph-first code retrieval) and `zouroboros` (read tools
  `workshop_status`, `memory_search`, `factory_intake`).
- A deployed checkout (default `~/hermes-zouroboros`), Bun, Python 3, `gh` authenticated for
  `<owner>/*` (private repos), and a Node toolchain (`~/.hermes/tools/node-*/bin`; node is
  not on PATH by default).
- Operator decisions, collected in Phase 0: the execution mode, and the live model-call budget
  (none, or a bounded N calls with a dollar stop).
- `delegate_task` is used only if the operator approves read-only helpers.

## How to Run
Read `references/assessment-brief.md` (the original brief and the source of truth for scope)
and `references/procedure.md` (the step-by-step recipe) with `read_file` in full, then work
through the phases. Use `terminal` for commands and `write_file`/`patch` for the assessment
documents. Scripts live in this skill's `scripts/` folder:

| Script | Purpose | Model calls |
|---|---|---|
| `"${HERMES_SKILL_DIR}"/scripts/provenance-map.sh` | Map an untracked checkout to upstream commits, file by file | none |
| `"${HERMES_SKILL_DIR}"/scripts/mcp-e2e.ts` | MCP contract, E2E, redaction, concurrency and latency harness (scratch home) | none |
| `"${HERMES_SKILL_DIR}"/scripts/interrupt-test.sh` | Swarm cancellation test with a fake Hermes | none |
| `"${HERMES_SKILL_DIR}"/scripts/restore-drill.py` | SQLite online backup and disposable restore with integrity and row-count checks | none |
| `"${HERMES_SKILL_DIR}"/scripts/cors-probe.sh` | Cross-origin exposure of loopback services (GET and OPTIONS only) | none |
| `"${HERMES_SKILL_DIR}"/scripts/live-reliability.sh` | JSON validity, prompt injection, unsupported answers, credential echo | 18 (needs `ASSESS_ALLOW_LIVE=1`) |
| `"${HERMES_SKILL_DIR}"/scripts/rag-eval.ts` | Qdrant retrieval hit@1 and hit@5 | 1 embedding (needs `ASSESS_ALLOW_LIVE=1`) |
| `"${HERMES_SKILL_DIR}"/scripts/matrix-totals.py` | Recompute TEST-MATRIX totals; fails on rows without a status | none |

Copy `templates/` into a new `<workspace>/zouroboros-assessment-<date>/` before
Phase 0 ends.

## Quick Reference
- Statuses: PASS (observed evidence only), FAIL, BLOCKED, NOT TESTED, NOT APPLICABLE.
- Evidence labels: S static · I isolated · M mock/fake · L live read-only · E end-to-end
  with a real model.
- Scratch: `mktemp -d /tmp/zo-task-XXXXXX`. Delete it at the end, because it holds copies of
  live data.
- Times: America/Phoenix; add UTC only to correlate logs.
- Decision gate: `bun <repo>/packages/swarm/src/routing/swarm-decision-gate.ts --json "<scoped plan>"`.
- Baseline: the previous assessment's `REPORT.md`, `TEST-MATRIX.md` and `DEFECTS.md`, if any.

## Procedure
1. **Phase 0, rules and gates.** Read the AGENTS.md rules and identify the host. Check graph
   freshness with `index_status` and the operation window (if installed). Score the scoped plan
   with the decision gate. Ask the operator for the execution mode and model-call budget. Write
   `PROGRESS.md`.
2. **Phase 1, discovery.** Run `provenance-map.sh`. If approved, start three read-only helpers
   via `delegate_task` using `references/helper-prompts.md`. Build the component inventory with
   a denominator.
3. **Phase 2, matrix.** Start from `templates/TEST-MATRIX.md` (baseline rows) and add rows for
   new components.
4. **Phase 3A, build.** Copy the checkout to scratch. Run the frozen install, build,
   `tsc --noEmit` and all test suites; record exit codes. Diff the live `dist/` against a fresh
   build.
5. **Phase 3B/C, contract and E2E.** Run `mcp-e2e.ts`. Do the live read-only factory intake
   with checksums before and after. Call the live MCP read tools. Check Kanban stale claims
   with read-only SQL. Verify timers against their data. Run the reachability check for every
   store kept fresh.
6. **Phase 3D, AI reliability (budget only).** Run a live swarm DAG through a scratch home
   whose profile is symlinked, never copied. Run the timeout and bad-model probes, then
   `live-reliability.sh`. Log every call in `model-calls.tsv`.
7. **Phase 3E/F, integrity and recovery.** Run the concurrency check (C-31), `restore-drill.py`
   plus consumer checks, the disposable Qdrant restore, the outage probes, and
   `interrupt-test.sh`.
8. **Phase 3G/H, security and performance.** Run the shell-injection marker test, the
   redaction checks, `cors-probe.sh`, and the permission and dump-masking checks. Measure
   latency baselines, run `rag-eval.ts`, and check whether failures are diagnosable and alerted.
9. **Loop handoff (when run by `zouroboros-loop`).** Give `zouroboros-loop-prescribe` the
   assessment directory. When re-assessing after a merged loop PR, re-test the prescription's
   defect IDs and cite the matrix rows, so the orchestrator can record `confirmed` or
   `regressed`.
10. **Phase 4, report.** Write the defect register (re-test baseline IDs), run
   `matrix-totals.py` and write `REPORT.md` with all 13 sections. Prove the live checkout and
   data are unchanged, move cited raw outputs into `evidence/`, delete scratch, and mark
   `PROGRESS.md` complete with the operator decisions still needed.

## Pitfalls
- Building or testing inside the deployed checkout rewrites the `dist/` that live MCP servers
  load. Always use a scratch copy.
- Running `hermes kanban` against the live board may migrate its schema and break intake's
  fingerprint check. Copy the board first.
- Copying `auth.json` into a scratch profile can rotate the OAuth refresh token and break the
  real profile.
- A Claude executor session has a private `HOME`. Set the real `HOME`, `XDG_RUNTIME_DIR` and
  the D-Bus address before running Hermes, `systemctl --user` or `podman`.
- `pkill -f` patterns match the shell that runs them. Kill by PID from a script.
- Treat helper reports as hypotheses. Reproduce before citing.
- One successful model response is not reliability evidence. Report sample sizes.
- Backups that exist but have never been restored do not pass.

## Verification
- `TEST-MATRIX.md` totals come from `matrix-totals.py` and every row has a status.
- Every FAIL row links a defect, and every defect has reproduction steps and an acceptance check.
- `REPORT.md` states coverage against the component and workflow denominators, and lists what
  remains unverified.
- `find <checkout> -newer <start-marker>` lists no files. Scratch is deleted and `PROGRESS.md`
  says COMPLETE.
