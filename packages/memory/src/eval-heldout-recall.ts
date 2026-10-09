#!/usr/bin/env bun
/**
 * eval-heldout-recall.ts — Held-out recall eval for the adopted L0/L1 tier
 * (observations + mental models) versus a retrieval-only baseline.
 *
 * Article II (no evolution without verification): this harness measures what
 * the hindsight/OpenViking adoption actually buys before anyone enables it by
 * default.
 *
 * Method
 *  - Synthetic fixture bank: 40 facts across 4 categories (mental-model
 *    evidence, temporal updates, contested pairs, one-offs) + 4 standing
 *    questions + 4 pending conflicts. Fully deterministic, zero API calls
 *    (OPENAI_API_KEY is stripped inside runHeldoutEval and restored after,
 *    so every LLM path falls back to its deterministic tier).
 *  - Held-out discipline: the 24 questions are authored against the bank
 *    schema but are invisible to every construction code path — fact
 *    consolidation and mental-model refresh run BEFORE and INDEPENDENTLY of
 *    the question set. No question text influences any stored artifact.
 *  - Arms:
 *      baseline — keyword retrieval top-1 (the graceful-fallback tier;
 *        importance-ordered, which deterministically surfaces the STALE fact
 *        on temporal updates and cannot abstain on conflicts);
 *      tier     — mental-model exact read (0 tokens) → observation search
 *        (0 tokens; contested → ABSTAIN) → same retrieval fallback.
 *  - Scoring: case-insensitive containment of the gold substring; contested
 *    questions score correct only on abstention.
 *  - LLM-equivalent calls: modeled production cost per answered question
 *    (baseline = 1 gated answer call per question; tier = 0 on L0/L1 hits,
 *    1 on retrieval fallback). The eval itself makes no real calls.
 *
 * Limitations (read before quoting numbers)
 *  - The baseline is the KEYWORD retrieval path, not full hybrid+HyDE+LLM
 *    answering; a natural-language LLM baseline would score higher on the
 *    lexical-gap questions. That full eval is a deliberate follow-up.
 *  - Latency is DB-path wall time only; production baseline latency also
 *    includes the per-question LLM call (~0.5–2s per packages/memory docs).
 *
 * Usage: bun packages/memory/src/eval-heldout-recall.ts [--json]
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { MemoryConfig } from 'zouroboros-core';
import { initDatabase, runMigrations, getDatabase, closeDatabase } from './database.js';
import { storeFact, searchFacts } from './facts.js';
import { consolidateObservations, searchObservations } from './observations.js';
import { defineMentalModel, readMentalModel, refreshMentalModel } from './mental-models.js';

// ---------------------------------------------------------------------------
// Fixture bank
// ---------------------------------------------------------------------------

interface FixtureFact {
  entity: string;
  key: string;
  value: string;
  persona?: string;
  importance: number;
}

/** Mental-model evidence — high importance so all 8 land in the top-10 digest. */
const MM_FACTS: FixtureFact[] = [
  { entity: 'user.preferences', key: 'editor', value: 'Editor: Neovim with tokyonight theme, relative line numbers', importance: 0.97 },
  { entity: 'user.preferences', key: 'terminal', value: 'Terminal: tmux with prefix Ctrl-A, vi copy mode', importance: 0.97 },
  { entity: 'deploy.arch', key: 'api', value: 'API runs on a Hetzner CX32 in Falkenstein behind Caddy', importance: 0.97 },
  { entity: 'deploy.arch', key: 'db', value: 'Postgres 16 primary with daily restic backups to B2', importance: 0.97 },
  { entity: 'user.routine', key: 'review', value: 'Weekly review every Sunday 18:00 UTC in the Zouroboros dashboard', importance: 0.97 },
  { entity: 'user.routine', key: 'plan', value: 'Review ends with a Linear backlog sync and a Monday plan', importance: 0.96 },
  { entity: 'researcher.research', key: 'topic', value: 'The researcher persona is evaluating cross-encoder rerankers for memory recall', persona: 'researcher', importance: 0.97 },
  { entity: 'researcher.research', key: 'method', value: 'The researcher persona benchmarks rerankers on held-out question sets', persona: 'researcher', importance: 0.96 },
];

/** Temporal updates: stale fact has HIGHER importance, so the retrieval
 *  baseline deterministically surfaces it; the observation takes the newest. */
