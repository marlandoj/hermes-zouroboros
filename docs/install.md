# Install into normal Hermes chats

The supported operator entrypoint is `bash scripts/install.sh` from the source tree.
It installs the current distribution and connects its five Zouroboros tools to
an existing normal Hermes profile. It does not provision the full upstream
production factory or enable paid/unattended worker execution.

## Prerequisites

Use an unprivileged Linux account with Python 3.10+, Bash, GNU `timeout`, Node
20+, Bun 1.3.12+, and Hermes Agent on PATH. Set up the selected normal Hermes
profile first; it must already have `config.yaml`. No new provider login is
needed to use the shared-memory tools.

Review and obtain this source tree through the project's trusted distribution
channel. The installer does not download or run an unpinned Hermes/Bun/Node
bootstrap. It discovers PATH plus the user's `~/.local/bin` and `~/.bun/bin`.
It requires the source's exact pnpm pin. If pnpm is missing, npm installs that
pin into workshop-private `tools/pnpm-VERSION`, with lifecycle scripts disabled.
Before bootstrap/use, it rejects unsafe directory hierarchies, non-owned or
group/world-writable private prefix contents, and links escaping the prefix.
The ordinary npm `bin/pnpm` and `bin/pnpx` links are allowed only to validated
files inside that prefix. User-selected PATH pnpm must also have trusted
ownership/permissions before its version command is executed.
It never replaces an existing mismatched global pnpm; select the correct version
on PATH instead. Use `--no-bootstrap-pnpm` to prohibit this tool download.
Dependency installation/build still needs network for uncached packages.

## One command

```bash
cd /path/to/hermes-zouroboros
bash scripts/install.sh --workspace "$HOME/work/hermes-projects"
```

Preview first if desired:

```bash
bash scripts/install.sh --dry-run
```

The installer resolves the active profile through `hermes config path` rather
than assuming `~/.hermes`. It preserves the inherited `HERMES_HOME`; you can
select another already-initialized profile explicitly:

```bash
bash scripts/install.sh \
  --hermes-home /absolute/normal-hermes-home \
  --data-home /absolute/shared-workshop-state \
  --workspace /absolute/project-workspace
```

Default shared state follows `HERMES_ZOUROBOROS_HOME`, or
`${XDG_DATA_HOME:-$HOME/.local/share}/hermes-zouroboros`. On a new installation
the default workspace is `~/work/hermes-projects`; for existing state, saved
workspace settings take precedence. An explicit conflicting workspace fails
rather than moving data. Do not select the isolated worker home as the normal
Hermes home.

## What it does

1. Checks runtime versions, selected profile, saved state, and connection conflicts.
2. Installs frozen-lockfile dependencies with lifecycle scripts disabled, builds,
   and typechecks using the existing `scripts/setup.sh`.
3. Initializes workshop settings/isolated worker home only if not already present.
4. Adds the MCP connection with the supported `hermes mcp add` CLI. It sets
   unattended worker execution and server-initiated model sampling off explicitly.
   It never answers an overwrite prompt yes. A non-secret, unique attempt tag
   identifies newly added entries for safe failure cleanup.
5. Reads back configuration and runs `hermes mcp test zouroboros`.
   Saved settings must explicitly enable the connection, disable sampling, and
   specify tool timeout 120 seconds and connection timeout 30 seconds; a zero
   CLI exit without the matching readback is not success.
