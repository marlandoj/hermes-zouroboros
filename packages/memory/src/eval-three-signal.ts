#!/usr/bin/env bun
/**
 * eval-three-signal.ts — Per-signal ablation harness for three-signal retrieval
 * (keyword + vector + graph), following the three-stage-eval discipline:
 * mechanical → semantic → consensus.
 *
 * Measures the LIVE default path (`routeMemoryQuery`, which fuses
 * searchFactsHybrid keyword+vector RRF with the graph boost) against each
 * signal in isolation, so regressions in any one signal are attributable.
 *
 * Method
 *  - Hermetic: mkdtemp scratch DB; OPENAI_API_KEY/ZO_OPENAI_API_KEY stripped
 *    and restored (same discipline as eval-heldout-recall.ts); the routing
 *    log's DB path env (ZOUROBOROS_MEMORY_DB) is redirected to the scratch DB
 *    so `routeMemoryQuery`'s best-effort logging never touches a real DB.
 *  - Vector arm runs on the `deterministic` embedding provider (signed
 *    hashing-trick bag-of-tokens, embeddings.ts): zero cost, zero network,
 *    byte-identical across machines. It exercises the vector plumbing and RRF
 *    fusion; real semantic quality belongs to the nightly real-embedding lane.
 *  - Golden manifest: entity-direct facts (keyword-friendly), paraphrase +
 *    near-miss pairs (vector territory), graph-linked hub→spoke groups
 *    (episode co-occurrence; `extractQueryEntities` only fires when a query
 *    word equals a fact entity name, and the graph boost surfaces facts of
 *    RELATED entities — so gold lives on the spoke), temporal-update groups
 *    (stale fact seeded with HIGHER importance), contested pairs with pending
 *    fact_conflicts rows (correct = abstain), decay-expiry fixtures (expired
 *    fact seeded with HIGHER importance — if the expiry filter ever breaks,
 *    the expired fact wins and the gate goes red), and correction-recall
 *    groups (wrong fact outranks the correction on importance; only
 *    token-overlap retrieval recovers the correction).
 *  - Dotted entities (e.g. `deploy.region`) are graph-neutral by
 *    construction: extractQueryEntities strips punctuation from query words,
 *    so a dotted entity name can never match. Single-word entities are the
 *    graph arm's territory.
 *  - Arms: keyword, vector, graph, keyword+vector (searchFactsHybrid),
 *    all-three (routeMemoryQuery, graphBoost on — the production default),
 *    no-graph-boost (routeMemoryQuery, graphBoost off — the A/B mirror).
 *  - Abstention policy (uniform across arms): if the top-1 fact is half of a
 *    pending fact_conflicts pair and its counterpart also surfaced in top-K,
 *    the arm abstains. Near-miss queries are correct only on an EMPTY result
 *    set (strict rejection).
 *  - Stage 1 (mechanical): deterministic top-1/top-K accuracy per arm and
 *    per category; exact assertions in the CI test.
 *  - Stage 2 (semantic): paraphrase recall, near-miss rejection, correction
 *    recall, decay-expiry exclusion (must be zero surfaced), graph-boost
 *    contribution on entity-linked questions, contested abstention.
 *  - Stage 3 (consensus): pairwise top-1 arm agreement + the A/B verdict
 *    (graph boost helps / hurts / neutral, with numbers).
 *  - Efficiency on every query: latency p50/p95/mean per arm, embedding-call
 *    counts, estimated query+context tokens (chars/4), context size, and the
 *    cost the same run would incur on the real embedding provider.
 *
 * Usage: bun packages/memory/src/eval-three-signal.ts [--json] [--embedding-provider=openai]
 *   (default provider is deterministic; openai uses the real embedding API)
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { MemoryConfig, MemorySearchResult } from 'zouroboros-core';
import { initDatabase, runMigrations, getDatabase, closeDatabase } from './database.js';
import { storeFact, searchFacts, searchFactsVector, searchFactsHybrid } from './facts.js';
import { searchFactsGraphBoosted, extractQueryEntities, invalidateGraphCache } from './graph.js';
import { routeMemoryQuery } from './routing-gate.js';
import { resolveScope } from './scope.js';
import { createEpisode } from './episodes.js';
import { DETERMINISTIC_EMBEDDING_MODEL } from './embeddings.js';

// ---------------------------------------------------------------------------
// Golden manifest
// ---------------------------------------------------------------------------

export const TOP_K = 5;

/** Entity-direct: single-word entities, query = entity name (keyword territory). */
const ENTITY_DIRECT: Array<{ entity: string; value: string; gold: string }> = [
  { entity: 'quartz', value: 'Quartz schedules the nightly maintenance sweep at 03:15 UTC', gold: '03:15' },
  { entity: 'forge', value: 'Forge builds release artifacts with reproducible checksums', gold: 'reproducible' },
  { entity: 'lumen', value: 'Lumen renders the status dashboard from streamed metrics', gold: 'dashboard' },
  { entity: 'pylon', value: 'Pylon terminates TLS and forwards traffic to the internal mesh', gold: 'TLS' },
  { entity: 'vertex', value: 'Vertex stores workflow definitions as signed documents', gold: 'signed' },
  { entity: 'crucible', value: 'Crucible replays failed jobs against candidate fixes', gold: 'replays' },
];

