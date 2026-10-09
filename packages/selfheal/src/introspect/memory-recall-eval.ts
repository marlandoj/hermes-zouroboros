#!/usr/bin/env bun
/**
 * Synthetic memory-recall eval for introspect's Memory Recall metric.
 *
 * Replaces the source host's eval-continuation.ts, which lived in a workspace skill. This one ships
 * with the distribution and never reads live memory: it seeds a throwaway SQLite database (scratch
 * directory, removed afterwards) with the synthetic facts in memory-recall-fixtures.json, then asks
 * each case through the distribution's memory package — keyword retrieval (searchFacts) ranked by
 * keyword hits, fused with graph-boosted search (searchFactsGraphBoosted). A case passes when an
 * expected phrase appears in the top 3 facts. No network, no model call, no embedding provider.
 *
 * Output (parsed by the collector and the playbook metric commands):
 *   Cases: N / Passed: M / Rate: X%      or one JSON report with --json
 *
 * Overrides: ZOUROBOROS_MEMORY_RECALL_FIXTURES (fixture file).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type MemorySearchResult } from 'zouroboros-core';
import { closeDatabase, extractQueryEntities, initDatabase, runMigrations, searchFacts, searchFactsGraphBoosted, storeFact } from 'zouroboros-memory';

export interface RecallFixtureSet {
  name: string;
  threshold: number;
  facts: { entity: string; key: string; value: string }[];
  cases: { id: string; query: string; expectAny: string[] }[];
}
export interface RecallReport { name: string; cases: number; passed: number; rate: number; failed: string[] }

export const DEFAULT_FIXTURES = fileURLToPath(new URL('./memory-recall-fixtures.json', import.meta.url));
const TOP_K = 3;
const STOPWORDS = new Set(['what', 'which', 'when', 'where', 'does', 'did', 'the', 'for', 'and', 'how', 'many', 'long', 'who', 'owns', 'use', 'uses', 'get', 'after', 'take', 'keep', 'next', 'step', 'with', 'that', 'this', 'from', 'our', 'have', 'has', 'are', 'was', 'were']);

export function keywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

function recall(query: string): string[] {
  const hits = new Map<string, { result: MemorySearchResult; count: number; first: number }>();
  let order = 0;
  for (const word of keywords(query)) {
    for (const entry of searchFacts(word, { limit: 50 })) {
      const hit = hits.get(entry.id) ?? { result: { entry, score: 0, matchType: 'exact' as const }, count: 0, first: order++ };
      hit.count++;
      hits.set(entry.id, hit);
    }
  }
  const base = [...hits.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((hit) => hit.result);
  return searchFactsGraphBoosted(base, extractQueryEntities(query), { limit: TOP_K })
    .map((result) => `${result.entry.entity} ${result.entry.key ?? ''} ${result.entry.value}`.toLowerCase());
}

export async function runRecallEval(fixturesPath = process.env.ZOUROBOROS_MEMORY_RECALL_FIXTURES || DEFAULT_FIXTURES): Promise<RecallReport> {
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as RecallFixtureSet;
  const scratch = mkdtempSync(join(tmpdir(), 'memory-recall-eval-'));
  const config = { ...DEFAULT_CONFIG.memory, dbPath: join(scratch, 'eval.db'), vectorEnabled: false, autoCapture: false };
  try {
    initDatabase(config);
    runMigrations(config);
    for (const fact of fixtures.facts) await storeFact({ ...fact, decay: 'permanent', source: 'synthetic-eval' }, config);
    const failed = fixtures.cases.filter((c) => {
      const top = recall(c.query);
      return !c.expectAny.some((needle) => top.some((text) => text.includes(needle.toLowerCase())));
    }).map((c) => c.id);
    const cases = fixtures.cases.length;
    const passed = cases - failed.length;
    return { name: fixtures.name, cases, passed, rate: cases ? passed / cases : 0, failed };
  } finally {
    closeDatabase();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runRecallEval().then((report) => {
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Memory recall eval (${report.name}, synthetic, hermetic)`);
      console.log(`Cases: ${report.cases}`);
      console.log(`Passed: ${report.passed}`);
      console.log(`Rate: ${(report.rate * 100).toFixed(1)}%`);
      if (report.failed.length) console.log(`Failed: ${report.failed.join(', ')}`);
    }
  }, (error) => {
    console.error(`memory recall eval failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
