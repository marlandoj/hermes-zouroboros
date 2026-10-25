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
channel. Every invocation inventories Hermes, Bun, Node, GNU `timeout`, Bash and
Python before installation writes. Builds also inventory pnpm and, when its
bootstrap needs it, npm. It reports all missing/incompatible tools together.
It discovers PATH plus the user's `~/.local/bin` and `~/.bun/bin`.
Compatible existing runtimes are retained. Existing incompatible/broken versions
are reported; explicitly select compatible versions on PATH before retrying.

By default Node and Bun are never downloaded. To opt in:

```bash
# Review the inventory/download plan without writing anything.
bash scripts/install.sh --bootstrap-prerequisites --dry-run

# Install missing supported runtimes, then continue workshop installation.
bash scripts/install.sh --bootstrap-prerequisites
```

Automatic runtime setup supports **Linux x86_64 and arm64, glibc 2.28+,
kernel 4.18+**. Alpine/musl, other architectures, macOS and Windows do not have
an automatic path here. The workshop installer itself requires Linux. On x86_64
the Bun baseline build still requires SSE4.2; an execution/version failure stops
activation. Use an appropriate distro/runtime build on unsupported systems.
Python's standard-library HTTPS, zip and gzip-tar support suffice; no curl,
unzip, remote shell script or runtime package-manager installer is executed.

