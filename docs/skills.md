# Skills

The distribution ships ported Zouroboros skills as a Hermes skill tree under `skills/`.
Release 0.1.0 shipped none; `docs/SKILLS-PARITY.md` tracks every source entry and its
disposition. Each skill is imported file by file from an allowlist, with recorded hashes,
and must pass the leak gate before it can be pushed.

## Layout

```text
skills/
  README.md                         distribution-authored index
  <category>/<skill-name>/
    SKILL.md                        required: YAML frontmatter + instructions
    references/ templates/ assets/ scripts/   optional support files
```

Hermes reads the category from the parent directory and the skill from `SKILL.md`. It treats
`references/`, `templates/`, `assets/` and `scripts/` directly inside a skill as progressive-disclosure
support files, not as further skills. Frontmatter follows the bundled Hermes skills:

```yaml
---
name: example-skill            # unique across every loaded skills dir
description: "One line: when to use it."
version: 1.0.0
license: MIT                   # or the upstream licence of third-party content
platforms: [linux]             # optional; omit for all platforms
metadata:
  hermes:
    tags: [Zouroboros]
    related_skills: []
prerequisites:
  commands: [bun]              # optional
---
```

Names must not collide with skills Hermes bundles. When both trees contain a skill of the same name,
the profile's own `skills/` directory takes precedence, and the distribution copy is silently
shadowed. Merge such a skill into the bundled one, choose a distinct name, or mark it `hermes-native`
in the parity manifest.

Refer to a skill's own files as `"${HERMES_SKILL_DIR}/scripts/..."`. Hermes substitutes the skill directory when it
loads `SKILL.md`. Skills that write runtime state (ledgers, snapshots) write under `ZOUROBOROS_STATE_DIR`, never
inside the skill tree. `tests/skills-portable.test.ts` checks frontmatter and licences and runs the ported
skills' own tests. Set `HERMES_AGENT_SRC` to a Hermes checkout to also check for name collisions with bundled
and optional Hermes skills. Skill TypeScript is part of the root `tsc --noEmit`.

Core runtime skills (`zo-memory-system`, `zo-swarm-orchestrator`, `zo-swarm-executors`, `tier-resolver`,
`autoloop`) wire to this checkout instead of carrying their own runtime. They import `integration/profile.ts`
and the workspace packages through `../../../../`, so they only work from a hermes-zouroboros checkout with
an initialized profile. Hermes `skills_guard` therefore reports `path_traversal` (caution) for them. Memory
always uses the profile database. Swarm and autoloop execution need `HERMES_ZOUROBOROS_ALLOW_SWARM=1`.
`tests/skills-core-a.test.ts` exercises all five end to end with a fake `hermes` and no provider credentials.

The `zouroboros` umbrella skill uses the same wiring. It provides the skill index, a read-only `doctor`, and the
exact-phrase operator shortcuts. The shortcuts are resolved by `zouroboros-core`'s `resolveOperatorShortcut`
and mapped to distribution commands.

`zouroboros-governance` is self-contained. It ships the canonical `ZOUROBOROS.md` and `CONSTITUTION.md` in
`references/`, and `verify-docs` checks those by default. A workspace mirror is checked only when
`ZOUROBOROS_GOVERNANCE_MIRROR_DIR` is set.

The governance audit log, anchor and approval registry live under `ZOUROBOROS_STATE_DIR` and
`ZOUROBOROS_CONFIG_DIR`. If those variables are unset, they fall back to `state/` and `config/` in the profile.

The preflight gate enforces Articles I-X. The promotion phase always fails closed
(`IX-PROMOTION-AUTHORITY-UNAVAILABLE`), because no promotion issuer or attestation authority is distributed.
`tests/skills-core-b.test.ts` covers both skills, `unstuck-lateral` and the autoloop program template offline.

Skills must stay operator-neutral and portable. Do not include host paths, operator names or
handles, persona identities, memories, run output, model catalogs or credentials. Read state through
the variables the distribution already sets (`HERMES_ZOUROBOROS_HOME`, `ZOUROBOROS_DATA_DIR`,
`ZOUROBOROS_STATE_DIR`, `ZOUROBOROS_LOG_DIR`, `ZOUROBOROS_MEMORY_DB`, `ZOUROBOROS_WORKSPACE`).

## Registration with the Hermes profile

`bun integration/cli.ts init --workspace PATH` writes the isolated profile's `config.yaml` with

```yaml
skills:
  external_dirs:
    - /absolute/path/to/this/checkout/skills
```

Hermes adds `skills.external_dirs` to its skill index after the profile's local
`$HERMES_HOME/skills`. Profiles created before this change can be updated in place:

```bash
bun integration/cli.ts skills register   # idempotent; keeps other settings and comments
```

