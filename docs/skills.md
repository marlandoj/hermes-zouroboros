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

### Model calls and scheduled agents (t4)

Skills that called the Zo `/zo/ask` endpoint now go through `integration/ask.ts`. This is the
distribution's one-shot model layer. It resolves an executor from the profile's registry
(default `hermes-vps`) and runs `integration/hermes-bridge.sh`, so the provider, model and
credentials come from the Hermes profile. `SWARM_RESOLVED_MODEL` and `SWARM_PROVIDER` carry a
per-call model and provider, and `HERMES_TIMEOUT` carries the per-call timeout. Zo credential
variables are removed from the child environment. Failures are classified from the bridge exit
status:

- timeout (124 or 137): transient;
- any other Hermes failure, or empty output: transient;
- usage (2), unavailable (126 or 127, or no profile): permanent;
- interrupted (130 or 143): permanent.

- **`ask-retry`** (renamed from `zo-ask-retry`): retry, backoff and model-chain rotation with
  a 0/1/2/3 exit contract.
- **`ask-governor`** (renamed from `zo-ask-governor`): concurrency, named budgets,
  deduplication, a circuit breaker and redacted telemetry. It runs in-process, or as an optional
  `127.0.0.1` service that fails closed. Its state lives under `ZOUROBOROS_STATE_DIR`.
- **Governed callers:** `deep-research`, `broll-injector` and `ponytail-review` make their model
  calls through `ask-governor`.
- **`agent-doctor` and `agent-model-healer`** target the profile's own scheduled agents:
  - they read `$HERMES_HOME/cron/jobs.json` and change jobs only through
    `hermes cron pause|edit`, which holds Hermes' own jobs lock;
  - the healer's fallback chain lives under `ZOUROBOROS_CONFIG_DIR/agent-model-healer/`;
  - healing is a dry run until the operator enables it.
- **`persona-creator`** (renamed from `zo-persona-creator`):
  - it generates personas with `packages/personas` into `ZOUROBOROS_STATE_DIR/personas`;
  - it installs them as Hermes `agent.personalities` entries and never selects one.

`tests/skills-zoapi.test.ts` exercises all eight end to end with a fake `hermes` and no
credentials. It also runs their own unit tests.

### Self-improvement (t5)

These skills keep every runtime file under the portable roots. They never use a shared tmpfs or
a host workspace path:

| Root | Holds |
|---|---|
| `ZOUROBOROS_STATE_DIR` | self-heal scorecards, prescriptions and results; the instinct store; hook sentinels; audit and digest reports |
| `ZOUROBOROS_LOG_DIR` | decision and invocation logs |
| `ZOUROBOROS_CONFIG_DIR` | kill switches and operator inventories |

Each root falls back to the profile data directory.