`scripts/runtime-pins.json` pins Node **24.22.1** (with bundled npm) and Bun
**1.3.12** (matching this source's CI baseline), per architecture. Node archives
come from `nodejs.org`; Bun archives come from the official `oven-sh/bun` GitHub
release. SHA-256 values were copied from the
[Node manifest](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt) and
[Bun release asset digests](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.3.12).
The checked-in digest is verified before extraction/execution; no live checksum
fallback or bypass exists. This trusts the reviewed source pins and official
release provenance; it is not independent signature verification. Maintainers
must review the version, URLs, archive layout and hashes together when updating pins.

Archives have bounded downloads/extraction and HTTPS redirect restrictions.
Extraction rejects escaping paths, duplicate files, hardlinks/devices and
unexpected symlinks; npm/npx links are recreated to fixed bundled targets.
The optional corepack alias is not installed. Files receive private modes and
ownership/link checks before execution. A staged `--version` must match the pin
before publication to `DATA_HOME/tools/runtimes/NAME-VERSION-PLATFORM`.
An exclusive per-runtime directory lock prevents concurrent setup. Downloads,
integrity checks, extraction or version failures clean staging and activate
nothing for that runtime. A completed runtime is retained if a later stage fails.
After a crash, review a retained `.installing` directory before removing it;
the installer never guesses that a lock is stale.

Managed runtime bins are appended after existing PATH entries and validated
before use on every rerun, even without the opt-in flag. No existing runtime or
partial managed destination is overwritten. Keep the same data home on reruns.
Only the installer and its child processes get these PATH additions; shell
profiles and `~/.local/bin` are never edited. To use a managed runtime directly
in a later shell, explicitly add its printed data-home
`tools/runtimes/NAME-VERSION-PLATFORM/bin` directory to that shell's PATH.
No interactive prompt is used: the flag is the consent in CI/noninteractive use.
`--dry-run` and `--check` override it and never download or install anything.

OS packages and Hermes remain operator-managed. Missing manual prerequisites
block runtime downloads too. Review and run the appropriate distro command
yourself; the installer never invokes sudo or a system package manager:

| Distro | Suggested prerequisite package command |
| --- | --- |
| Debian / Ubuntu | `sudo apt-get install python3 bash coreutils ca-certificates` |
| Fedora / RHEL | `sudo dnf install python3 bash coreutils ca-certificates` |
| Arch | `sudo pacman -S python bash coreutils ca-certificates` |
| Alpine / musl | `sudo apk add python3 bash coreutils ca-certificates nodejs npm` (select a compatible Bun separately) |

On ordinary Fedora Workstation/Server, an OS-managed Node/npm alternative is
`sudo dnf install nodejs`, followed by `node --version` and `npm --version`.
Fedora bundles npm with Node; consult the
[Fedora Node guide](https://developer.fedoraproject.org/tech/languages/nodejs/nodejs.html)
for release-specific packages if the selected command/version is absent.
Silverblue/Kinoite use the Fedora Atomic/Toolbx package workflow rather than
host `dnf`; choose the environment explicitly before installing packages.
If a compatible Node already exists but npm is missing, install its matching
npm yourself; the opt-in flag does not replace Node just to obtain npm.

Verify package versions meet the requirements; older distro repositories may
need an operator-selected supported distribution/repository. These commands do
not claim to install a compatible Hermes or Bun. Obtain a **reviewed, pinned
Hermes release** from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
and follow that version's installation/setup instructions for the selected
profile. This installer does not run an unpinned Hermes checkout, configure
provider accounts, copy credentials, or change your OS packages.

The installer requires the source's exact pnpm pin. If pnpm is missing, npm installs that
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

1. Inventories prerequisites, optionally bootstraps missing supported runtimes,
   then checks the selected profile, saved state, and connection conflicts.
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
   is not refreshed. `--check` neither starts MCP nor looks up/writes/promotes receipts.
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

# Statically inspect the existing installation; no locks, startup or writes.
bash scripts/install.sh --check
```

`--dry-run` does not build, download tools, initialize the workshop, acquire locks,
start MCP, or change configuration. With planned missing runtimes it prints the
inventory/download plan and reports `profileChecksDeferred: true`; profile and
connection checks must wait until installation. Missing manual prerequisites
or incompatible existing versions still return nonzero with the full inventory.

`--check` is now a **static inspection**: runtime inventory/version probes,
read-only Hermes configuration queries, profile/state/path safety, built-source
presence and exact saved MCP settings. It never acquires installer locks,
bootstraps, opens SQLite or starts MCP, even with `--bootstrap-prerequisites`.
Its JSON reports `staticCheck: true`, `startupFilesystemWritesPossible: false`
and `memoryRoundTrip: null`. As with previews, selected executables are trusted
to honor their version/config read commands; no installer filesystem writes
are made. It cannot prove live MCP discovery or database health. A normal
installation performs that verification, or run `hermes mcp test zouroboros`
explicitly when you intend to start the server and permit SQLite startup writes.

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
python3 -m unittest discover -s tests -p test_prerequisites.py -v

# Optional qualification against the installed real Hermes CLI, in scratch
# profiles only. No model/voice/provider requests are made.
HERMES_ZOUROBOROS_TEST_REAL_HERMES=1 \
  python3 -m unittest discover -s tests -p test_installer.py -v

# Also exercise the real frozen-lockfile build in that synthetic profile.
HERMES_ZOUROBOROS_TEST_REAL_HERMES=1 HERMES_ZOUROBOROS_TEST_BUILD=1 \
  python3 -m unittest discover -s tests -p test_installer.py -v
```

On slower machines each installer subprocess call may exceed the default 45-second
timeout even though the installer is working correctly (cold caches, space-containing
paths). Raise it without patching the suite:

```bash
HERMES_ZOUROBOROS_TEST_REAL_HERMES=1 HERMES_ZOUROBOROS_TEST_TIMEOUT=240 \
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

The stdlib-only `test_prerequisites.py` suite runs without installed Bun/Hermes
and uses synthetic archives, fake download responses and mocked commands. It
covers complete inventories, incompatible/missing tools, pnpm opt-out/trust,
platform limits, official URLs/redirects, download limits/failures, integrity,
archive traversal/links/duplicates, fixed npm aliases, staged version checks,
collision/concurrency preservation, PATH ordering, reruns, noninteractive use,
and non-mutating previews/checks. It does not install or execute real runtimes.
POSIX ownership and process-group tests still require the Linux installer suite.
