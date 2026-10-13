# Zouroboros platform assessment — procedure

Implements `assessment-brief.md`. If a previous assessment exists in the workspace, use its
`REPORT.md`, `TEST-MATRIX.md` and `DEFECTS.md` as the baseline to compare against, and re-test its
defect IDs first.

Paths below assume user `hermes` and the workstation layout; resolve them on the host in Phase 0
instead of trusting them.

## Non-negotiable rules
- PASS needs observed evidence. Label every result S (static), I (isolated), M (mock/fake),
  L (live integration, read-only), E (end-to-end with a real model).
- Never build, test or mutate inside the deployed checkout or live data. Copy to
  `mktemp -d /tmp/zo-task-XXXXXX` first. The live MCP servers load the checkout's `dist/`.
- Live services: GET/OPTIONS and read-only SQLite (`mode=ro`, `query_only`) only.
  Record checksum and mtime before/after any live read that matters.
- Never print secrets; report variable names, counts and file modes. Use synthetic fixtures for
  credential tests.
- Never copy an OAuth `auth.json` into a scratch profile (refresh-token rotation can break the
  real profile). Use the real profile in place and keep data stores in scratch.
- Helper-agent findings are hypotheses until reproduced. Mark them `[H]` in evidence.
- Compute totals with `scripts/matrix-totals.py`; never hand-count.
- Display times in America/Phoenix; add UTC only when correlating logs.

## Phase 0 — Scope, rules, gates (before any work)
1. Read the rules: local `AGENTS.md` files, the workspace `AGENTS.md`
   (`gh api repos/<owner>/zouroboros-workspace/contents/AGENTS.md -H 'Accept: application/vnd.github.raw'`),
   project `PROGRESS.md`, `README.md`, `docs/`.
2. Identify the host: `hostnamectl`, `uptime`, which of the Zo-host / VPS layout markers named in
   the workspace `AGENTS.md` exist (Zo host / VPS vs workstation), the parent process
   chain of the session, and whether the VPS is reachable. Assess only what is reachable; list
   the rest as excluded.
3. Graph freshness: codebase-memory `index_status` for the project; note `parse_partial` files.
4. Operation window: if `Skills/automation-resilience/scripts/operation-window.ts` exists, run
   `admit`; if it is absent, record the gap.
5. Score the scoped plan (not the operator message) with the swarm decision gate:
   `bun <repo>/packages/swarm/src/routing/swarm-decision-gate.ts --json "<scoped plan>"`.
   A full assessment scores SWARM (0.89 on the first run).
6. Ask the operator, in one question round:
   - Execution mode: direct + ≤4 read-only helpers (recommended) / direct only / Hermes swarm
     campaign (prepare the campaign file for review first).
   - Live model calls: none, or a bounded budget (first run: ≤40 calls, ≈$2 hard stop,
     every call logged to `evidence/model-calls.tsv`).
7. Create the assessment directory from `templates/` (default
   `<workspace>/zouroboros-assessment-<YYYY-MM-DD>/`, where `<workspace>` is the profile workspace) and write `PROGRESS.md`:
   objective, permitted scope, environment, gate score, operator decisions.

## Phase 1 — Discovery and inventory
1. Provenance: `scripts/provenance-map.sh <checkout> <owner>/hermes-zouroboros <evidence>`.
   It finds the closest upstream commit, files ahead of it, and files that exist in no
   upstream commit.
2. Launch up to three read-only helpers in parallel, if approved. Prompts are in
   `helper-prompts.md`: repo inventory (graph-first), Hermes runtime inventory, and host
   runtime inventory.
3. While they run, start Phase 3A; do not duplicate their reading.
4. Save each helper report as `evidence/inventory-*.md` with unverified claims marked `[H]`.
5. Build the component inventory. On the first run there were 23 components (see the
   baseline REPORT §4). Record each one's status: active, library-only, orphaned, duplicated,
   or not installed.

## Phase 2 — Test matrix
Start from `templates/TEST-MATRIX.md`, which has every test ID from the first run, then add rows
for newly discovered components. Each row needs a priority, requirement, method, explicit
pass/fail criteria, an evidence type and evidence path, and a defect reference.