/** Paraphrase + near-miss pairs on dotted (graph-neutral) entities.
 *  Paraphrases share most content tokens with the fact; near-misses share
 *  almost none and have NO stored answer — correct behavior is an empty
 *  result set. */
const PARAPHRASE_GROUPS: Array<{ entity: string; value: string; paraphrase: string; nearMiss: string; gold: string }> = [
  {
    entity: 'workspace.editor',
    value: 'Primary editor is Neovim with tokyonight theme and relative line numbers',
    paraphrase: 'neovim editor tokyonight theme relative line numbers',
    nearMiss: 'emacs solarized palette absolute gutter numbering',
    gold: 'Neovim',
  },
  {
    entity: 'deploy.host',
    value: 'Production API served from a Hetzner CX32 box in Falkenstein',
    paraphrase: 'hetzner cx32 falkenstein production api box',
    nearMiss: 'graviton instance virginia staging frontend droplet',
    gold: 'Hetzner',
  },
  {
    entity: 'db.backup',
    value: 'Postgres backups stream nightly to Backblaze B2 with restic',
    paraphrase: 'restic streams postgres backups nightly backblaze b2',
    nearMiss: 'mysql dumps weekly glacier archive borg',
    gold: 'restic',
  },
  {
    entity: 'queue.broker',
    value: 'Task queue runs on NATS JetStream with three replicas',
    paraphrase: 'nats jetstream task queue three replicas',
    nearMiss: 'rabbitmq cluster five mirrors message fanout',
    gold: 'NATS',
  },
  {
    entity: 'docs.site',
    value: 'Documentation site is built with Astro Starlight and deployed on push',
    paraphrase: 'astro starlight documentation site deployed push',
    nearMiss: 'docusaurus wiki published manually each friday',
    gold: 'Starlight',
  },
  {
    entity: 'alerts.channel',
    value: 'Pager alerts route to the oncall channel with severity tags',
    paraphrase: 'pager alerts oncall channel severity tags route',
    nearMiss: 'email digest weekly summary inbox folder',
    gold: 'oncall',
  },
];

/** Graph-linked hub→spoke groups. The query names the hub entity plus filler
 *  words that appear in NO stored fact; the gold fact lives on the spoke,
 *  reachable only through episode co-occurrence. Keyword and vector miss by
 *  construction — this isolates the graph signal. */
const GRAPH_GROUPS: Array<{
  hub: string; hubValue: string;
  spoke: string; spokeValue: string;
  episode: string; query: string; gold: string;
}> = [
  {
    hub: 'herald', hubValue: 'Herald service health is green',
    spoke: 'signalbus', spokeValue: 'Signalbus fans messages across sharded consumers',
    episode: 'Incident review traced delivery lag', query: 'herald downstream fanout dependency', gold: 'sharded',
  },
  {
    hub: 'atlas', hubValue: 'Atlas ingestion pipeline is enabled',
    spoke: 'ledgerd', spokeValue: 'Ledgerd persists events in append-only segments',
    episode: 'Capacity planning walkthrough', query: 'atlas storage persistence layer', gold: 'append-only',
  },
  {
    hub: 'sentinel', hubValue: 'Sentinel probe cadence is five minutes',
    spoke: 'warden', spokeValue: 'Warden quarantines suspicious payloads before handoff',
    episode: 'Security triage session', query: 'sentinel escalation handler target', gold: 'quarantines',
  },
  {
    hub: 'beacon', hubValue: 'Beacon emits heartbeat pulses on the mesh',
    spoke: 'relayd', spokeValue: 'Relayd forwards pulses to regional collectors',
    episode: 'Observability rollout review', query: 'beacon downstream forwarding chain', gold: 'collectors',
  },
];