6. Uses a real MCP client to discover all five tools, save/read back a non-secret
   installer receipt on first install, and retrieve the same receipt ID before
   and after disconnect/reconnect using `memory_search`'s optional exact `id`
   filter. Verification does not treat the top 30 keyword matches as exhaustive.
   Repeated runs find the exact receipt even if expired,
   rather than accumulating copies. After first-install MCP storage/readback, the verifier uses
   a constrained, parameterized local SQLite transaction in the validated shared
   database to set only that receipt's `decay_class` to `permanent` and `expires_at`
   to NULL, with exact-record lifecycle readback. Its ID and other fields remain
   unchanged; ordinary facts retain their existing payloads and default 90-day
   retention. Directory/file/SQLite-sidecar safety checks run before each local
   database open. No schema rewrite or user-fact deletion/deduplication occurs.
   The reserved receipt identity is entity `hermes-zouroboros-installation`, key
   `mcp-connection`, value `hermes-zouroboros-installer-v1: shared MCP memory verified`,
   source `hermes-zouroboros`, persona `shared`, category `fact`. If historical
   exact duplicates exist, the oldest by creation time (then ID) is reused;
   others are retained unchanged. JSON `installerReceipt` reports its ID,
   `matchingRecords` count, and permanent lifetime. An already-permanent receipt
   is not refreshed. `--check` neither looks up nor writes/promotes receipts.
7. Checks database ownership and mode 0600; emits a JSON result with paths,
   verification outcomes, activation instructions, and capability boundaries.

Existing credentials, unrelated MCP servers, personal memory, and conversation
histories are not copied or merged. Normal configuration writes go through the
Hermes CLI; no raw YAML editing or whole-profile backup is performed. Initialization
never deletes existing databases or resets partial settings. Existing conflicting
connections, explicit tool filters, partial state, and symlinked state files or
internal directories cause a clear failure. The data/internal directory hierarchy
must be owned by the current user and not group/world writable (root-owned,
non-writable ancestors outside it are allowed). SQLite WAL, SHM and journal files
are checked before server startup as well as `memory.db` itself. State files
must be single-link regular files; hardlinks to files elsewhere are rejected.
New connections failing verification are disabled only when this attempt's
ownership and unchanged entry can be proven; the disabled state is read back.
Foreign/replaced entries and existing matching connections are never disabled
as failure cleanup. If safe cleanup/readback cannot be proven, failure output
explicitly reports unresolved connection state. Data is retained for diagnosis.

Installers acquire user-owned, mode-0600, non-symlink advisory locks for the
selected profile and shared data path, refusing a concurrent installer rather
than replacing its state. Persistent `.zouroboros-install*.lock` files reside
in the profile and data parent; do not delete them while installers are running.
Connections are re-read immediately before each mutation and after discovery.
These locks coordinate this installer, not arbitrary same-user Hermes commands
or edits: do not edit the selected connection/configuration while installing.
The supported Hermes CLI does not offer an atomic compare-and-set transaction.
Keep the source tree at its installed location:
MCP commands and executor bridges use absolute paths. Relocation and changing
executor registries require explicit operator review, not a forced reinstall.

## Re-run and check

```bash
# Repeat installation; preserve existing state and matching connections.
bash scripts/install.sh

# Use an already-built tree (no dependency download/build).
bash scripts/install.sh --skip-build

# Check the existing connection; no configuration changes or saved facts.
bash scripts/install.sh --check
```

`--dry-run` does not build, download tools, initialize the workshop, start the
MCP server, or change its configuration. `--check` performs a real MCP handshake
and status call; normal server startup opens the existing database and can run
its initialization/migrations or create/update SQLite sidecars. It also acquires
the installer locks. It is a non-installing health check, not a promise that
server startup performs no filesystem writes. The JSON verification explicitly
reports `startupFilesystemWritesPossible: true`. It does not search/update facts
or claim a fresh memory round trip; the reported `memoryRoundTrip` is null.

A successful CLI handshake is not proof that an already-open chat has adopted
new tools. Start a new normal chat or explicitly use `/reload-mcp`; then ask for
`workshop_status` and retrieval of the installer marker. No chat, gateway,
desktop process, or system service is automatically restarted.

## Shared-memory search API

The existing `memory_search` MCP tool accepts:

```json
{"query":"copper", "limit":10, "id":"exact-stored-fact-id"}
```