- **`zouroboros-introspect`, `zouroboros-prescribe` and `zouroboros-evolve`:** thin skills over
  `packages/selfheal`, run through `integration/selfheal.ts`.
  - Memory is read through the distribution's memory layer. The profile `memory.db` is always
    used, and inherited `ZO_MEMORY_DB`/`ZOUROBOROS_MEMORY_DB` are overridden.
  - `packages/selfheal/src/paths.ts` makes the package's state, results and log locations
    configurable. Without the portable variables, the old workspace-relative defaults are kept.
  - Any evolve run other than `--dry-run` needs `HERMES_ZOUROBOROS_ALLOW_SWARM=1`. Autoloop mode
    runs the distribution's `autoloop` skill.
  - **Memory Recall** runs the shipped synthetic eval
    `packages/selfheal/src/introspect/memory-recall-eval.ts`. It seeds a throwaway database with the
    hand-written fixtures in `memory-recall-fixtures.json` (fictional projects, never live memory)
    and asks each case through the distribution's keyword and graph-boosted search; the score is
    the share of cases whose expected phrase is in the top 3. A fresh profile therefore scores its
    recall machinery instead of CRITICAL for a missing workspace file. Overrides:
    `ZOUROBOROS_MEMORY_RECALL_EVAL` (eval script) and `ZOUROBOROS_MEMORY_RECALL_FIXTURES` (fixture
    file, also the holdout tripwire's visible set). A missing eval reports insufficient evidence.
  - **Graph Connectivity** is measured from the profile database
    (`introspect/graph-connectivity.ts`, or `ZOUROBOROS_MEMORY_GRAPH_SCRIPT`).
  - **Evolve recipes** (`prescribe/playbook.ts`) target distribution files by absolute path in this
    checkout: the recall fixtures, `packages/memory/src/graph.ts`, the swarm routing engine and the
    collector. Autoloop edits and commits that target file, so run an approved evolve with the
    workspace set to this checkout (or a clone of it), never a workspace skill.
- **`instinct-harvester`:** the trigger→action instinct store, under
  `ZOUROBOROS_STATE_DIR/instincts`. js-yaml is replaced by a shim over the distribution's `yaml`
  dependency.
- **`extract-patterns`:** the four-criteria session gate, run as a Hermes shell hook. It injects
  the gate on `pre_llm_call` once per session and back-fills on `on_session_finalize`. Register it
  under `hooks:` in the profile's `config.yaml`.
- **`agent-introspect`:** audits this skills tree (frontmatter, script `--help` health) and the
  workspace identity files.
- **`operator-digest`:** a weekly read-only briefing built from the self-heal, healer and
  governance state. The summary is deterministic.

`tests/skills-selfimprove.test.ts` runs all seven offline in a disposable profile. A decoy host
memory database must stay untouched. The test also runs the skills' own suites: 226 instinct
checks, the hook selftest, two Python suites and the governance-evidence tests.

`zouroboros-memory-evolution` is not shipped. Its eval set is derived from live operator memory,
not synthetic data, and its harness targets the host memory database.

### Path skills and financial skills (t6)

These skills replace host paths with the portable roots and the profile environment:

- **`all-out-game-development` and `gamedev-engine-corpus` (`gaming`):** build and query their own
  Qdrant corpora through `integration/qdrant-corpus.ts`. That module calls an OpenAI-compatible
  embeddings endpoint with `OPENAI_API_KEY` from the profile environment, and reproduces the
  source's hashed BM25 sparse vectors, so existing collections stay query-compatible.
  `QDRANT_URL` and `QDRANT_API_KEY` select the Qdrant server. No credential is read from a file.
- **`compile-build-spec`:** independent review runs as governed one-shot calls through
  `ask-governor`. It replaces the retired consensus gate. Export never dispatches the factory.
- **`design-md-drift-guard`:** projects and PII config live under
  `ZOUROBOROS_CONFIG_DIR/design-md-drift-guard`, and reports under
  `ZOUROBOROS_STATE_DIR/design-md-drift-guard/reports`. Runs are plan-only unless `--open-pr`.
- **`destructive-op-guard`:** a Hermes shell hook. `post_tool_call` records destructive terminal
  commands, and `pre_llm_call` delivers one reference-sweep reminder on the next turn.
- **`fal-ai-media`, `ai-character-builder` (`media`), `gauntlet-loop`, `n8n-setup` (`devops`):**
  `FAL_KEY` comes from the profile. The character builder composes existing skills. n8n is an
  optional, local-only systemd user service.
- **`daily-top5-advisor` and `strategy-scout` (`finance`):** renamed from the source's
  brand-prefixed skills. Both state the financial safety rules in their skill text: explicit
  confirmation of full order details before any trade, a 5% cap per security, a stop-loss on every
  recommendation, flags above 5% per position and 25% per sector, tax impact, and a log of every
  recommendation. Neither script can place an order. Reports go through the profile's channel, and
  email is draft-only until the operator sends it.

`tests/skills-paths-a.test.ts` runs them offline in a disposable data root, with no credentials and
no network. It also runs `compile-build-spec`'s own suite (35 tests) and the two finance Python suites.

Not shipped in t6:

- `ai-engineer-learning` is dropped, because it was retired at the source.
- `notebooklm-skill` is untracked in the source; the operator later kept it host-only (f2).
- `graphrag-relational` waited for an operator decision on its Redis dependency; it shipped in f2.

### Path skills B (t7)

- **`plan-closeout`, `verity`, `skill-security-gate`, `wayfinder`:** hook-based skills on the Hermes
  shell-hook protocol. plan-closeout's `pre_verify` hook sends the agent back once to close out an
  armed plan. Verity's installer and Wayfinder's installer never write a Hermes profile unless one
  is named explicitly (Verity only prints the `hooks:` snippet). The skill-security-gate adoption
  hook (`pre_tool_call`, off by default) covers terminal clones and copies into a skills directory.
  External engines (SkillSpector, Canny, FlashRank) are installed by the operator, not vendored.
- **`production-ready`, `visual-verifier`:** model calls go through `ask-governor` or an
  OpenAI-compatible endpoint from the profile environment. Neither reads a key from a file.
- **`workspace-search`, `repo-drift-autofix`, `rag-telemetry`, `spec-first-interview`:** state and
  logs live under the portable roots. workspace-search refuses to run without an allowed root.
- **`persona-consult`:** a generic association registry maps templates to specialist roles, and the
  specialists are the profile's `agent.personalities`. There are no compiled reviewer models.

`tests/skills-paths-b.test.ts` runs the skills' own suites and offline smoke checks.

Not shipped in t7:

- `ux-laws` was `held-license` (its source text was based on CC BY-NC-ND 4.0 material). It ships
  since g1 as a rewrite from primary research; see below.
- `threejs-game-production` is dropped. It has no SKILL.md and ingests a private, paid course.
- `graphrag-relational`, `notebooklm-skill` and `reporeel` waited for operator decisions (see f2).

### UX laws (g1)

`ux-laws` (`skills/software-development/ux-laws`) was rewritten from the primary research after the
operator, who wrote the source skill, approved it on 2026-10-09. The source named the Laws of UX site
(CC BY-NC-ND 4.0) as its reference, so the distributed text is new. Each of the twenty principles is
re-derived from its original publication and carries an evidence class: empirical, observational or
heuristic. The design of the operator's skill is unchanged: measurable rules, a review checklist, a
tensions table and an installer that writes a marker-fenced block into a project's instruction file
(`AGENTS.md`, `.hermes.md`, `CLAUDE.md` and others). An 8-word shingle check against the source text
found 0.16 % overlap, all of it law names and one citation title. `tests/skills-uxlaws.test.ts` runs the
skill's own suite.

### GraphRAG and the remaining dispositions (f2)

- **`graphrag-relational`:** builds an embedded FalkorDB graph from a factory database, factory-log
  JSONL, execution-state files and tracker-neutral ticket exports, and answers typed relationship
  questions with read-only Cypher. `operator-digest` uses it for its governance graph evidence.
  - **Dependency (operator-approved 2026-10-09):** `falkordblite` 0.3.0 (MIT), installed with
    `bun install` inside the skill directory only, with lifecycle scripts untrusted. On first use
    the runtime downloads the Redis 8.2.3 source, verifies its pinned SHA-256, compiles
    `redis-server` and caches it under `$ZOUROBOROS_CACHE_DIR/falkordblite`. That needs network
    access, `make` and a C toolchain once. Nothing is built at install time, and the build is
    refused in CI. `FALKORDBLITE_REDIS_SERVER` points at a pre-verified binary instead.
  - **Tests:** `tests/skills-graphrag.test.ts` runs the offline suite and checks that nothing was
    built. Graph-backed tests run only with `GRAPHRAG_LIVE_TESTS=1` (`bun run test:live`).
- **`notebooklm-skill`, `reporeel`:** `host-only` by operator decision (kept untracked on the VPS,
  not distributed).

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
| Identity | Secret-keyed hash denylist of the source host's persona names and the operator's business brands (`identityData`; rule IDs `personal-data:persona-name-N` and `personal-data:brand-N`). Needs the secret salt; skips with a notice without it |
| Private networks | RFC 1918 IPv4, CGNAT/Tailscale IPv4 (100.64/10) and the Tailscale IPv6 ULA prefix (`networkPatterns`). Use the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) in examples and tests, and build any private-range test fixture from fragments at runtime. Never grandfathered. |
| Secrets | Pinned gitleaks (directory scan, plus commit history in `--diff` mode) and custom high-signal patterns (private keys, cloud/GitHub/Slack/model-provider tokens, literal credential assignments) |
| Provenance | Every file under `skills/` has a `provenance/skills.json` entry with a matching SHA-256, and no entry is stale |