/** Temporal updates: stale fact seeded FIRST with HIGHER importance, so the
 *  importance-ordered keyword path deterministically surfaces the stale one. */
const UPDATE_GROUPS: Array<{ entity: string; oldValue: string; newValue: string; gold: string }> = [
  { entity: 'deploy.region', oldValue: 'Deployment region is us-east-1 (legacy)', newValue: 'Deployment region migrated to eu-central-1', gold: 'eu-central-1' },
  { entity: 'api.version', oldValue: 'API version v1.4.2 in production', newValue: 'API version v2.0.0 in production', gold: 'v2.0.0' },
  { entity: 'cache.backend', oldValue: 'Cache backend is Redis 6', newValue: 'Cache backend is Valkey 8', gold: 'Valkey 8' },
  { entity: 'ci.runner', oldValue: 'CI runs on hosted runners', newValue: 'CI runs on self-hosted BuildJet runners', gold: 'BuildJet' },
];

/** Contested pairs: unresolved contradiction — correct behavior is abstention. */
const CONTESTED_GROUPS: Array<{ entity: string; valueA: string; valueB: string }> = [
  { entity: 'deploy.strategy', valueA: 'Blue-green deploys are the standard', valueB: 'Rolling deploys are the standard' },
  { entity: 'api.protocol', valueA: 'Public API is GraphQL only', valueB: 'Public API is REST only' },
  { entity: 'db.sharding', valueA: 'Sharding is enabled for all tenants', valueB: 'Sharding is disabled for all tenants' },
];

/** Decay-expiry: the expired fact gets HIGHER importance than its live
 *  replacement — if the expires_at filter ever breaks on any arm, the expired
 *  fact outranks the gold and the gate goes red. */
const DECAY_GROUPS: Array<{ entity: string; expiredValue: string; liveValue: string; gold: string }> = [
  { entity: 'token.rotation', expiredValue: 'Stale guidance: rotate tokens quarterly by hand', liveValue: 'Tokens rotate automatically every 30 days', gold: '30 days' },
  { entity: 'cert.renewal', expiredValue: 'Certificates renewed manually via support ticket', liveValue: 'Certificates auto-renew through ACME with a 21 day window', gold: 'ACME' },
  { entity: 'log.purge', expiredValue: 'Logs purged ad hoc when disk fills', liveValue: 'Logs purge on a 45 day retention schedule', gold: '45 day' },
];

/** Correction recall: the wrong fact outranks the correction on importance;
 *  the query shares tokens with the CORRECTION, so token-overlap retrieval
 *  (vector) must recover it while importance-ordered keyword surfaces the
 *  wrong one (or nothing — the query is never a contiguous substring). */
const CORRECTION_GROUPS: Array<{ entity: string; wrongValue: string; correctionValue: string; query: string; gold: string }> = [
  {
    entity: 'backup.cadence',
    wrongValue: 'Backups run weekly on Fridays',
    correctionValue: 'Correction: backups actually run nightly at 02:00 UTC',
    query: 'backups actually run at utc',
    gold: '02:00',
  },
  {
    entity: 'mesh.port',
    wrongValue: 'Mesh gateway listens on port 8080',
    correctionValue: 'Correction: mesh gateway now listens on port 9443',
    query: 'which port does the mesh gateway now listen on',
    gold: '9443',
  },
  {
    entity: 'retry.budget',
    wrongValue: 'Retry budget is three attempts per request',
    correctionValue: 'Correction: retry budget raised to five attempts with jitter',
    query: 'retry budget attempts raised with jitter',
    gold: 'five',
  },
];

// ---------------------------------------------------------------------------
// Question set
// ---------------------------------------------------------------------------

export type Category =
  | 'entity-direct'
  | 'semantic-paraphrase'
  | 'semantic-near-miss'
  | 'graph-linked'
  | 'temporal-update'
  | 'contested'
  | 'decay-expiry'
  | 'correction';

interface EvalQuestion {
  category: Category;
  query: string;
  /** Gold substring, or 'ABSTAIN' (contested) / 'NONE' (near-miss rejection). */
  gold: string;
}