const UPDATE_GROUPS: Array<{ entity: string; oldValue: string; newValue: string; gold: string }> = [
  { entity: 'deploy.region', oldValue: 'Deployment region is us-east-1 (legacy)', newValue: 'Deployment region migrated to eu-central-1', gold: 'eu-central-1' },
  { entity: 'api.version', oldValue: 'API version v1.4.2 in production', newValue: 'API version v2.0.0 in production', gold: 'v2.0.0' },
  { entity: 'db.host', oldValue: 'Postgres primary on db-old.internal', newValue: 'Postgres primary on db-new.internal', gold: 'db-new.internal' },
  { entity: 'cache.backend', oldValue: 'Cache backend is Redis 6', newValue: 'Cache backend is Valkey 8', gold: 'Valkey 8' },
  { entity: 'ci.runner', oldValue: 'CI runs on GitHub-hosted runners', newValue: 'CI runs on self-hosted BuildJet runners', gold: 'BuildJet' },
  { entity: 'auth.provider', oldValue: 'Auth via Auth0', newValue: 'Auth via Keycloak', gold: 'Keycloak' },
  { entity: 'docs.framework', oldValue: 'Docs built with Docusaurus', newValue: 'Docs built with Astro Starlight', gold: 'Astro Starlight' },
  { entity: 'metrics.stack', oldValue: 'Metrics via Datadog', newValue: 'Metrics via self-hosted Prometheus and Grafana', gold: 'Prometheus' },
];

/** Contested pairs: unresolved contradiction — the right move is abstention. */
const CONTESTED_GROUPS: Array<{ entity: string; valueA: string; valueB: string }> = [
  { entity: 'deploy.strategy', valueA: 'Blue-green deploys are the standard', valueB: 'Rolling deploys are the standard' },
  { entity: 'api.protocol', valueA: 'Public API is GraphQL only', valueB: 'Public API is REST only' },
  { entity: 'db.sharding', valueA: 'Sharding is enabled for all tenants', valueB: 'Sharding is disabled for all tenants' },
  { entity: 'cache.ttl', valueA: 'Cache TTL is 60 seconds', valueB: 'Cache TTL is 3600 seconds' },
];

/** One-off facts: no corroboration, so no observation forms — both arms must
 *  answer from raw retrieval (fairness check). */
const ONEOFF_FACTS: Array<{ entity: string; value: string; gold: string }> = [
  { entity: 'vendor.dns', value: 'DNS provider is Cloudflare with DNSSEC enabled', gold: 'Cloudflare' },
  { entity: 'license.server', value: 'Server license is MIT with a patent grant', gold: 'MIT' },
  { entity: 'monitor.uptime', value: 'Uptime target is 99.95% measured monthly', gold: '99.95' },
  { entity: 'backup.window', value: 'Backup window is 02:00-03:00 UTC daily', gold: '02:00-03:00' },
  { entity: 'log.retention', value: 'Log retention is 30 days in Loki', gold: '30 days' },
  { entity: 'tls.policy', value: 'TLS minimum version is 1.3 everywhere', gold: '1.3' },
  { entity: 'queue.broker', value: 'Queue broker is NATS JetStream', gold: 'NATS' },
  { entity: 'cdn.provider', value: 'CDN is Bunny with image optimization', gold: 'Bunny' },
];

const STANDING_QUESTIONS: Array<{ persona?: string; question: string }> = [
  { question: 'What are the user editor and terminal preferences?' },
  { question: 'What is the production deployment architecture?' },
  { question: 'What is the user weekly review routine?' },
  { persona: 'researcher', question: 'What is the researcher persona current research focus?' },
];

// ---------------------------------------------------------------------------
// Held-out question set (invisible to every construction path above)
// ---------------------------------------------------------------------------

type Category = 'mental-model' | 'observation-update' | 'observation-contested' | 'retrieval';

interface EvalQuestion {
  category: Category;
  question: string;
  /** Keyword the retrieval path searches with (mimics gate keyword extraction). */
  searchTerm: string;
  /** Gold substring, or the literal 'ABSTAIN' for contested questions. */
  gold: string;
  persona?: string;
}

const QUESTIONS: EvalQuestion[] = [
  // Mental-model questions: natural-language retrieval terms miss lexically.
  { category: 'mental-model', question: 'What are the user editor and terminal preferences?', searchTerm: 'editor terminal setup', gold: 'Neovim' },
  { category: 'mental-model', question: 'What is the production deployment architecture?', searchTerm: 'deployment architecture', gold: 'Hetzner' },
  { category: 'mental-model', question: 'What is the user weekly review routine?', searchTerm: 'weekly review routine', gold: 'Sunday 18:00' },
  { category: 'mental-model', question: 'What is the researcher persona current research focus?', searchTerm: 'research focus', gold: 'cross-encoder', persona: 'researcher' },
  // Temporal updates: baseline surfaces the stale fact by importance.
  ...UPDATE_GROUPS.map(g => ({
    category: 'observation-update' as const,
    question: `What is the current state of ${g.entity}?`,
    searchTerm: g.entity,
    gold: g.gold,
  })),
  // Contested: correct behavior is abstention.
  ...CONTESTED_GROUPS.map(g => ({
    category: 'observation-contested' as const,
    question: `Which statement about ${g.entity} is true?`,
    searchTerm: g.entity,
    gold: 'ABSTAIN',
  })),
  // One-offs: both arms must answer (fairness check).
  ...ONEOFF_FACTS.map(f => ({
    category: 'retrieval' as const,
    question: `What do we know about ${f.entity}?`,
    searchTerm: f.entity,
    gold: f.gold,
  })),
];

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