The gate prints rule IDs and locations, never matched values. Configuration is in `provenance/leak-gate.json`.
The personal-data and identity denylists there contain only hashes, never plain text.

- **Personal data** uses the public salt in the file: add an identifier as
  `sha256(salt + normalized token)`. Short tokens can be recovered from these hashes by brute
  force, so they keep identifiers out of plain sight but are not a secret.
- **Identity** (persona names and brands) uses `HMAC-SHA256(secret salt, normalized token)`
  (`scheme: hmac-sha256/secret-salt/v1`). The secret salt is never committed, so these hashes
  cannot be brute-forced from the repository. The gate looks for it in this order:
  1. `LEAK_GATE_SALT` (CI reads it from the repository secret of the same name);
  2. the file named by `LEAK_GATE_SALT_FILE`;
  3. `~/.config/hermes-zouroboros/leak-gate-salt`, outside the repository. It must be mode 0600;
     a file readable by group or others is refused.

  Without a salt (forks, fresh clones, fork PRs) the identity rules skip, the gate prints a
  `NOTICE identity rules ... skipped` line, and every other rule still runs. CI in this
  repository sets `LEAK_GATE_REQUIRE_SALT=1`, which turns a missing salt into an error. To run
  the identity rules locally, a maintainer copies the salt from a trusted channel:

  ```bash
  install -d -m 0700 ~/.config/hermes-zouroboros
  (umask 077; cat > ~/.config/hermes-zouroboros/leak-gate-salt)   # paste the salt, then Ctrl-D
  ```

  To add an identity token, compute `printf %s '<normalized token>' | openssl dgst -sha256 -hmac "$(cat ~/.config/hermes-zouroboros/leak-gate-salt)"`
  locally and add only the hex digest with the next free label. Never print, log or commit the
  salt. Rotating it means re-hashing every identity entry in one reviewed PR and updating the
  repository secret (`gh secret set LEAK_GATE_SALT`, value on stdin).

**Context allowances.** A `contextAllowances` entry names files, rules, a context and a reason. In
those files, a finding for those rules is dropped only when it disappears after the context is
masked on that line. Two kinds exist:

- **`sourceEntryNames`:** the source skill names recorded in `provenance/skills-parity.json`. Two
  finance entries there carry the brand prefix.
- **A regex:** for example, this repository's own GitHub URL, or the recorded upstream repository.

A free-standing token in the same file still fails.

**Reviewed exceptions.** A synthetic fixture or an empty `.env.template` can ship only through a
`reviewedExceptions` entry in `provenance/leak-gate.json`. That entry lists the path, the exact
file SHA-256, the rules it waives and a reason. Any edit to the file invalidates the exception.

**0.1.0 baseline.** `provenance/leak-gate-baseline.json` grandfathers host-path and
personal-data occurrences already present in the 0.1.0 package import. They are counted per file and
rule. A count may fall but not rise. Secrets, blocked paths, private-network addresses and anything
under `skills/` cannot be grandfathered. After the f2 forward fix, only two entries remain:

- the copyright line in `LICENSE`, which is legally required;
- two mentions of a source-host directory in the 0.1.0 build log `PROGRESS.md`, which is a
  historical record.

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
