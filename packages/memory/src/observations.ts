#!/usr/bin/env bun
/**
 * observations.ts — Evidence-backed consolidated beliefs
 *
 * Concept adopted from vectorize-io/hindsight's "Observations"
 * (https://github.com/vectorize-io/hindsight): retained facts don't stay a
 * flat pile. Related facts consolidate into observations — deduplicated
 * beliefs that keep their supporting evidence (exact quotes + proof count)
 * and are *refined* rather than overwritten when new evidence arrives, so new
 * information strengthens, weakens, or extends an existing belief instead of
 * silently replacing it.
 *
 * Layer position (Article VIII): observations sit ABOVE facts; they never
 * mutate the fact store. The raw evidence always remains in `facts`.
 *
 * Status lifecycle:
 *  - active    — supported by >= minProof live facts
 *  - contested — a pending conflict exists among its supporting facts
 *  - faded     — live supporting evidence dropped below minProof
 *
 * CLI:
 *   bun observations.ts consolidate [--persona <slug>] [--min-proof 2] [--llm]
 *   bun observations.ts list [--persona <slug>] [--status active|contested|faded]
 *   bun observations.ts show --id <observationId>
 *   bun observations.ts search <query> [--persona <slug>]
 */

import { randomUUID } from 'crypto';
import { getDatabase } from './database.js';
import { llmCall } from './llm.js';
import { reconcileLegacyHookObservations } from './event-observations.js';

export type ObservationStatus = 'active' | 'contested' | 'faded';

export interface Observation {
  id: string;
  persona: string;
  entity: string;
  key: string | null;
  text: string;
  proofCount: number;
  status: ObservationStatus;
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
}

export interface ObservationEvidence {
  observationId: string;
  factId: string;
  quote: string;
  createdAt: number;
}

export interface ConsolidateResult {
  created: number;
  refined: number;
  contested: number;
  faded: number;
  skipped: number;
}

