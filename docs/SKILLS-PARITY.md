# Skill parity manifest

<!-- Generated from provenance/skills-parity.json by `bun scripts/ci/skills-parity.ts render`. Do not edit by hand. -->

Source: the Zouroboros VPS workspace `Skills/` tree at revision `b6dff3e5e6c12070f90064f4146f9f08d8612d01` — 80 entries.
CI fails if an entry is missing, a disposition lacks a reason, or a shipped skill directory is unclaimed.
Entry names containing operator identifiers are redacted to `operator`; the manifest keeps the SHA-256 of the real name for completeness checks.

| Disposition | Count |
| --- | ---: |
| portable | 0 |
| adapted | 0 |
| host-only | 8 |
| dropped | 3 |
| hermes-native | 0 |
| held-license | 0 |
| pending | 69 |
| **total** | **80** |

Pending work: 19 planned portable, 50 planned adapted.

Dispositions: `portable` ships unchanged apart from recorded hashes; `adapted` ships with recorded changes; `host-only` stays on the VPS; `dropped` is not a skill; `hermes-native` is covered by a bundled Hermes skill; `held-license` awaits a licensing decision; `pending` is not yet ported.

| Entry | Triage | Disposition | Planned | Tracked at revision | Distributed as | Reason | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `-help-skill` | drop | dropped |  | yes |  | Generated stub ("--help" parsed as a skill name) from another instance; not a real skill. |  |
| `_candidates` | drop | dropped |  | yes |  | Staging area for generated candidate skills and expired queue items, not a skill. |  |
| `academy-video-pipeline` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `agent-doctor` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `agent-email-patterns` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `agent-introspect` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `agent-model-healer` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `agentmail` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `agentmail-check-email` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `agentmail-mcp` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `agentmail-send-email` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `ai-assistant-voice` | host-only | host-only |  | yes |  | Host voice-assistant persona/voice configuration bound to this operator and host services. |  |
| `ai-character-builder` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `ai-engineer-learning` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `all-out-game-development` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `autoloop` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. |  |
| `automation-resilience` | host-only | host-only |  | yes |  | Zo/VPS turn-budget, checkpoint and restart-recovery controller bound to this host's automation ledger and managed processes. | Concept follow-up: portable turn checkpointing and restart recovery for Hermes runs. |
| `bridge-watchdog` | host-only | host-only |  | yes |  | Watches the VPS's own executor bridges and services. |  |
| `broll-injector` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `build-watchdog` | host-only | host-only |  | yes |  | Supervises managed builds on the source host. | Concept follow-up: bounded build watchdog for Hermes-launched builds. |
| `classifier-fallback` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). | Exclude assets/card-snapshots/ (captured run output). |
| `compile-build-spec` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `consensus-gate` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. | Exclude data/ run output (valve shadow records). |
| `deep-research` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `design-md-drift-guard` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). | Exclude reports/. |
| `destructive-op-guard` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `elevenlabs-skill` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `extract-patterns` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `fal-ai-media` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `gamedev-engine-corpus` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `gauntlet-loop` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `graphrag-relational` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `heygen-skills` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `host-resilience-probe` | host-only | host-only |  | yes |  | Observes this host's gateway restarts and stream faults; meaningless off the source host. | Concept follow-up: restart detection hook for long Hermes runs. |
| `humanizer-skill` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). | Hermes bundles a 'humanizer' skill: merge into it or ship under a non-colliding name; never two skills named humanizer. |
| `impeccable` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `instinct-harvester` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `jhf-daily-top5` | adapt/financial | pending | adapted | yes |  | Triage: financial; carry the financial safety rules into the skill text and remove personal-data references (t6). |  |
| `jhf-strategy-scout` | adapt/financial | pending | adapted | yes |  | Triage: financial; carry the financial safety rules into the skill text and remove personal-data references (t6). |  |
| `operator-collaboration-profile` (redacted) | host-only | host-only |  | yes |  | Operator personal profile drift watcher over private conversation data; personal data, never exported. |  |
| `n8n-setup` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `notebooklm-skill` | adapt/paths | pending | adapted | no |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). | Untracked in the source repository at the pinned revision; the importer only copies tracked blobs, so the source must be committed (or a reviewed import path agreed) before porting. |
| `operator-digest` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
| `operator-worker` | host-only | host-only |  | no |  | Operator-specific worker for this host; untracked in the source repository. |  |
| `persona-consult` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `plan-closeout` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `ponytail-audit` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `ponytail-debt` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `ponytail-review` | adapt/zo-api | pending | adapted | yes |  | Triage: Zo API rewrite; replace Zo ask/space/ZO_* API use with the Hermes provider/model layer (t4). |  |
| `production-ready` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `rag-telemetry` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `repo-drift-autofix` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `reporeel` | portable | pending | portable | no |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). | Untracked in the source repository at the pinned revision; the importer only copies tracked blobs, so the source must be committed (or a reviewed import path agreed) before porting. |
| `skill-security-gate` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `smart-money` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). | Ship .env.template only with empty placeholders, as a reviewed exception. |
| `spec-first-interview` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `three-stage-eval` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `threejs-game-production` | adapt/paths | pending | adapted | yes |  | Triage: host paths; replace hardcoded workspace/state paths with portable configuration (t6/t7). |  |
| `tier-resolver` | adapt/core-runtime | pending | adapted | yes |  | Triage: core runtime; wire to the distribution packages (memory, swarm, selfheal, rag, workflow, personas, core) instead of duplicating code. | Ship a fresh default model catalog; never data/feedback.jsonl or the host catalog/weights. |
| `tradingview-mcp-server` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
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
| `zouroboros-observatory` | portable | pending | portable | yes |  | Triage: portable; re-verify files, licence and leak gate when ported (t1). |  |
| `zouroboros-prescribe` | adapt/self-improvement | pending | adapted | yes |  | Triage: self-improvement; make shared-memory, log and state paths configurable under the portable state root (t5). |  |
