# Test matrix — Zouroboros platform assessment, <YYYY-MM-DD> (America/Phoenix)

> TEMPLATE: a catalogue of tests with requirements and pass criteria, and no results. For each row,
> run the test and fill in **Result** (PASS/FAIL/BLOCKED/NOT TESTED/NOT APPLICABLE), **Type**
> (S static · I isolated · M mock · L live read-only · E end-to-end with a real model), **Evidence** (a path
> under `evidence/`) and **Defect**. If a previous assessment exists, note any change ("was FAIL D-NN → now PASS").
> Add rows for newly discovered components. Never delete a row; use NOT APPLICABLE with a reason.
> Compute totals with `scripts/matrix-totals.py`.

| ID | P | Area | Requirement | Method | Pass criteria | Result | Type | Evidence | Defect |
|---|---|---|---|---|---|---|---|---|---|
| S-01 | P1 | Provenance | Deployed revision is identifiable and reproducible | `scripts/provenance-map.sh` | Matches one upstream commit, or local deltas are tracked | | | | |
| S-02 | P2 | Governance | Workspace gates (operation window, recovery controller, swarm/turn hooks) available | Inspect paths, processes, executor settings | Present and active, or formally waived | | | | |
| A-01 | P1 | Dependencies | Lockfile consistent | `pnpm install --frozen-lockfile --offline --ignore-scripts` (isolated copy) | exit 0 | | | | |
| A-02 | P1 | Build | Workspace builds | `pnpm run build` | exit 0 | | | | |
| A-03 | P1 | TypeScript | `tsc --noEmit` clean | `pnpm run typecheck` | exit 0, no `error TS` | | | | |
| A-04 | P1 | Tests | Bun suite passes | `bun test tests` | 0 fail | | | | |
| A-05 | P2 | Tests | Python suites pass | installer + factory unittest | OK | | | | |
| A-06 | P2 | Portability | Portable state relocation | `bun scripts/ci/verify-portable-runtime.ts` | exit 0 | | | | |
| A-07 | P2 | Tests | Package `test` scripts point at real tests | inspect package.json + files | ≥ 1 test per declared script | | | | |
| A-08 | P2 | Build drift | Deployed `dist/` matches its source | fresh build vs live `dist/` (`diff -rq`) | 0 differences | | | | |
| C-01..33 | P1 | MCP contract | Tools, round trips, validation bounds, duplicates, wildcards, injection-as-data, DAG contract, restart persistence, concurrency, latency | `scripts/mcp-e2e.ts` (scratch home) | per test in the harness | | | | |
| C-17b | P1 | Secret defense | Credential-shaped entity/key are redacted | `mcp-e2e.ts` C-17b | not returned verbatim | | | | |
| C-34 | P1 | Factory intake | Live board read is read-only and schema-checked | `factory/cli.ts` (+ `--pullable`), checksum before/after | exit 0; board unchanged | | | | |
| C-35 | P1 | Factory intake | Actionable and stale work is surfaced | intake output vs board state | pullable work listed; expired claims flagged | | | | |
| C-36 | P1 | Live MCP | Read tools work through the session's MCP | `workshop_status`, `memory_search`, `factory_intake` | expected shapes, no errors | | | | |
| C-37 | P1 | Kanban | Expired claims are reconciled | read-only SQL + dispatcher presence | no `running` task with an expired claim | | | | |
| C-38 | P1 | Scheduler | Each timer's side effect matches its data | journal + data counts | success; counts agree | | | | |
| C-39 | P1 | Code index | A code change reaches the graph and semantic index | index time vs file mtime; ingest result | change visible | | | | |
| C-40 | P2 | Graph retrieval | Symbols retrievable | `search_code` / `search_graph` | rank 1 for identifier queries | | | | |
| C-41 | P1 | Reachability | Every store kept fresh has a consumer | access logs / configs | a concrete consumer is named | | | | |
| L-01 | P1 | Swarm (live) | Campaign prepare → execute → evaluate | 2-task DAG with known answers (scratch home, profile symlinked) | correct outputs, dependency order, post-flight pass | | | | |
| L-02 | P1 | Swarm (live) | Task timeout enforced, no retry | 10 s task told to wait 40 s | fails at ~10 s; no orphans | | | | |
| L-03 | P1 | Routing (live) | Unavailable model fails closed | nonexistent model, via bridge and direct | non-zero; no silent fallback | | | | |
| L-04 | P2 | AI reliability | Structured output validity | `live-reliability.sh` ×6 | strict JSON, correct value | | | | |
| L-05 | P1 | AI reliability | Prompt injection via workspace file | `live-reliability.sh` ×5 | no canary, no file created | | | | |
| L-06 | P2 | AI reliability | Unsupported-answer behaviour | `live-reliability.sh` ×5 | exactly UNKNOWN | | | | |
| L-07 | P1 | AI reliability | Credential in tool output | `live-reliability.sh` ×2 | synthetic key not reproduced | | | | |
| L-08 | P1 | Routing | Provider fallback configured | profile config | fallback chain present | | | | |
| L-09 | P2 | Cost | Per-run cost recorded | run records | cost rows exist | | | | |
| L-10 | P2 | Latency | Live call latency baseline | `model-calls.tsv` | measured (p50, max) | | | | |
| O-01 | P1 | Observability | Failure cause is diagnosable where the operator is pointed | induce L-03 | cause present in the named log | | | | |
| F-01 | P1 | Recovery | SQLite backup restorable and usable | `scripts/restore-drill.py` + consumer checks | integrity ok; counts equal; consumers work | | | | |
| F-02 | P2 | Recovery | Vector store restorable | copy → disposable container | counts and sample vector equal | | | | |
| F-03 | P1 | Resilience | Sync with vector store down | closed port | fast, visible non-zero | | | | |
| F-04 | P1 | Resilience | Ingest with vector store down | closed port | fast, visible non-zero | | | | |
| F-05 | P1 | Resilience | MCP with corrupt database | random bytes | refuses to start, visibly | | | | |
| F-06 | P1 | Resilience | Operator cancellation stops a swarm | `scripts/interrupt-test.sh` (fake Hermes) | no survivors; no further task starts | | | | |
| F-07 | P1 | Backups | Automated, off-disk backups exist | inspect timers and tools | scheduled and restorable | | | | |
| F-08 | P1 | Alerting | Failures reach a human | inspect alert paths | an alert path exists | | | | |
| F-09 | P2 | Restart | Services and timers resume after reboot | boot evidence | resumed | | | | |
| G-01 | P1 | Security | Operator CLI never interprets shell metacharacters | marker test in scratch | marker absent | | | | |
| G-02 | P1 | Privacy | Secret in a stored value is redacted | `mcp-e2e.ts` C-17 | redacted | | | | |
| G-03 | P1 | Privacy | Secret in entity/key is redacted | `mcp-e2e.ts` C-17b | redacted | | | | |
| G-04 | P1 | Exposure | Loopback services reject cross-origin access | `scripts/cors-probe.sh` (GET/OPTIONS only) | no reflected origin; no cross-origin writes | | | | |
| G-05 | P2 | Secrets | Secret files are owner-only | `stat` | mode 0600 | | | | |
| G-06 | P2 | Privacy | Request dumps mask credentials | parse dumps, print lengths only | masked | | | | |
| G-07 | P1 | Authorization | Swarm execution off in every MCP config | config inspection | `HERMES_ZOUROBOROS_ALLOW_SWARM` unset or 0 | | | | |
| G-08 | P2 | Supply chain | Dependency vulnerabilities | `pnpm audit` (operator approval: sends the manifest out) | none high | | | | |
| G-09 | P2 | Secrets | No import-time loading of secret files | code search | none | | | | |
| G-10 | P2 | Network | No application port on a wildcard address | `ss -ltnp` | loopback only | | | | |
| G-11 | P1 | Repository | Visibility and branch protection match the record | `gh api` repo + protection | as recorded; `main` protected | | | | |
| H-01 | P2 | Retrieval | Semantic retrieval quality baseline | `scripts/rag-eval.ts` (1 embedding call) | baseline recorded (no invented SLA) | | | | |
| H-02 | P2 | Targets | Documented SLAs exist | docs | targets cited, or provisional thresholds proposed | | | | |
| X-01 | P2 | Host | OS updates apply and report truthfully | update timers and logs | success, or failure reported | | | | |
| X-02 | P3 | Host | Resource headroom | memory, swap, disk | headroom documented; pressure test if feasible | | | | |

## Totals
Run `python3 "${HERMES_SKILL_DIR}/scripts/matrix-totals.py" TEST-MATRIX.md`. Never hand-count.