export function ensureObservationSchema(): void {
  const db = getDatabase();
  // Pre-reconciliation VPS databases carry a legacy hook-capture table named
  // `observations` (see event-observations.ts); move it out of the way before
  // creating the belief-observations schema.
  reconcileLegacyHookObservations(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      entity TEXT NOT NULL,
      key TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      proof_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','contested','faded')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      last_evidence_at INTEGER,
      UNIQUE(persona, entity, key)
    );
    CREATE TABLE IF NOT EXISTS observation_evidence (
      observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      quote TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (observation_id, fact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity, key);
    CREATE INDEX IF NOT EXISTS idx_observations_persona ON observations(persona, status);
  `);
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface ObservationRow {
  id: string; persona: string; entity: string; key: string; text: string;
  proof_count: number; status: ObservationStatus;
  created_at: number; updated_at: number; last_evidence_at: number | null;
}

function rowToObservation(r: ObservationRow): Observation {
  return {
    id: r.id, persona: r.persona, entity: r.entity, key: r.key || null,
    text: r.text, proofCount: r.proof_count, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, lastEvidenceAt: r.last_evidence_at,
  };
}

interface FactRow {
  id: string; persona: string; entity: string; key: string | null;
  value: string; importance: number; created_at: number; rowid: number;
}

/** Newest first; rowid breaks second-resolution timestamp ties (facts stored
 *  in the same second still have a well-defined insertion order). */
function byNewest(a: FactRow, b: FactRow): number {
  return b.created_at - a.created_at || b.rowid - a.rowid;
}

function tableExists(name: string): boolean {
  const db = getDatabase();
  const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Synthesis — deterministic by default, LLM-polished when available
// ---------------------------------------------------------------------------

/**
 * Deterministic belief text: the newest evidence value is the current belief
 * (temporal supersession, consistent with conflict-resolver.ts), prefixed
 * with provenance of how many facts back it.
 */
function synthesizeDeterministic(entity: string, key: string | null, facts: FactRow[]): string {
  const newest = [...facts].sort(byNewest)[0];
  const label = key ? `${entity}.${key}` : entity;
  return `${label}: ${newest.value}`;
}

/**
 * LLM synthesis of a one-sentence belief from evidence quotes. Falls back to
 * the deterministic form on any failure (Article IX: fail closed to the safe,
 * cheap path — never lose the observation because a model call failed).
 */
async function synthesizeBelief(entity: string, key: string | null, facts: FactRow[], useLlm: boolean): Promise<string> {
  const fallback = synthesizeDeterministic(entity, key, facts);
  if (!useLlm) return fallback;
  try {
    const label = key ? `${entity}.${key}` : entity;
    const evidence = facts
      .sort(byNewest)
      .slice(0, 10)
      .map(f => `- ${f.value}`)
      .join('\n');
    const result = await llmCall({
      model: process.env.ZO_OBSERVATION_MODEL || 'gpt-4o-mini',
      system: 'You consolidate memory facts into a single evidence-backed belief. One or two sentences, newest evidence wins on conflict, no speculation beyond the evidence.',
      prompt: `Belief subject: ${label}\n\nEvidence (newest first):\n${evidence}\n\nWrite the consolidated belief:`,
      temperature: 0.1,
      maxTokens: 150,
    });
    return result.content.trim() || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Consolidate facts into observations. Groups live facts by
 * (persona, entity, key); groups with >= minProof facts create or refine an
 * observation. Existing observations are refined, never silently replaced:
 * unchanged beliefs only gain evidence rows and proof count.
 */
export async function consolidateObservations(
  options: { persona?: string; minProof?: number; useLlm?: boolean } = {},
): Promise<ConsolidateResult> {
  ensureObservationSchema();
  const db = getDatabase();
  const minProof = options.minProof ?? 2;
  const result: ConsolidateResult = { created: 0, refined: 0, contested: 0, faded: 0, skipped: 0 };

  let sql = `
    SELECT id, persona, entity, key, value, importance, created_at, rowid
    FROM facts
    WHERE (expires_at IS NULL OR expires_at > CAST(strftime('%s','now') AS INTEGER))
  `;
  const params: string[] = [];
  if (options.persona) { sql += ' AND persona = ?'; params.push(options.persona); }

  const facts = db.query(sql).all(...params) as FactRow[];

  // Group by (persona, entity, key)
  const groups = new Map<string, FactRow[]>();
  for (const f of facts) {
    const gk = `${f.persona}${f.entity}${f.key ?? ''}`;
    const g = groups.get(gk);
    if (g) g.push(f); else groups.set(gk, [f]);
  }

  const now = Math.floor(Date.now() / 1000);
  const hasConflicts = tableExists('fact_conflicts');

  for (const group of groups.values()) {
    const { persona, entity } = group[0];
    const key = group[0].key ?? '';

    const existing = db.query(
      'SELECT * FROM observations WHERE persona = ? AND entity = ? AND key = ?',
    ).get(persona, entity, key) as ObservationRow | null;

    if (group.length < minProof) {
      // Below threshold: fade an existing observation, otherwise skip.
      if (existing && existing.status !== 'faded') {
        db.run(`UPDATE observations SET status = 'faded', updated_at = ? WHERE id = ?`, [now, existing.id]);
        result.faded++;
      } else {
        result.skipped++;
      }
      continue;
    }

    // Pending conflict among supporting facts? (contested, hindsight-style
    // "weakened" belief — evidence disagrees and nothing resolved it yet)
    let contested = false;
    if (hasConflicts) {
      const ids = group.map(f => f.id);
      const placeholders = ids.map(() => '?').join(',');
      const row = db.query(
        `SELECT COUNT(*) as c FROM fact_conflicts
         WHERE resolution = 'pending' AND (fact_id IN (${placeholders}) OR conflicting_fact_id IN (${placeholders}))`,
      ).get(...ids, ...ids) as { c: number };
      contested = row.c > 0;
    }

    const text = await synthesizeBelief(entity, key || null, group, options.useLlm ?? false);
    const sorted = [...group].sort(byNewest);
    const lastEvidenceAt = sorted[0].created_at;
    const status: ObservationStatus = contested ? 'contested' : 'active';

    if (!existing) {
      const id = randomUUID();
      db.run(
        `INSERT INTO observations (id, persona, entity, key, text, proof_count, status, created_at, updated_at, last_evidence_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, persona, entity, key, text, group.length, status, now, now, lastEvidenceAt],
      );
      const insEvidence = db.prepare(
        'INSERT OR IGNORE INTO observation_evidence (observation_id, fact_id, quote, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const f of group) insEvidence.run(id, f.id, f.value, now);
      result.created++;
      if (contested) result.contested++;
    } else {
      // Refine, don't overwrite: text only moves when the newest evidence
      // disagrees with the current belief; evidence rows accumulate.
      const textChanged = existing.text !== text;
      db.run(
        `UPDATE observations SET text = ?, proof_count = ?, status = ?, updated_at = ?, last_evidence_at = ? WHERE id = ?`,
        [text, group.length, status, now, lastEvidenceAt, existing.id],
      );
      const insEvidence = db.prepare(
        'INSERT OR IGNORE INTO observation_evidence (observation_id, fact_id, quote, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const f of group) insEvidence.run(existing.id, f.id, f.value, now);
      result.refined++;
      if (contested) result.contested++;
      void textChanged; // status already reflects the refinement via evidence rows
    }
  }

  return result;
}