const QUESTIONS: EvalQuestion[] = [
  ...ENTITY_DIRECT.map(f => ({ category: 'entity-direct' as const, query: f.entity, gold: f.gold })),
  ...PARAPHRASE_GROUPS.map(g => ({ category: 'semantic-paraphrase' as const, query: g.paraphrase, gold: g.gold })),
  ...PARAPHRASE_GROUPS.map(g => ({ category: 'semantic-near-miss' as const, query: g.nearMiss, gold: 'NONE' })),
  ...GRAPH_GROUPS.map(g => ({ category: 'graph-linked' as const, query: g.query, gold: g.gold })),
  ...UPDATE_GROUPS.map(g => ({ category: 'temporal-update' as const, query: g.entity, gold: g.gold })),
  ...CONTESTED_GROUPS.map(g => ({ category: 'contested' as const, query: g.entity, gold: 'ABSTAIN' })),
  ...DECAY_GROUPS.map(g => ({ category: 'decay-expiry' as const, query: g.entity, gold: g.gold })),
  ...CORRECTION_GROUPS.map(g => ({ category: 'correction' as const, query: g.query, gold: g.gold })),
];

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

export type ArmName = 'keyword' | 'vector' | 'graph' | 'keyword-vector' | 'all-three' | 'no-graph-boost';

/** Single eval identity: all fixtures and arms share one scope. */
const EVAL_ACTOR = 'eval-three-signal';
const EVAL_SCOPE = resolveScope(EVAL_ACTOR);

export const ARM_NAMES: ArmName[] = ['keyword', 'vector', 'graph', 'keyword-vector', 'all-three', 'no-graph-boost'];

/** Arms that generate one query embedding per question. */
const EMBEDDING_ARMS: ReadonlySet<ArmName> = new Set(['vector', 'keyword-vector', 'all-three', 'no-graph-boost']);