- `query` is required: a string of 1–2000 characters.
- `limit` is optional: an integer from 1–30, default 10.
- `id` is optional: a string of 1–200 characters, matched exactly without
  normalization or UUID-only validation (historical IDs are supported).
  Empty, overlong, null, and non-string IDs are rejected.

Without `id`, keyword search, ordering (`importance DESC, created_at DESC`),
limits and expiry behavior are unchanged. With `id`, the response is the same
JSON array shape with zero or one fact: that exact ID must also match the query
and be unexpired (`expires_at` is NULL or strictly later than SQLite's current
Unix time). The ID filter is applied before result limiting; it is not a filter
of the top 30 matches. Both modes use existing SQLite `LIKE` matching against
`text`, `entity`, or `value`, including its case behavior and `%`/`_` wildcards.
Unknown IDs, query mismatches, and expired IDs return `[]`. No search refreshes
TTL, changes ranking/payloads, or recovers an expired fact. Only the installer's
constrained local recovery can promote its selected six-field receipt before
MCP proof. This extends one existing tool; the inventory remains five tools.

## Capability boundaries

| Capability | Installed/connected by this entrypoint |
| --- | --- |
| Shared SQLite work facts and keyword lookup | Yes |
| Five MCP tools in the selected normal profile | Yes, after chat startup/reload |
| Campaign validation/preparation | Available; does not launch workers |
| GraphRAG and semantic embedding search | Not enabled/wired by this installer |
| Additional agent harnesses | Bundled engine/catalog only; not connected |
| Model workers/provider authentication | Not enabled/probed; separate opt-in |
| Factory intake | Tool exposed; requires board owner's trusted manifest |
| Claim/dispatch, review enforcement, merge/deployment | Not provisioned |
| Automatic conversation capture or personal-memory replacement | No |
| Codebase MCP | Not installed by this entrypoint |

## Failure and rollback

Failures return nonzero and name the stage; potentially secret child output is
not dumped into logs. Run the named supported command locally for detailed
diagnostics. Review partial state rather than deleting it to bypass safeguards.
If a newly added connection was disabled, fix the cause and rerun.

To disconnect, use `hermes mcp remove zouroboros` in the selected profile, then
start a new chat or explicitly reload MCP. This does not remove workshop data.
Never copy a live SQLite database blindly; use the operations guide's backup
instructions if a backup is needed.

## Tests

```bash
pnpm test
pnpm run typecheck
bash -n scripts/install.sh

# Optional qualification against the installed real Hermes CLI, in scratch
# profiles only. No model/voice/provider requests are made.
HERMES_ZOUROBOROS_TEST_REAL_HERMES=1 \
  python3 -m unittest discover -s tests -p test_installer.py -v

# Also exercise the real frozen-lockfile build in that synthetic profile.
HERMES_ZOUROBOROS_TEST_REAL_HERMES=1 HERMES_ZOUROBOROS_TEST_BUILD=1 \
  python3 -m unittest discover -s tests -p test_installer.py -v
```

Tests cover real MCP persistence, repeated setup (including twice-expired receipt
retries, stable IDs/counts, unchanged ordinary-fact payloads/TTL, 30 newer historical
receipts and 30 actual MCP-stored keyword matches crowding the original receipt,
retained duplicates, and untouched source/persona/category lookalikes), exact-ID
lookup/validation/query/expiry semantics and unchanged keyword defaults, paths
with spaces, profile and
unrelated-server preservation, private pnpm bootstrap/failure, mismatched pins,
preview/check modes, partial/conflicting state, symlink rejection, and a cancelled
CLI add that returns zero without saving. Package-manager failure tests use local
fake npm/pnpm fixtures to check control flow, not a real npm download. Regression
fixtures also cover unsafe directory/sidecar/prefix state, late operator entries,
advisory locks, malformed nested config, timeout/readback failures, tagged cleanup,
and interrupted subprocess process groups. Real-Hermes qualification is explicitly
opt-in and uses disposable homes; it does not qualify a live profile.