## Phase 3A — Build and code integrity (isolated copy)
```bash
S=$(mktemp -d /tmp/zo-task-XXXXXX); cp -a ~/hermes-zouroboros $S/hz; cd $S/hz
export PATH=~/.hermes/tools/node-*/bin:~/.local/bin:~/.bun/bin:$PATH CI=1   # node is not on PATH by default
pnpm install --frozen-lockfile --offline --ignore-scripts   # lockfile consistency
pnpm run build; pnpm run typecheck                           # record exit codes and `error TS` count
HOME=$S/fakehome bun test tests
python3 -m unittest discover -s tests -p test_installer.py
python3 -m unittest discover -s factory -p 'test_*.py'
bun scripts/ci/verify-portable-runtime.ts
for p in packages/* cli; do diff -rq ~/hermes-zouroboros/$p/dist $p/dist; done   # dist drift
```
Also check that package `test` scripts point at test files that actually exist.

## Phase 3B/C — Contract and end-to-end
- MCP harness (isolated). Copy `scripts/mcp-e2e.ts` into `$S/hz/`, run
  `HERMES_ZOUROBOROS_HOME=$H/data HOME=$H bun integration/cli.ts init --workspace $H/work`,
  then `HZ_TEST_HOME=$H bun mcp-e2e.ts $S/hz <evidence>/C-mcp-e2e.json`. It covers tools/list,
  round trips, validation boundaries, duplicates, wildcards, redaction (value, entity, key),
  injection-as-data, the swarm_prepare DAG contract, restart persistence, two-writer
  concurrency, and latency.
- Live read-only intake:
  `bun factory/cli.ts --board-dir ~/.hermes/kanban/boards/software-factory --manifest ~/.local/share/hermes-zouroboros/config/factory-foundation/manifest.json [--pullable]`.
  Take sha256 and mtime of `kanban.db` before and after.
- Live MCP: call `workshop_status`, `memory_search`, `factory_intake` through the session's own
  `zouroboros` MCP. Read tools only.
- Kanban reconciliation (read-only SQL): find `running` tasks whose `claim_expires` is in the
  past or whose `worker_pid` is dead. Hermes reclaims only in its dispatcher tick
  (`hermes kanban daemon` or the gateway), so check whether one runs. Do not run
  `hermes kanban` against the live board, because it may migrate the schema; copy the board
  to scratch first.
- Timers: `systemctl --user list-timers`, plus `journalctl --user -u <unit>` results matched
  against data (Qdrant point counts versus active facts; index time versus file mtime).
- Reachability (rule 6): for every data store kept fresh, name its consumer. For Qdrant, group
  the access log by path and user agent
  (`journalctl --user -u qdrant --since -24h | grep points/search`).

## Phase 3D — AI reliability (only with approved budget)
- Live swarm E2E. Use a scratch Zouroboros home whose `hermes` entry is a symlink to the real
  workshop profile, a scratch `settings.json` workspace, and a copy of `executors.json`. Run a
  2-task DAG with known answers through
  `HERMES_ZOUROBOROS_ALLOW_SWARM=1 bun integration/cli.ts swarm tasks.json`. Then run a
  10-second timeout task (`sleep 40`), and a bad model (`HERMES_MODEL=nonexistent-…`) once
  through the bridge and once directly, with stderr redacted, to see whether the cause is
  diagnosable.
- Probes: `ASSESS_ALLOW_LIVE=1 scripts/live-reliability.sh /tmp/zo-task-…/live <evidence>`
  (18 calls: structured JSON ×6, file prompt-injection ×5, unsupported answer ×5, synthetic
  credential ×2). It writes `live/scores.txt`.
- Static: fallback providers (`config.yaml`), executor fallback chains, budget/cost recording
  (is `initBudget` ever called?), and retry wiring.
- Report the sample sizes. One success does not prove reliability.

## Phase 3E/F — Data integrity, resilience, recovery
- Concurrency: harness C-31. On failure, rerun to capture the exact error.
- Restore drill: `scripts/restore-drill.py /tmp/zo-task-…/restore <memory.db> <swarm.db> <kanban.db>`.
  Then prove the consumers work: run the MCP server on the restored memory (search finds known
  facts), and run factory intake on the restored board with the real manifest (schema
  fingerprint accepted).
- Qdrant: copy `~/.local/share/qdrant/storage` to scratch and start a disposable container on
  `127.0.0.1:16333`. Compare collection counts and one point's payload and vector. Stop it.
- Outages: run the sync and ingest scripts with `QDRANT_URL=http://127.0.0.1:1`, and start
  the MCP server on a random-bytes `memory.db`. Expect a fast, visible non-zero exit.