function evalConfig(dbPath: string, graphBoost: boolean, embeddingProvider: 'deterministic' | 'openai' = 'deterministic'): MemoryConfig {
  return {
    enabled: true,
    dbPath,
    vectorEnabled: true,
    embeddingProvider,
    embeddingModel: embeddingProvider === 'deterministic' ? DETERMINISTIC_EMBEDDING_MODEL : 'text-embedding-3-small',
    autoCapture: false,
    captureIntervalMinutes: 30,
    graphBoost,
    hydeExpansion: false,
    decayConfig: { permanent: Infinity, stable: 90, active: 14, session: 1, checkpoint: 4 / 24 },
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface SeededBank {
  /** fact id → counterpart fact id for every pending conflict pair. */
  conflictPairs: Map<string, string>;
  /** fact ids that are expired and must NEVER surface on any arm. */
  expiredIds: Set<string>;
}

async function seedBank(config: MemoryConfig): Promise<SeededBank> {
  const db = getDatabase();

  for (const f of ENTITY_DIRECT) {
    await storeFact({ actor: EVAL_ACTOR, entity: f.entity, key: 'fact', value: f.value, importance: 0.9, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
  }
  for (const g of PARAPHRASE_GROUPS) {
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'fact', value: g.value, importance: 0.9, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
  }
  for (const g of GRAPH_GROUPS) {
    await storeFact({ actor: EVAL_ACTOR, entity: g.hub, key: 'fact', value: g.hubValue, importance: 0.6, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    await storeFact({ actor: EVAL_ACTOR, entity: g.spoke, key: 'fact', value: g.spokeValue, importance: 0.9, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    createEpisode({ summary: g.episode, outcome: 'resolved', entities: [g.hub, g.spoke] });
  }
  // Temporal: stale fact first with HIGHER importance.
  for (const g of UPDATE_GROUPS) {
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'state', value: g.oldValue, importance: 0.85, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'state', value: g.newValue, importance: 0.8, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
  }
  // Contested pairs + pending conflict rows (same DDL as conflict-resolver.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_conflicts (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      conflicting_fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      conflict_type TEXT NOT NULL,
      resolution TEXT CHECK(resolution IN ('superseded','merged','flagged','pending')),
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  const conflictPairs = new Map<string, string>();
  for (const g of CONTESTED_GROUPS) {
    const a = await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'claim', value: g.valueA, importance: 0.7, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    const b = await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'claim', value: g.valueB, importance: 0.7, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    db.run(
      `INSERT INTO fact_conflicts (id, fact_id, conflicting_fact_id, conflict_type, resolution) VALUES (?, ?, ?, 'semantic', 'pending')`,
      [randomUUID(), a.id, b.id],
    );
    conflictPairs.set(a.id, b.id);
    conflictPairs.set(b.id, a.id);
  }
  // Decay-expiry: expired fact has HIGHER importance; expiry forced into the past.
  const expiredIds = new Set<string>();
  for (const g of DECAY_GROUPS) {
    const expired = await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'policy', value: g.expiredValue, importance: 0.95, category: 'fact', decay: 'checkpoint', source: 'eval-fixture' }, config);
    db.run('UPDATE facts SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 1000, expired.id]);
    expiredIds.add(expired.id);
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'policy', value: g.liveValue, importance: 0.6, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
  }
  // Correction recall: wrong fact first with HIGHER importance.
  for (const g of CORRECTION_GROUPS) {
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'note', value: g.wrongValue, importance: 0.9, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
    await storeFact({ actor: EVAL_ACTOR, entity: g.entity, key: 'note', value: g.correctionValue, importance: 0.7, category: 'fact', decay: 'stable', source: 'eval-fixture' }, config);
  }
  return { conflictPairs, expiredIds };
}

// ---------------------------------------------------------------------------
// Answer policy + scoring
// ---------------------------------------------------------------------------

interface ArmAnswer {
  results: MemorySearchResult[];
  answer: string;
  abstained: boolean;
}

function answerFromResults(results: MemorySearchResult[], bank: SeededBank): ArmAnswer {
  if (results.length === 0) return { results, answer: '(no result)', abstained: false };
  const top = results[0];
  const counterpart = bank.conflictPairs.get(top.entry.id);
  if (counterpart && results.some(r => r.entry.id === counterpart)) {
    return { results, answer: 'ABSTAIN (contested evidence)', abstained: true };
  }
  return { results, answer: top.entry.value, abstained: false };
}

function scoreTop1(q: EvalQuestion, a: ArmAnswer): boolean {
  if (q.gold === 'NONE') return a.results.length === 0;
  if (q.gold === 'ABSTAIN') return a.abstained;
  return !a.abstained && a.results.length > 0 && a.results[0].entry.value.toLowerCase().includes(q.gold.toLowerCase());
}

function scoreTopK(q: EvalQuestion, a: ArmAnswer): boolean {
  if (q.gold === 'NONE') return a.results.length === 0;
  if (q.gold === 'ABSTAIN') return a.abstained;
  return a.results.some(r => r.entry.value.toLowerCase().includes(q.gold.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** text-embedding-3-small list price, USD per token (the cost this run would
 *  incur per embedded query on the real provider; the hermetic run spends $0). */
const REAL_EMBEDDING_USD_PER_TOKEN = 0.02 / 1_000_000;

const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export interface ArmEfficiency {
  embeddingCalls: number;
  estimatedQueryTokens: number;
  estimatedContextTokens: number;
  meanContextChars: number;
  actualCostUsd: number;
  realProviderCostUsd: number;
}

export interface ArmMetrics {
  top1Correct: number;
  topKCorrect: number;
  correctAbstentions: number;
  correctRejections: number;
  latency: { p50Ms: number; p95Ms: number; meanMs: number };
  efficiency: ArmEfficiency;
}

export interface ThreeSignalReport {
  questions: number;
  topK: number;
  arms: Record<ArmName, ArmMetrics>;
  byCategory: Record<Category, { total: number } & Record<ArmName, number>>;
  stage2: {
    paraphraseRecall: Record<ArmName, { hit: number; total: number }>;
    nearMissRejection: Record<ArmName, { rejected: number; total: number }>;
    correctionRecall: Record<ArmName, { hit: number; total: number }>;
    contestedAbstention: Record<ArmName, { abstained: number; total: number }>;
    decayExclusion: { expiredSurfaced: number; queriesChecked: number };
    graphBoostContribution: { entityLinkedQuestions: number; allThreeCorrect: number; noBoostCorrect: number; contribution: number };
  };
  stage3: {
    agreement: Array<{ a: ArmName; b: ArmName; top1AgreementRate: number }>;
    abVerdict: { verdict: 'helps' | 'hurts' | 'neutral'; allThreeTop1: number; noBoostTop1: number; delta: number };
  };
  rows: Array<{
    category: Category;
    query: string;
    gold: string;
    perArm: Record<ArmName, { top1Ok: boolean; topKOk: boolean; hits: number }>;
  }>;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1) + 0.5))];
}

function perArm<T>(make: () => T): Record<ArmName, T> {
  return Object.fromEntries(ARM_NAMES.map(a => [a, make()])) as Record<ArmName, T>;
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

export async function runThreeSignalEval(dbPath: string, embeddingProvider: 'deterministic' | 'openai' = 'deterministic'): Promise<ThreeSignalReport> {
  // Hermetic (deterministic provider): strip API keys (every LLM/embedding
  // network path must fail or fall back deterministically) and redirect the
  // routing-log DB path env to the scratch DB. Both restored before returning.
  // With the openai provider (nightly real-embedding lane), keys are kept.
  const savedEnv: Record<string, string | undefined> = {};
  const stripKeys = embeddingProvider === 'deterministic'
    ? ['OPENAI_API_KEY', 'ZO_OPENAI_API_KEY', 'ZOUROBOROS_MEMORY_DB', 'ZO_MEMORY_DB']
    : ['ZOUROBOROS_MEMORY_DB', 'ZO_MEMORY_DB'];
  for (const key of stripKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ZOUROBOROS_MEMORY_DB = dbPath;

  const boostConfig = evalConfig(dbPath, true, embeddingProvider);
  const noBoostConfig = evalConfig(dbPath, false, embeddingProvider);

  try {
    initDatabase(boostConfig);
    runMigrations(boostConfig);

    // ── Construction phase — no question text participates. ──
    const bank = await seedBank(boostConfig);
    invalidateGraphCache();

    const armRunners: Record<ArmName, (q: EvalQuestion) => Promise<MemorySearchResult[]>> = {
      keyword: async q =>
        searchFacts(q.query, { actor: EVAL_ACTOR, limit: TOP_K }).map((entry, rank) => ({
          entry,
          score: 1 / (rank + 1),
          matchType: 'exact' as const,
        })),
      vector: q => searchFactsVector(q.query, boostConfig, { actor: EVAL_ACTOR, limit: TOP_K }),
      graph: async q => searchFactsGraphBoosted([], extractQueryEntities(q.query, EVAL_SCOPE), EVAL_SCOPE, { limit: TOP_K }),
      'keyword-vector': q => searchFactsHybrid(q.query, boostConfig, { actor: EVAL_ACTOR, limit: TOP_K }),
      'all-three': q => routeMemoryQuery(q.query, boostConfig, { actor: EVAL_ACTOR, limit: TOP_K }),
      'no-graph-boost': q => routeMemoryQuery(q.query, noBoostConfig, { actor: EVAL_ACTOR, limit: TOP_K }),
    };

    // ── Evaluation phase — held-out questions against the frozen bank. ──
    const latencies = perArm<number[]>(() => []);
    const metrics = perArm<ArmMetrics>(() => ({
      top1Correct: 0, topKCorrect: 0, correctAbstentions: 0, correctRejections: 0,
      latency: { p50Ms: 0, p95Ms: 0, meanMs: 0 },
      efficiency: { embeddingCalls: 0, estimatedQueryTokens: 0, estimatedContextTokens: 0, meanContextChars: 0, actualCostUsd: 0, realProviderCostUsd: 0 },
    }));
    const byCategory = {} as ThreeSignalReport['byCategory'];
    const rows: ThreeSignalReport['rows'] = [];
    const paraphraseRecall = perArm(() => ({ hit: 0, total: 0 }));
    const correctionRecall = perArm(() => ({ hit: 0, total: 0 }));
    const nearMissRejection = perArm(() => ({ rejected: 0, total: 0 }));
    const contestedAbstention = perArm(() => ({ abstained: 0, total: 0 }));
    let expiredSurfaced = 0;
    const contextChars = perArm(() => 0);
    const top1Ids = perArm<Array<string | null>>(() => []);
    const graphContribution = { entityLinkedQuestions: 0, allThreeCorrect: 0, noBoostCorrect: 0, contribution: 0 };

    for (const q of QUESTIONS) {
      const cat = (byCategory[q.category] ??= Object.assign({ total: 0 }, perArm(() => 0)));
      cat.total++;

      const rowPerArm = {} as Record<ArmName, { top1Ok: boolean; topKOk: boolean; hits: number }>;
      const perArmTop1Ok = {} as Record<ArmName, boolean>;

      for (const arm of ARM_NAMES) {
        const t0 = performance.now();
        const results = await armRunners[arm](q);
        const latencyMs = performance.now() - t0;
        latencies[arm].push(latencyMs);

        // Fail-closed invariant: an expired fact surfacing ANYWHERE is a defect.
        expiredSurfaced += results.filter(r => bank.expiredIds.has(r.entry.id)).length;

        const a = answerFromResults(results, bank);
        const top1Ok = scoreTop1(q, a);
        const topKOk = scoreTopK(q, a);
        const m = metrics[arm];
        if (top1Ok) { m.top1Correct++; cat[arm]++; }
        if (topKOk) m.topKCorrect++;
        if (q.gold === 'ABSTAIN') {
          contestedAbstention[arm].total++;
          if (a.abstained) { m.correctAbstentions++; contestedAbstention[arm].abstained++; }
        }
        if (q.gold === 'NONE') {
          nearMissRejection[arm].total++;
          if (results.length === 0) { m.correctRejections++; nearMissRejection[arm].rejected++; }
        }
        if (q.category === 'semantic-paraphrase') {
          paraphraseRecall[arm].total++;
          if (topKOk) paraphraseRecall[arm].hit++;
        }
        if (q.category === 'correction') {
          correctionRecall[arm].total++;
          if (top1Ok) correctionRecall[arm].hit++;
        }

        const ctxChars = results.reduce((sum, r) => sum + r.entry.value.length, 0);
        contextChars[arm] += ctxChars;
        const queryTokens = estimateTokens(q.query.length);
        m.efficiency.estimatedQueryTokens += queryTokens;
        m.efficiency.estimatedContextTokens += estimateTokens(ctxChars);
        if (EMBEDDING_ARMS.has(arm)) {
          m.efficiency.embeddingCalls += 1;
          m.efficiency.realProviderCostUsd += queryTokens * REAL_EMBEDDING_USD_PER_TOKEN;
        }

        top1Ids[arm].push(results.length > 0 ? results[0].entry.id : null);
        perArmTop1Ok[arm] = top1Ok;
        rowPerArm[arm] = { top1Ok, topKOk, hits: results.length };
      }

      if (q.category === 'graph-linked') {
        graphContribution.entityLinkedQuestions++;
        if (perArmTop1Ok['all-three']) graphContribution.allThreeCorrect++;
        if (perArmTop1Ok['no-graph-boost']) graphContribution.noBoostCorrect++;
      }

      rows.push({ category: q.category, query: q.query, gold: q.gold, perArm: rowPerArm });
    }
    graphContribution.contribution = graphContribution.allThreeCorrect - graphContribution.noBoostCorrect;

    const n = QUESTIONS.length;
    for (const arm of ARM_NAMES) {
      const sorted = [...latencies[arm]].sort((a, b) => a - b);
      metrics[arm].latency = {
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        meanMs: sorted.reduce((s, v) => s + v, 0) / n,
      };
      metrics[arm].efficiency.meanContextChars = contextChars[arm] / n;
      metrics[arm].efficiency.realProviderCostUsd = Number(metrics[arm].efficiency.realProviderCostUsd.toFixed(8));
    }

    const agreement: ThreeSignalReport['stage3']['agreement'] = [];
    for (let i = 0; i < ARM_NAMES.length; i++) {
      for (let j = i + 1; j < ARM_NAMES.length; j++) {
        const a = ARM_NAMES[i];
        const b = ARM_NAMES[j];
        let agree = 0;
        for (let k = 0; k < n; k++) {
          if (top1Ids[a][k] === top1Ids[b][k]) agree++;
        }
        agreement.push({ a, b, top1AgreementRate: Number((agree / n).toFixed(4)) });
      }
    }

    const allThreeTop1 = metrics['all-three'].top1Correct;
    const noBoostTop1 = metrics['no-graph-boost'].top1Correct;
    const delta = allThreeTop1 - noBoostTop1;

    return {
      questions: n,
      topK: TOP_K,
      arms: metrics,
      byCategory,
      stage2: {
        paraphraseRecall,
        nearMissRejection,
        correctionRecall,
        contestedAbstention,
        decayExclusion: { expiredSurfaced, queriesChecked: n * ARM_NAMES.length },
        graphBoostContribution: graphContribution,
      },
      stage3: {
        agreement,
        abVerdict: {
          verdict: delta > 0 ? 'helps' : delta < 0 ? 'hurts' : 'neutral',
          allThreeTop1,
          noBoostTop1,
          delta,
        },
      },
      rows,
    };
  } finally {
    closeDatabase();
    invalidateGraphCache();
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(report: ThreeSignalReport): string {
  const pct = (x: number, total: number) => (total === 0 ? 'n/a' : `${((x / total) * 100).toFixed(1)}%`);
  const n = report.questions;
  const lines: string[] = [
    '## Three-signal retrieval eval — per-signal ablation (mechanical → semantic → consensus)',
    '',
    `${n} held-out questions, top-K=${report.topK}, deterministic pseudo-embeddings (zero network, zero cost). Arms: ${ARM_NAMES.join(', ')}.`,
    '',
    '### Stage 1 — mechanical (top-1 / top-K accuracy)',
    '',
    '| Arm | Top-1 | Top-K | Abstentions | Rejections | p50 | p95 | Embedding calls | Mean context chars |',
    '|---|---|---|---|---|---|---|---|---|',
    ...ARM_NAMES.map(a => {
      const m = report.arms[a];
      return `| ${a} | ${m.top1Correct}/${n} (${pct(m.top1Correct, n)}) | ${m.topKCorrect}/${n} | ${m.correctAbstentions} | ${m.correctRejections} | ${m.latency.p50Ms.toFixed(2)} ms | ${m.latency.p95Ms.toFixed(2)} ms | ${m.efficiency.embeddingCalls} | ${m.efficiency.meanContextChars.toFixed(0)} |`;
    }),
    '',
    '| Category | Total | ' + ARM_NAMES.join(' | ') + ' |',
    '|---|---|' + ARM_NAMES.map(() => '---').join('|') + '|',
    ...(Object.entries(report.byCategory) as Array<[string, { total: number } & Record<ArmName, number>]>).map(
      ([cat, s]) => `| ${cat} | ${s.total} | ` + ARM_NAMES.map(a => s[a]).join(' | ') + ' |',
    ),
    '',
    '### Stage 2 — semantic behaviors',
    '',
    '| Behavior | ' + ARM_NAMES.join(' | ') + ' |',
    '|---|' + ARM_NAMES.map(() => '---').join('|') + '|',
    '| Paraphrase recall | ' + ARM_NAMES.map(a => `${report.stage2.paraphraseRecall[a].hit}/${report.stage2.paraphraseRecall[a].total}`).join(' | ') + ' |',
    '| Near-miss rejection | ' + ARM_NAMES.map(a => `${report.stage2.nearMissRejection[a].rejected}/${report.stage2.nearMissRejection[a].total}`).join(' | ') + ' |',
    '| Correction recall | ' + ARM_NAMES.map(a => `${report.stage2.correctionRecall[a].hit}/${report.stage2.correctionRecall[a].total}`).join(' | ') + ' |',
    '| Contested abstention | ' + ARM_NAMES.map(a => `${report.stage2.contestedAbstention[a].abstained}/${report.stage2.contestedAbstention[a].total}`).join(' | ') + ' |',
    '',
    `Decay-expiry exclusion: ${report.stage2.decayExclusion.expiredSurfaced} expired facts surfaced across ${report.stage2.decayExclusion.queriesChecked} arm-queries (must be 0).`,
    `Graph-boost contribution on entity-linked questions: all-three ${report.stage2.graphBoostContribution.allThreeCorrect}/${report.stage2.graphBoostContribution.entityLinkedQuestions} vs no-boost ${report.stage2.graphBoostContribution.noBoostCorrect}/${report.stage2.graphBoostContribution.entityLinkedQuestions} → contribution ${report.stage2.graphBoostContribution.contribution}.`,
    '',
    '### Stage 3 — consensus',
    '',
    '| Arm pair | Top-1 agreement |',
    '|---|---|',
    ...report.stage3.agreement.map(p => `| ${p.a} vs ${p.b} | ${(p.top1AgreementRate * 100).toFixed(1)}% |`),
    '',
    `A/B verdict: graph boost **${report.stage3.abVerdict.verdict}** — all-three ${report.stage3.abVerdict.allThreeTop1}/${n} vs no-graph-boost ${report.stage3.abVerdict.noBoostTop1}/${n} (delta ${report.stage3.abVerdict.delta >= 0 ? '+' : ''}${report.stage3.abVerdict.delta}).`,
    '',
    'Limitations: the vector arm runs on deterministic hashed-token pseudo-embeddings, which measure plumbing and token-overlap retrieval, not real semantic quality — the nightly real-embedding lane owns that. Latency is DB-path wall time only.',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const providerArg = process.argv.find(a => a.startsWith('--embedding-provider='));
  const embeddingProvider = providerArg?.split('=')[1] === 'openai' ? 'openai' as const : 'deterministic' as const;
  const root = mkdtempSync(join(tmpdir(), 'three-signal-'));
  try {
    const report = await runThreeSignalEval(join(root, 'eval.db'), embeddingProvider);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`three-signal eval failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
