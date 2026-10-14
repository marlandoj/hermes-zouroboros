# Read-only helper prompts (Phase 1)

Launch only if the operator approved helpers. Run all three in parallel. Every prompt must keep
the READ-ONLY and no-secrets lines. Treat each report as hypotheses until reproduced.

## 1. Repo inventory (graph-first)
> READ-ONLY inventory. Do not modify, run, install or start anything. Never print secret values;
> name variables only. Breadth: very thorough.
> Repo: `<checkout>`, indexed in codebase-memory as `<project>`. Use `search_graph`,
> `get_architecture`, `get_file_outline`, `trace_path` (inbound callers) and
> `get_code_snippet` first; use grep/Read only for config, docs and scripts, or to confirm a
> graph result. Skip node_modules and dist.
> For each component (each package, integration/, cli/, factory/, scripts/, deploy/, tests/,
> examples/, .github/) record: purpose observed in code; source path; entrypoints; concrete
> consumer/caller/trigger (mark it "orphan" if there is none, with evidence); upstream and
> downstream dependencies; config and credential env var NAMES; tests and whether CI runs
> them; status (active/retired/orphaned/duplicated/uncertain).
> Also report: the MCP tool list (handler file:line, validation, side effects); CLI
> subcommands; model routing, fallbacks, budget, timeouts and retries (file:line); the swarm
> flow from tasks.json to DAG to bridge to evaluation, with its gating env flags; the memory
> schema, migrations, DB path, decay, search and locking; factory intake read-only guarantees;
> RAG scripts and who retrieves from Qdrant; whether control-plane and capability-runtime
> have callers; every spawn, network call and non-temp write (file:line); documented
> SLAs/thresholds. Separate "observed in code" from "claimed in docs". Under ~2500 words.

## 2. Hermes runtime inventory
> READ-ONLY. No file changes, no starting or stopping services, no `hermes chat`, no network or
> model calls. Never print secret values; names, set/unset and file modes only.
> Targets: `~/.hermes` (config.yaml, .env names, skills, cron, kanban, memories, logs,
> hermes-agent checkout), `~/.local/share/hermes-zouroboros` (workshop profile, memory.db,
> swarm.db, registry, campaigns), the profile workspace, and
> `~/.local/share/zouroboros-executors`. Use read-only sqlite (`mode=ro` URI).
> Report: Hermes version and revision; profiles (provider, model, fallbacks, toolsets,
> approvals, MCP servers with env names, sampling); gateway and running processes; cron jobs
> and ticker age; Kanban boards, task counts by status, schema version, and any `running` task
> with an expired claim or dead worker_pid; memory DBs (tables, row counts, WAL, last write);
> skills and plugins; recent sanitized errors (max 20 lines); executors and registries;
> backups and restore docs; credential names and file modes (flag group/world-readable).
> Separate observed facts from assumptions. Under ~2500 words.

## 3. Host runtime inventory
> READ-ONLY host inventory. Do not start, stop, restart or enable anything, and make no
> external network calls. Loopback GETs to running services are allowed. Redact secrets.
> For `systemctl --user`, `journalctl --user` and `podman`, use:
> `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME HOME="$(getent passwd "$(id -un)" | cut -d: -f6)" XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`.
> Report with evidence: user units and timers (enabled, active, failed; ExecStart, Restart,
> limits, last result, 24h journal errors) and linger; containers, Qdrant version,
> collections, storage, snapshots and bind addresses; all listening sockets mapped to
> processes, flagging any 0.0.0.0/::; relevant processes with RSS; the Herald OS shell and
> update check; codebase-memory version, cache and MCP configs (names only); the Claude
> executor profile (hooks, permission mode, MCP names); storage, memory and swap; backups
> (timers, tools, latest timestamps, restore docs); firewall/VPN; bootc/rpm-ostree status
> and the auto-update and reboot schedule. Flag risks explicitly. Under ~2500 words.