- Cancellation: `scripts/interrupt-test.sh $S/hz <evidence>` (fake Hermes, no model).
- Backups and alerting: inspect timers, tools and off-disk copies. Backups that exist but have
  never been restored do not pass.

## Phase 3G — Security and privacy
- Shell injection: run `bun integration/cli.ts memory defense "harmless; touch $S/MARKER"` in
  the isolated copy with a scratch home. FAIL if the marker exists.
- Redaction: harness C-17 and C-17b.
- Cross-origin: `scripts/cors-probe.sh <evidence>` (GET and OPTIONS only).
- Permissions: secret files must be 0600. Request dumps must mask `Authorization` (parse the
  JSON and print only lengths).
- Repository exposure: for every repo in scope, check
  `gh api repos/<owner>/<repo> --jq .visibility` against the recorded intent (PROGRESS/README),
  and check `gh api repos/<owner>/<repo>/branches/main/protection`. Constitution Article V relies
  on protected `main`. Read every field the API returns: the first run missed `private: false`
  (an assessment once missed a repository recorded as private that was public).
- Swarm opt-in: `HERMES_ZOUROBOROS_ALLOW_SWARM` must be off in every MCP config.
- Import-time side effects: `grep -n "process.env\[" packages/*/src/**/*.ts` around module
  scope.
- Dependency audit (`pnpm audit`) sends the manifest to an external registry. Run it only with
  operator approval; otherwise mark it NOT TESTED.
- Restricted-organization confidentiality and email-lane rules (workspace `AGENTS.md`) apply only if a
  gateway or email lane is configured.

## Phase 3H — Performance, retrieval, observability
- Latency: harness C-32/C-33 (MCP), `model-calls.tsv` durations (live p50 and max), intake
  and graph timings.
- Retrieval: `ASSESS_ALLOW_LIVE=1 HZ_REPO=~/hermes-zouroboros bun scripts/rag-eval.ts`
  (1 embedding call; hit@1 and hit@5). Compare with graph `search_code` for identifier
  queries.
- No SLAs are documented, so report baselines and propose provisional thresholds; never
  invent an SLA.
- Observability: after each induced failure, check that the cause appears where the operator
  is pointed. Then check whether anything alerts.

## Phase 4 — Report, defects, cleanup
1. `DEFECTS.md` (template): severity, class (PRE/REG/ENV/OBS/LAT), expected vs observed,
   reproduction, impact, root cause or labelled hypothesis, fix, verification. Re-test earlier
   defect IDs and mark them fixed or still open.
2. `python3 scripts/matrix-totals.py TEST-MATRIX.md`.
3. `REPORT.md` (template), sections 1–12 of the brief: verdict with limits, architecture map,
   component coverage against the inventory denominator, workflows, findings, results,
   evidence, gaps, remediation with acceptance criteria, regression commands, counts.
4. Prove nothing changed:
   `touch -d '<start>' /tmp/x; find ~/hermes-zouroboros -newer /tmp/x -type f -not -path '*/node_modules/*'`.
   Also list live-data files newer than the start (`-shm` files from read-only opens are
   expected).
5. Delete scratch (`/tmp` is RAM-backed and it holds copies of live data). First move every raw
   output the matrix cites into `evidence/`.
6. Mark `PROGRESS.md` COMPLETE with the operator decisions still needed.

## Pitfalls seen on the first run
- The Claude executor sets a private `HOME`. Run `hermes`, `systemctl --user`, `journalctl
  --user` and `podman` with
  `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME HOME="$(getent passwd "$(id -un)" | cut -d: -f6)" XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`.
- `pkill -f <pattern>` killed the assessing shell twice, because the pattern was in its own
  command line. Kill by PID from a script (`interrupt-test.sh` shows how).
- `diff <(git show …)` reports "Binary files differ" for sources containing NUL bytes. Write a
  temp file and use `diff --text`.
- `grep` may be an alias for ugrep with different `-E` behaviour. Use `/usr/bin/grep -F` for
  literals.
- `hermes kanban --help` failed with "no dependency environment" until `HOME` was corrected.
  It is not an install fault.
- Two MCP servers (Hermes's and Claude's) share one `memory.db`, so concurrency is a real
  workload, not an edge case.
- Build artifacts can lag source edits from earlier sessions. Always diff live `dist/` against
  a fresh build.
- Helper reports included some wrong assumptions (for example, about CI). Verify before citing
  them.