Hermes caches the skill index per process. Start a new session after adding or updating skills.

To prove an installed Hermes discovers every shipped skill, run the following check. It uses a temporary
`HERMES_HOME` and never touches an existing profile:

```bash
bash scripts/verify-hermes-skills.sh            # set HERMES_BIN if hermes is not on PATH
```

## Importing a skill

Sources come from the Zouroboros workspace at the revision pinned in `provenance/skills.json`
and `provenance/skills-parity.json`. Only files tracked at that revision can be imported.

```bash
export ZOUROBOROS_SOURCE_REPO=/path/to/zouroboros/workspace
# one reviewed file at a time; refuses blocked paths, symlinks, untracked files and path escapes
bun scripts/import-skill.ts add --skill agentmail --file SKILL.md --dest skills/email/agentmail/SKILL.md
# after editing an imported file for portability
bun scripts/import-skill.ts rehash --path skills/email/agentmail/SKILL.md --note "Replaced host paths with ZOUROBOROS_STATE_DIR"
# a file with no source counterpart
bun scripts/import-skill.ts author --path skills/email/agentmail/references/setup.md --note "Hermes setup notes"
# recheck all entries (with source: also source hashes at the pinned revision)
bun scripts/import-skill.ts verify --source "$ZOUROBOROS_SOURCE_REPO"
```

Each `provenance/skills.json` entry records `path`, `skill`, `sourcePath`, `sourceRevision`,
`sourceSha256`, `distributedSha256` and `adaptation`. Use `"verbatim"` when the two hashes match,
and otherwise describe the change. Distribution-authored files have null source fields.

When a skill ships, set its parity entry to `portable` or `adapted` and list `distributedAs`
(for example `skills/email/agentmail`). Then run `bun scripts/ci/skills-parity.ts render`.

## Leak gate

`scripts/ci/leak-gate.ts` runs in CI and should run before every push.

```bash
GITLEAKS_BIN="$(bash scripts/ci/install-gitleaks.sh)"   # pinned 8.30.1, SHA-256 verified
export GITLEAKS_BIN
bun scripts/ci/leak-gate.ts                    # full tree (tracked + untracked, not ignored)
bun scripts/ci/leak-gate.ts --diff origin/main # changed files + gitleaks over the outgoing commits
bash scripts/install-git-hooks.sh              # optional pre-push hook running both
```

| Check | Blocks |
| --- | --- |
| Blocked paths | `*.jsonl`, `*.ndjson`, `*.db`, `*.sqlite*`, `*.duckdb`, `*.log`, key/keystore files, `.env*`, credential files, symlinks, and any `data/`, `logs/`, `reports/`, `card-snapshots/`, `.mcp-trust/`, `memories/`, `sessions/` or `.zo/` path segment |
| Host paths | The source host's workspace, home, repository, state and Zo directories, and hardcoded shared-memory (`/dev/shm`) paths |
| Personal data | Salted-hash denylist of operator identifiers and restricted organisations, email addresses outside example/no-reply domains, and phone numbers |
| Secrets | Pinned gitleaks (directory scan, plus commit history in `--diff` mode) and custom high-signal patterns (private keys, cloud/GitHub/Slack/model-provider tokens, literal credential assignments) |
| Provenance | Every file under `skills/` has a `provenance/skills.json` entry with a matching SHA-256, and no entry is stale |

The gate prints rule IDs and locations, never matched values. Configuration is in `provenance/leak-gate.json`.
The personal-data denylist there contains only hashes. Add an identifier as
`sha256(salt + normalized token)`, and never add it in plain text.

**Reviewed exceptions.** A synthetic fixture or an empty `.env.template` can ship only through a
`reviewedExceptions` entry in `provenance/leak-gate.json`. That entry lists the path, the exact
file SHA-256, the rules it waives and a reason. Any edit to the file invalidates the exception.

**0.1.0 baseline.** `provenance/leak-gate-baseline.json` grandfathers host-path and
personal-data occurrences already present in the 0.1.0 package import. Those include default
fallback paths and the repository owner's handle in package metadata. They are counted per file and
rule. A count may fall but not rise. Secrets, blocked paths and anything under `skills/` cannot be
grandfathered.

## Parity check

```bash
bun scripts/ci/skills-parity.ts check                            # CI: manifest self-check + doc sync
bun scripts/ci/skills-parity.ts check --source "$ZOUROBOROS_SOURCE_REPO"  # also: no source entry missing
```

The check fails if any of these is true:

- an entry is missing or duplicated, or the count differs from `total`;
- a disposition has no reason;
- a `pending` entry has no planned disposition;
- a shipped entry has no `SKILL.md`, or a `skills/` directory is unclaimed;
- `docs/SKILLS-PARITY.md` is stale.
