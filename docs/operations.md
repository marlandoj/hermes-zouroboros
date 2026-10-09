# VPS operation

## Default deployment

Run the checkout and Hermes as an unprivileged service account. The stdio MCP server is started by Hermes; it does not listen on the network. `doctor` verifies local executables, built files, profile, and workspace. It does not prove provider authentication or production board readiness.

Configuration lives under `HERMES_ZOUROBOROS_HOME` (default `~/.local/share/hermes-zouroboros`). The profile, memory DB, generated executor registry, prepared campaigns, and worker DB belong to that installation. Upstream optional APIs can also use workspace-local state; keep the workspace private and back it up. Provider credentials are managed by the isolated Hermes profile.

Profiles that `init` generates set `HERMES_ZOUROBOROS_ALLOW_SWARM` to a literal `0` for the MCP server, which only prepares campaigns. Execution stays opt-in on the operator command (`HERMES_ZOUROBOROS_ALLOW_SWARM=1 bun integration/cli.ts swarm …`), which reads its own environment. Profiles initialised before this change carry a `${env:HERMES_ZOUROBOROS_ALLOW_SWARM}` reference, which makes Hermes warn on every command while the variable is unset; replace it with `'0'` in `hermes/config.yaml` to silence the warning.

### Restricted email domains

`ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS` lists the mail domains (comma-separated, subdomains included) whose addresses mark text as sensitive, for example an employer's or client's domain. The public candidate-corpus guard (`packages/rag/src/candidate-policy.ts`) blocks text that contains such addresses; private keys and token shapes are blocked regardless. No domain ships as a default. While the variable is unset, `init` and `doctor` print a one-line notice, because the guard cannot block employer-domain addresses until it is set. Export it in the service account's environment, for example `ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS=corp.example,client.example`.

Do not start the MCP script as a systemd daemon: its consumer is Hermes's stdio MCP client. Moving this checkout requires updating absolute MCP/bridge paths in `hermes/config.yaml` and `executors.json`. Moving only a data directory likewise requires reviewing generated absolute paths.

## Optional HTTP memory gate and hooks

`deploy/hermes-zouroboros-memory.service` is a template, not an installed service. It assumes a dedicated `hermes-zouroboros` account, checkout at `/srv/hermes-zouroboros`, Bun at `/usr/local/bin/bun`, and state at `/var/lib/hermes-zouroboros`. Adjust all four for your host. To share the MCP database, configure both installations to use the same owned data directory and service identity.

Create `/etc/hermes-zouroboros/memory.env` with restricted permissions and a freshly generated `ZO_GATE_TOKEN`. Enter the value locally; never commit it. The service does not accept a missing token. Optional embedding credentials belong in the same private environment file if deliberately enabled.

After provisioning the account, paths, and environment, an administrator can inspect and install the reviewed unit:

```bash
sudo systemd-analyze verify deploy/hermes-zouroboros-memory.service
sudo install -m 0644 deploy/hermes-zouroboros-memory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-zouroboros-memory.service
sudo systemctl status hermes-zouroboros-memory.service
```

Concrete consumers are `packages/memory/hooks/memory-gate-hook.sh` (prompt-time recall) and `observer-hook.sh` (lifecycle observations) in a compatible coding harness. Wire them using that harness's current hook configuration, with `ZO_GATE_TOKEN` and loopback gate URL/port supplied privately. The hook source documents stdin/output contracts. Hooks are optional and are not automatically installed in Hermes.

Inspect `journalctl -u hermes-zouroboros-memory.service` locally if startup fails. Keep the gate loopback-only. Stop and disable the unit to roll back this optional service; preserve its data directory.

## Backup and restore

Stop Hermes and workers before copying profiles or changing installation paths. Use SQLite's online backup API (or `sqlite3 database '.backup destination'`) for a coherent backup; copying only a live `.db` file can omit WAL data. Back up the private profile and settings separately, encrypted at rest because the profile can contain provider credentials. Never upload those backups to GitHub.

The upstream CLI's config/state export-import path is included and covered by `pnpm run verify:portable`. That check does **not** make its backup command a backup of this integration's Hermes profile; inventory the data listed above explicitly.

## Update and rollback

Record the deployed Git revision, stop active workers, back up data, pull the reviewed revision, and run `bash scripts/setup.sh`. Run `doctor`, then the no-provider test suite. Restart Hermes so it reconnects to the new MCP code. Roll back code by checking out the recorded revision and rebuilding; restore a compatible database snapshot if an update changed its schema.

This repository does not replace the running VPS Command Center or Software Factory service. Promoting it into that production stack is a separate integration/deployment task.