export function listObservations(
  options: { persona?: string; status?: ObservationStatus; limit?: number } = {},
): Observation[] {
  ensureObservationSchema();
  const db = getDatabase();
  let sql = 'SELECT * FROM observations WHERE 1=1';
  const params: (string | number)[] = [];
  if (options.persona) { sql += ' AND persona = ?'; params.push(options.persona); }
  if (options.status) { sql += ' AND status = ?'; params.push(options.status); }
  sql += ' ORDER BY proof_count DESC, updated_at DESC LIMIT ?';
  params.push(options.limit ?? 50);
  return (db.query(sql).all(...params) as ObservationRow[]).map(rowToObservation);
}

export function getObservation(id: string): { observation: Observation; evidence: ObservationEvidence[] } | null {
  ensureObservationSchema();
  const db = getDatabase();
  const row = db.query('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRow | null;
  if (!row) return null;
  const evidence = db.query(
    'SELECT observation_id, fact_id, quote, created_at FROM observation_evidence WHERE observation_id = ? ORDER BY created_at DESC',
  ).all(id) as Array<{ observation_id: string; fact_id: string; quote: string; created_at: number }>;
  return {
    observation: rowToObservation(row),
    evidence: evidence.map(e => ({ observationId: e.observation_id, factId: e.fact_id, quote: e.quote, createdAt: e.created_at })),
  };
}

export function searchObservations(
  query: string,
  options: { persona?: string; limit?: number } = {},
): Observation[] {
  ensureObservationSchema();
  const db = getDatabase();
  let sql = `SELECT * FROM observations WHERE (text LIKE ? OR entity LIKE ?) AND status != 'faded'`;
  const params: (string | number)[] = [`%${query}%`, `%${query}%`];
  if (options.persona) { sql += ' AND (persona = ? OR persona = ?)'; params.push(options.persona, 'shared'); }
  sql += ' ORDER BY proof_count DESC, updated_at DESC LIMIT ?';
  params.push(options.limit ?? 10);
  return (db.query(sql).all(...params) as ObservationRow[]).map(rowToObservation);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Observations CLI\n\nCommands:\n  consolidate [--persona <slug>] [--min-proof 2] [--llm]\n  list [--persona <slug>] [--status active|contested|faded]\n  show --id <observationId>\n  search <query> [--persona <slug>]');
    process.exit(0);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] || '';
  const command = args[0];

  // Standalone CLI use: open the default DB via the package config loader.
  const { loadConfig } = await import('zouroboros-core');
  const { initDatabase, runMigrations } = await import('./database.js');
  const config = loadConfig();
  const memoryConfig = { ...config.memory };
  const envDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
  if (envDb) memoryConfig.dbPath = envDb;
  initDatabase(memoryConfig);
  runMigrations(memoryConfig);

  if (command === 'consolidate') {
    const r = await consolidateObservations({
      persona: flags.persona,
      minProof: flags['min-proof'] ? parseInt(flags['min-proof'], 10) : undefined,
      useLlm: 'llm' in flags,
    });
    console.log(`Consolidation: ${r.created} created | ${r.refined} refined | ${r.contested} contested | ${r.faded} faded | ${r.skipped} below proof threshold`);
  } else if (command === 'list') {
    const obs = listObservations({ persona: flags.persona, status: flags.status as ObservationStatus | undefined });
    if (obs.length === 0) console.log('No observations.');
    for (const o of obs) console.log(`  [${o.status}] (${o.proofCount} proofs) ${o.text.slice(0, 100)}\n    id=${o.id.slice(0, 8)} persona=${o.persona}`);
  } else if (command === 'show') {
    if (!flags.id) { console.error('--id required'); process.exit(1); }
    const full = getObservation(flags.id) ?? listObservations({ limit: 1000 }).map(o => o.id).filter(i => i.startsWith(flags.id)).map(i => getObservation(i))[0] ?? null;
    if (!full) { console.log('Observation not found.'); process.exit(0); }
    console.log(`[${full.observation.status}] ${full.observation.text}\nproof_count=${full.observation.proofCount}\n\nEvidence:`);
    for (const e of full.evidence) console.log(`  - ${e.quote.slice(0, 120)}`);
  } else if (command === 'search') {
    const query = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
    const obs = searchObservations(query, { persona: flags.persona });
    if (obs.length === 0) console.log(`No observations match "${query}".`);
    for (const o of obs) console.log(`  [${o.status}] (${o.proofCount} proofs) ${o.text.slice(0, 100)}`);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
