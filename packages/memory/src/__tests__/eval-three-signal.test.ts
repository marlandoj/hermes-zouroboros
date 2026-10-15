import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../database.js';
import { runThreeSignalEval, ARM_NAMES, type ThreeSignalReport } from '../eval-three-signal.js';
import { deterministicEmbedding, generateEmbedding, PRODUCTION_EMBEDDING_DIMENSION } from '../embeddings.js';

/** Strip wall-clock noise so two runs can be compared structurally. */
function stripLatency(report: ThreeSignalReport): unknown {
  return JSON.parse(JSON.stringify(report, (key, value) => (key === 'latency' ? undefined : value)));
}

test('deterministic embedding provider is stable, unit-norm, and key-free', async () => {
  const a = deterministicEmbedding('postgres backups stream nightly');
  const b = deterministicEmbedding('postgres backups stream nightly');
  expect(a.length).toBe(PRODUCTION_EMBEDDING_DIMENSION);
  expect(a).toEqual(b);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  expect(Math.abs(norm - 1)).toBeLessThan(1e-9);

  // The provider slots into the generateEmbedding seam with no API key.
  const savedKeys: Record<string, string | undefined> = {};
  for (const key of ['OPENAI_API_KEY', 'ZO_OPENAI_API_KEY']) {
    savedKeys[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const viaSeam = await generateEmbedding('postgres backups stream nightly', {
      enabled: true,
      dbPath: ':memory:',
      vectorEnabled: true,
      embeddingProvider: 'deterministic',
      autoCapture: false,
      captureIntervalMinutes: 30,
      graphBoost: false,
      hydeExpansion: false,
      decayConfig: { permanent: Infinity, stable: 90, active: 14, session: 1, checkpoint: 4 / 24 },
    });
    expect(viaSeam).toEqual(a);
  } finally {
    for (const key of Object.keys(savedKeys)) {
      if (savedKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedKeys[key];
    }
  }
});

// The eval inits its own DB inside runThreeSignalEval; re-initializing a
// throwaway in-memory DB in the finally block keeps the global singleton
// valid for any later test in this process regardless of execution order.
test('three-signal eval: per-signal ablation is deterministic and each signal owns its category', async () => {
  const root = mkdtempSync(join(tmpdir(), 'three-signal-test-'));
  try {
    const report = await runThreeSignalEval(join(root, 'eval.db'));

    expect(report.questions).toBe(35);
    expect(report.topK).toBe(5);

    // ── Fail-closed invariants ──
    // Expired facts must NEVER surface, on any arm, on any query.
    expect(report.stage2.decayExclusion.expiredSurfaced).toBe(0);
    expect(report.stage2.decayExclusion.queriesChecked).toBe(35 * ARM_NAMES.length);
    // The hermetic run costs exactly zero.
    for (const arm of ARM_NAMES) {
      expect(report.arms[arm].efficiency.actualCostUsd).toBe(0);
    }

    // ── Stage 1: mechanical top-1 accuracy per arm (exact) ──
    // Keyword pins are calibrated to this distribution's term-wise searchFacts
    // (every term must occur, wildcards literal; RX-C20261013-1-09), which
    // recalls more than the substring form these fixtures were first pinned
    // under — including paraphrases that share content words.
    expect(report.arms['keyword'].top1Correct).toBe(25);
    expect(report.arms['vector'].top1Correct).toBe(26);
    expect(report.arms['graph'].top1Correct).toBe(10);
    expect(report.arms['keyword-vector'].top1Correct).toBe(27);
    expect(report.arms['all-three'].top1Correct).toBe(31);
    expect(report.arms['no-graph-boost'].top1Correct).toBe(27);
    // The production default (all-three) recalls every answerable gold in top-K.
    expect(report.arms['all-three'].topKCorrect).toBe(35);

    // ── Stage 1: each signal owns its category ──
    expect(report.byCategory['entity-direct']['keyword']).toBe(6);
    expect(report.byCategory['entity-direct']['graph']).toBe(0);
    // Term-wise keyword matching reaches paraphrases that share content words;
    // only the vector arm covers the full paraphrase set.
    expect(report.byCategory['semantic-paraphrase']['vector']).toBe(6);
    expect(report.byCategory['semantic-paraphrase']['keyword']).toBe(5);
    expect(report.byCategory['graph-linked']['graph']).toBe(4);
    expect(report.byCategory['graph-linked']['keyword']).toBe(0);
    expect(report.byCategory['graph-linked']['vector']).toBe(0);
    expect(report.byCategory['graph-linked']['all-three']).toBe(4);
    expect(report.byCategory['graph-linked']['no-graph-boost']).toBe(0);
    // Temporal updates: the importance-ordered stale fact wins on EVERY arm —
    // the known staleness failure mode, measured (the L0/L1 tier fixes it;
    // see eval-heldout-recall).
    for (const arm of ARM_NAMES) {
      expect(report.byCategory['temporal-update'][arm]).toBe(0);
    }

    // ── Stage 2: semantic behaviors ──
    expect(report.stage2.paraphraseRecall['vector']).toEqual({ hit: 6, total: 6 });
    expect(report.stage2.paraphraseRecall['keyword']).toEqual({ hit: 5, total: 6 });
    for (const arm of ARM_NAMES) {
      expect(report.stage2.nearMissRejection[arm]).toEqual({ rejected: 6, total: 6 });
    }
    expect(report.stage2.correctionRecall['vector']).toEqual({ hit: 3, total: 3 });
    expect(report.stage2.correctionRecall['all-three']).toEqual({ hit: 3, total: 3 });
    expect(report.stage2.correctionRecall['keyword']).toEqual({ hit: 2, total: 3 });
    expect(report.stage2.contestedAbstention['all-three']).toEqual({ abstained: 3, total: 3 });
    expect(report.stage2.contestedAbstention['keyword']).toEqual({ abstained: 3, total: 3 });
    // Graph-boost contribution > 0 on entity-linked questions (exact: +4).
    expect(report.stage2.graphBoostContribution.contribution).toBe(4);
    expect(report.stage2.graphBoostContribution.allThreeCorrect).toBe(4);
    expect(report.stage2.graphBoostContribution.noBoostCorrect).toBe(0);

    // ── Stage 3: consensus ──
    expect(report.stage3.abVerdict.verdict).toBe('helps');
    expect(report.stage3.abVerdict.delta).toBe(4);
    // Internal consistency: the gate with graphBoost off IS the hybrid path.
    const hybridVsNoBoost = report.stage3.agreement.find(
      p => p.a === 'keyword-vector' && p.b === 'no-graph-boost',
    );
    expect(hybridVsNoBoost?.top1AgreementRate).toBe(1);

    // ── Efficiency accounting ──
    expect(report.arms['vector'].efficiency.embeddingCalls).toBe(35);
    expect(report.arms['all-three'].efficiency.embeddingCalls).toBe(35);
    expect(report.arms['keyword'].efficiency.embeddingCalls).toBe(0);
    expect(report.arms['graph'].efficiency.embeddingCalls).toBe(0);
    expect(report.arms['all-three'].efficiency.realProviderCostUsd).toBeGreaterThan(0);

    // ── Determinism: a second run on a fresh DB is structurally identical ──
    const again = await runThreeSignalEval(join(root, 'eval2.db'));
    expect(stripLatency(again)).toEqual(stripLatency(report));
  } finally {
    // Leave the singleton pointing at a live in-memory DB for later files.
    try {
      initDatabase({
        enabled: true,
        dbPath: ':memory:',
        vectorEnabled: false,
        autoCapture: false,
        captureIntervalMinutes: 30,
        graphBoost: false,
        hydeExpansion: false,
        decayConfig: { permanent: Infinity, stable: 90, active: 14, session: 1, checkpoint: 4 / 24 },
      });
      closeDatabase();
    } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60000 });
