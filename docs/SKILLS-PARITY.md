# Skill parity manifest

<!-- Generated from provenance/skills-parity.json by `bun scripts/ci/skills-parity.ts render`. Do not edit by hand. -->

Source: the Zouroboros VPS workspace `Skills/` tree at revision `b6dff3e5e6c12070f90064f4146f9f08d8612d01` — 80 entries.
CI fails if an entry is missing, a disposition lacks a reason, or a shipped skill directory is unclaimed.
Entry names containing operator identifiers are redacted to `operator`; the manifest keeps the SHA-256 of the real name for completeness checks.

| Disposition | Count |
| --- | ---: |
| portable | 0 |
| adapted | 14 |
| host-only | 8 |
| dropped | 3 |
| hermes-native | 3 |
| held-license | 0 |
| pending | 52 |
| **total** | **80** |

Pending work: 1 planned portable, 51 planned adapted.

Dispositions: `portable` ships unchanged apart from recorded hashes; `adapted` ships with recorded changes; `host-only` stays on the VPS; `dropped` is not a skill; `hermes-native` is covered by a bundled Hermes skill; `held-license` awaits a licensing decision; `pending` is not yet ported.

| Entry | Triage | Disposition | Planned | Tracked at revision | Distributed as | Reason | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `-help-skill` | drop | dropped |  | yes |  | Generated stub ("--help" parsed as a skill name) from another instance; not a real skill. |  |
| `_candidates` | drop | dropped |  | yes |  | Staging area for generated candidate skills and expired queue items, not a skill. |  |
| `academy-video-pipeline` | portable | adapted |  | yes | `skills/media/academy-video-pipeline` | Rewritten operator-neutral (persona/channel names and Zo host claims removed); host-only Integrations/ and skill-security-gate paths replaced by upstream HyperFrames and the Hermes optional hyperframes skill. |  |
| `agent-doctor` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `agent-email-patterns` | portable | adapted |  | yes | `skills/email/agent-email-patterns` | AgentMail MIT (copyright holder publishes the same skill under MIT in agentmail-to/agentmail-plugins); Hermes frontmatter added. Reference docs verbatim apart from the agentmail-sdk rename. | Operator may confirm the licence judgement (source dir had no LICENSE). |
| `agent-introspect` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `agent-model-healer` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `agentmail` | portable | adapted |  | yes | `skills/email/agentmail-sdk` | Shipped as agentmail-sdk (renamed: Hermes optional skills include a CLI-focused "agentmail"). AgentMail MIT: the copyright holder publishes these skills under MIT in agentmail-to/agentmail-plugins; files are byte-identical or few-line revisions. Hermes frontmatter added; reference docs verbatim. | Operator may confirm the licence judgement (source dir had no LICENSE; MIT taken from the copyright holder's agentmail-plugins repo). |
| `agentmail-check-email` | portable | adapted |  | yes | `skills/email/agentmail-check-email` | AgentMail MIT (copyright holder publishes the same skill under MIT in agentmail-to/agentmail-plugins); Hermes frontmatter added. Unshipped sibling (manage-inboxes) reference pointed at agentmail-sdk. | Operator may confirm the licence judgement (source dir had no LICENSE). |
| `agentmail-mcp` | portable | adapted |  | yes | `skills/email/agentmail-mcp` | AgentMail MIT (copyright holder publishes the same skill under MIT in agentmail-to/agentmail-plugins); Hermes frontmatter added. Added Hermes mcp_servers setup (OAuth or x-api-key header). | Operator may confirm the licence judgement (source dir had no LICENSE). |
| `agentmail-send-email` | portable | adapted |  | yes | `skills/email/agentmail-send-email` | AgentMail MIT (copyright holder publishes the same skill under MIT in agentmail-to/agentmail-plugins); Hermes frontmatter added. Unshipped sibling (manage-inboxes) reference pointed at agentmail-sdk. | Operator may confirm the licence judgement (source dir had no LICENSE). |
| `ai-assistant-voice` | host-only | host-only |  | yes |  | Host voice-assistant persona/voice configuration bound to this operator and host services. |  |
| `ai-character-builder` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `ai-engineer-learning` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `all-out-game-development` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `autoloop` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `automation-resilience` | host-only | host-only |  | yes |  | Zo/VPS turn-budget, checkpoint and restart-recovery controller bound to this host's automation ledger and managed processes. | Concept follow-up: portable turn checkpointing and restart recovery for Hermes runs. |
| `bridge-watchdog` | host-only | host-only |  | yes |  | Watches the VPS's own executor bridges and services. |  |
| `broll-injector` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `build-watchdog` | host-only | host-only |  | yes |  | Supervises managed builds on the source host. | Concept follow-up: bounded build watchdog for Hermes-launched builds. |
| `classifier-fallback` | portable | adapted |  | yes | `skills/zouroboros/classifier-fallback` | Host BYOK model ids removed (env-configured fallback, degrading to human_review); ledger and snapshots moved to ZOUROBOROS_STATE_DIR. Not shipped: .gitignore, assets/card-snapshots/ and the runtime ledger. Built-in tests run in CI via tests/skills-portable.test.ts. |  |
| `compile-build-spec` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `consensus-gate` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. | Exclude data/ run output (valve shadow records). |
| `deep-research` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `design-md-drift-guard` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). | Exclude reports/. |
| `destructive-op-guard` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `elevenlabs-skill` | portable | hermes-native |  | yes | Hermes `core TTS provider (tts.elevenlabs)` | Source entry has no SKILL.md (only scripts/elevenlabs.ts.bak), so it is not a loadable skill on the VPS. Hermes core ships ElevenLabs text-to-speech and Scribe transcription (ELEVENLABS_API_KEY). |  |
| `extract-patterns` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `fal-ai-media` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `gamedev-engine-corpus` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `gauntlet-loop` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `graphrag-relational` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `heygen-skills` | portable | adapted |  | yes | `skills/media/heygen-avatar`, `skills/media/heygen-translate`, `skills/media/heygen-video` | HeyGen MIT (LICENSE shipped in each skill). The three sub-skills ship with their references; Hermes frontmatter and an MCP note added; CLI install advice changed from curl\|bash to download-review-run. Not shipped: plugin manifests for other agents, CI workflows, brand images, setup script, the nanoclaw variant, and the operator-specific JHF explainer template (reference file and the heygen-video section pointing to it). |  |
| `host-resilience-probe` | host-only | host-only |  | yes |  | Observes this host's gateway restarts and stream faults; meaningless off the source host. | Concept follow-up: restart detection hook for long Hermes runs. |
| `humanizer-skill` | portable | hermes-native |  | yes | Hermes `humanizer` | Same upstream (blader/humanizer, MIT). The source is v2.1.1; Hermes bundles the newer v2.5.1 as creative/humanizer. Shipping a copy would collide on the name and regress the version. |  |
| `impeccable` | portable | hermes-native |  | yes | Hermes `impeccable (optional catalog)` | Hermes optional skills include an upstream-maintained impeccable catalog entry (pbakaus/impeccable, Apache-2.0) that installs the current release with attribution. The source copy references a NOTICE.md it does not include, so shipping it would not satisfy Apache-2.0 section 4(d). |  |
| `instinct-harvester` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `jhf-daily-top5` | adapt/financial | pending | adapted | yes |  | Triage: financial; carry the financial safety rules into the skill text and remove personal-data references (t6). |  |
| `jhf-strategy-scout` | adapt/financial | pending | adapted | yes |  | Triage: financial; carry the financial safety rules into the skill text and remove personal-data references (t6). |  |
| `operator-collaboration-profile` (redacted) | host-only | host-only |  | yes |  | Operator personal profile drift watcher over private conversation data; personal data, never exported. |  |
| `n8n-setup` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `notebooklm-skill` | adapt/paths | pending | adapted | no |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). | Untracked in the source repository at the pinned revision; the importer only copies tracked blobs, so the source must be committed (or a reviewed import path agreed) before porting. |
| `operator-digest` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `operator-worker` | host-only | host-only |  | no |  | Operator-specific worker for this host; untracked in the source repository. |  |
| `persona-consult` | portable | pending | adapted | yes |  | Reclassified from portable during t1: the script imports Projects/software-template-library (template-library.json, persona-associations) and resolves live persona identities. Neither is in hermes-zouroboros (packages/swarm has specialist-consult only). | Port with the core runtime tasks (t3 or later): ship a portable template/association registry with generic roles, wire scripts/persona-consult.ts to packages/swarm specialist-consult, and replace the host BYOK reviewer pool with env-configured models. |
| `plan-closeout` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `ponytail-audit` | portable | adapted |  | yes | `skills/software-development/ponytail-audit` | Upstream ponytail 4.7.0 (MIT) attribution kept; Hermes frontmatter replaces Zo fields. |  |
| `ponytail-debt` | portable | adapted |  | yes | `skills/software-development/ponytail-debt` | Upstream ponytail 4.7.0 (MIT) attribution kept; script and its tests ship verbatim (tests run in CI via tests/skills-portable.test.ts); paths use ${HERMES_SKILL_DIR}. |  |
| `ponytail-review` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `production-ready` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `rag-telemetry` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `repo-drift-autofix` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `reporeel` | portable | pending | portable | no |  | Re-verified in t1: still untracked at the pinned revision (symlink into the untracked Projects/reporeel-skill), so the importer cannot copy it; left pending. | Untracked in the source repository at the pinned revision; the importer only copies tracked blobs, so the source must be committed (or a reviewed import path agreed) before porting. |
| `skill-security-gate` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `smart-money` | portable | adapted |  | yes | `skills/media/smart-money` | Rewritten operator-neutral: brand, funnel, revenue target and persona identity removed; .env.template (channel ID, handle, voice ID, site URL) not shipped and replaced by a names-only variable table; not-advice and human-approval rules added. The source has no pipeline scripts, so the skill is an orchestration guide. |  |
| `spec-first-interview` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `three-stage-eval` | portable | adapted |  | yes | `skills/software-development/three-stage-eval` | Q00/ouroboros (MIT) origin kept; never-tracked evaluate.ts quick start replaced by an agent-run procedure; zo.space and /zo/ask replaced by generic web checks and Hermes delegate_task consensus. |  |
| `threejs-game-production` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `tier-resolver` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. | Ship a fresh default model catalog; never data/feedback.jsonl or the host catalog/weights. |
| `tradingview-mcp-server` | portable | adapted |  | yes | `skills/research/tradingview-mcp-server` | Fiale Plus MIT (LICENSE shipped). The source is a vendored MCP server repo with no SKILL.md; the distribution ships an authored Hermes skill that registers the pinned npm package as an MCP server, plus upstream field/preset docs. Server source not vendored. |  |
| `ux-laws` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `verity` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `visual-verifier` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `wayfinder` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `workspace-search` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `zo-ask-governor` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `zo-ask-retry` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `zo-memory-system` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. | Exclude scripts/.mcp-trust/ manifest history. |
| `zo-persona-creator` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `zo-swarm-executors` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `zo-swarm-orchestrator` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `zo-to-zo-consult` | host-only | host-only |  | yes |  | Calls between Zo Computer instances; requires the Zo platform. |  |
| `zouroboros` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `zouroboros-evolution-10` | drop | dropped |  | yes |  | Generated evolution-episode stub with no implementation; not a skill. |  |
| `zouroboros-evolve` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `zouroboros-governance` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `zouroboros-introspect` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `zouroboros-memory-evolution` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). | evalsets/memory-baseline.v1.jsonl may ship only as a reviewed synthetic fixture exception. |
| `zouroboros-observatory` | portable | adapted |  | yes | `skills/zouroboros/zouroboros-observatory` | Runs the published zouroboros-observatory@0.1.0 via bunx; Zo Site deploy replaced by private remote-access guidance. | The observatory package itself is not in the hermes-zouroboros packages; consider vendoring it so the distribution does not depend on the npm release. |
| `zouroboros-prescribe` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