type TierPath = 'mental-model' | 'observation' | 'observation-contested' | 'retrieval-fallback';

interface ArmAnswer {
  answer: string;
  path: TierPath;
  abstained: boolean;
}

export interface ArmSummary {
  correct: number;
  correctAbstentions: number;
  llmEquivalentCalls: number;
  meanLatencyMs: number;
}

export interface EvalReport {
  questions: number;
  baseline: ArmSummary;
  tier: ArmSummary;
  byCategory: Record<Category, { total: number; baselineCorrect: number; tierCorrect: number }>;
  rows: Array<{
    category: Category;
    question: string;
    gold: string;
    baselineOk: boolean;
    tierOk: boolean;
    tierPath: TierPath;
  }>;
}

function evalConfig(dbPath: string): MemoryConfig {
  return {
    enabled: true,
    dbPath,
    vectorEnabled: false,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    autoCapture: false,
    captureIntervalMinutes: 30,
    graphBoost: false,
    hydeExpansion: false,
    decayConfig: { permanent: Infinity, long: 365, medium: 90, short: 30 },
  };
}

async function seedBank(config: MemoryConfig): Promise<void> {
  for (const f of MM_FACTS) {
    await storeFact({ entity: f.entity, key: f.key, value: f.value, persona: f.persona, importance: f.importance, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
  }
  for (const o of ONEOFF_FACTS) {
    await storeFact({ entity: o.entity, key: 'fact', value: o.value, importance: 0.5, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
  }
  // Update groups: stale fact first with HIGHER importance, fresh fact second.
  for (const g of UPDATE_GROUPS) {
    await storeFact({ entity: g.entity, key: 'state', value: g.oldValue, importance: 0.85, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
    await storeFact({ entity: g.entity, key: 'state', value: g.newValue, importance: 0.8, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
  }
  // Contested groups + pending conflict rows (same DDL as conflict-resolver.ts).
  const db = getDatabase();
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
  for (const g of CONTESTED_GROUPS) {
    const a = await storeFact({ entity: g.entity, key: 'claim', value: g.valueA, importance: 0.7, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
    const b = await storeFact({ entity: g.entity, key: 'claim', value: g.valueB, importance: 0.7, category: 'fact', decay: 'long', source: 'eval-fixture' }, config);
    db.run(
      `INSERT INTO fact_conflicts (id, fact_id, conflicting_fact_id, conflict_type, resolution) VALUES (?, ?, ?, 'semantic', 'pending')`,
      [randomUUID(), a.id, b.id],
    );
  }
}

function baselineAnswer(q: EvalQuestion): ArmAnswer {
  const hits = searchFacts(q.searchTerm, { persona: q.persona, limit: 3 });
  if (hits.length === 0) return { answer: '(no result)', path: 'retrieval-fallback', abstained: false };
  return { answer: hits[0].value, path: 'retrieval-fallback', abstained: false };
}

function tierAnswer(q: EvalQuestion): ArmAnswer {
  const persona = q.persona ?? 'shared';
  const mm = readMentalModel(persona, q.question);
  if (mm && mm.answer.trim().length > 0) {
    return { answer: mm.answer, path: 'mental-model', abstained: false };
  }
  const obs = searchObservations(q.searchTerm, { persona, limit: 1 });
  if (obs.length > 0) {
    if (obs[0].status === 'contested') {
      return { answer: 'ABSTAIN (contested evidence)', path: 'observation-contested', abstained: true };
    }
    return { answer: obs[0].text, path: 'observation', abstained: false };
  }
  return baselineAnswer(q);
}

function score(q: EvalQuestion, r: ArmAnswer): boolean {
  if (q.gold === 'ABSTAIN') return r.abstained;
  return r.answer.toLowerCase().includes(q.gold.toLowerCase());
}

function timed<T>(fn: () => T): { result: T; latencyMs: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, latencyMs: performance.now() - t0 };
}

export async function runHeldoutEval(dbPath: string): Promise<EvalReport> {
  // Hermetic: strip API keys so every LLM path takes its deterministic
  // fallback (mental-model digest). Restored before returning.
  const savedKeys: Record<string, string | undefined> = {};
  for (const key of ['OPENAI_API_KEY', 'ZO_OPENAI_API_KEY']) {
    savedKeys[key] = process.env[key];
    delete process.env[key];
  }

  const config = evalConfig(dbPath);
  try {
    initDatabase(config);
    runMigrations(config);

    // ── Construction phase — no question text participates. ──
    await seedBank(config);
    await consolidateObservations({ useLlm: false });
    for (const sq of STANDING_QUESTIONS) {
      const model = defineMentalModel({ persona: sq.persona, question: sq.question });
      await refreshMentalModel(model.id);
    }

    // ── Evaluation phase — held-out questions against frozen artifacts. ──
    const rows: EvalReport['rows'] = [];
    const byCategory = {} as EvalReport['byCategory'];
    let baselineCorrect = 0;
    let baselineAbstentions = 0;
    let baselineLatency = 0;
    let tierCorrect = 0;
    let tierAbstentions = 0;
    let tierFallbacks = 0;
    let tierLatency = 0;

    for (const q of QUESTIONS) {
      const b = timed(() => baselineAnswer(q));
      const t = timed(() => tierAnswer(q));
      const baselineOk = score(q, b.result);
      const tierOk = score(q, t.result);

      baselineLatency += b.latencyMs;
      tierLatency += t.latencyMs;
      if (baselineOk) baselineCorrect++;
      if (b.result.abstained) baselineAbstentions++;
      if (tierOk) tierCorrect++;
      if (t.result.abstained) tierAbstentions++;
      if (t.result.path === 'retrieval-fallback') tierFallbacks++;

      const cat = (byCategory[q.category] ??= { total: 0, baselineCorrect: 0, tierCorrect: 0 });
      cat.total++;
      if (baselineOk) cat.baselineCorrect++;
      if (tierOk) cat.tierCorrect++;

      rows.push({
        category: q.category,
        question: q.question,
        gold: q.gold,
        baselineOk,
        tierOk,
        tierPath: t.result.path,
      });
    }

    const n = QUESTIONS.length;
    return {
      questions: n,
      baseline: {
        correct: baselineCorrect,
        correctAbstentions: baselineAbstentions,
        llmEquivalentCalls: n, // every question costs a gated answer call
        meanLatencyMs: baselineLatency / n,
      },
      tier: {
        correct: tierCorrect,
        correctAbstentions: tierAbstentions,
        llmEquivalentCalls: tierFallbacks, // L0/L1 hits cost zero
        meanLatencyMs: tierLatency / n,
      },
      byCategory,
      rows,
    };
  } finally {
    closeDatabase();
    for (const key of Object.keys(savedKeys)) {
      if (savedKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedKeys[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(report: EvalReport): string {
  const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(1)}%`;
  const lines: string[] = [
    '## Held-out recall eval — L0/L1 tier (observations + mental models) vs retrieval-only baseline',
    '',
    `Bank: 40 facts (8 mental-model evidence, 16 temporal updates, 8 contested, 8 one-offs), 4 standing questions, 4 pending conflicts. ${report.questions} held-out questions. Zero API calls (deterministic tiers only).`,
    '',
    '| Arm | Correct | Accuracy | Correct abstentions | LLM-equivalent calls | Mean DB-path latency |',
    '|---|---|---|---|---|---|',
    `| baseline (retrieval-only) | ${report.baseline.correct}/${report.questions} | ${pct(report.baseline.correct, report.questions)} | ${report.baseline.correctAbstentions} | ${report.baseline.llmEquivalentCalls} | ${report.baseline.meanLatencyMs.toFixed(2)} ms |`,
    `| L0/L1 tier (MM + observations) | ${report.tier.correct}/${report.questions} | ${pct(report.tier.correct, report.questions)} | ${report.tier.correctAbstentions} | ${report.tier.llmEquivalentCalls} | ${report.tier.meanLatencyMs.toFixed(2)} ms |`,
    '',
    '| Category | Questions | Baseline correct | Tier correct |',
    '|---|---|---|---|',
    ...Object.entries(report.byCategory).map(
      ([cat, s]) => `| ${cat} | ${s.total} | ${s.baselineCorrect} | ${s.tierCorrect} |`,
    ),
    '',
    `Tier path usage: ${report.rows.filter(r => r.tierPath === 'mental-model').length} mental-model, ${report.rows.filter(r => r.tierPath === 'observation').length} observation, ${report.rows.filter(r => r.tierPath === 'observation-contested').length} contested-abstain, ${report.rows.filter(r => r.tierPath === 'retrieval-fallback').length} retrieval-fallback.`,
    '',
    'Limitations: baseline is the keyword retrieval path, not full hybrid+HyDE+LLM answering (a natural-language LLM baseline would score higher on the lexical-gap mental-model questions; that full eval is a follow-up). Latency is DB-path wall time only — production baseline latency additionally includes ~0.5–2s of LLM time per question.',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'heldout-recall-'));
  try {
    const report = await runHeldoutEval(join(root, 'eval.db'));
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
    console.error(`held-out recall eval failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
