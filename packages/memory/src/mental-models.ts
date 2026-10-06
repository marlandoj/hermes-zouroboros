#!/usr/bin/env bun
/**
 * mental-models.ts — Standing answers to standing questions
 *
 * Concept adopted from vectorize-io/hindsight's "Mental Models" / knowledge
 * pages (https://github.com/vectorize-io/hindsight): a mental model is a
 * standing answer to a question about a memory space ("What are this user's
 * preferences?"). You define the question once; the answer is written by a
 * background refresh and READS ARE PLAIN DATABASE READS — no retrieval, no
 * LLM call — so an agent can boot with settled knowledge instead of
 * rediscovering it every session.
 *
 * This is also the OpenViking L0/L1 principle applied to memory: a cheap,
 * pre-computed tier that is scanned first, with expensive retrieval (L2)
 * reserved for questions the standing pages can't answer.
 *
 * Constitution alignment:
 *  - Article VII (Resource Governance): reads cost zero tokens; refreshes
 *    route through the cheap default model and only run when due.
 *  - Article IX (Fail-Safe Defaults): if the model call fails, refresh falls
 *    back to a deterministic evidence digest — the page is never lost.
 *
 * CLI:
 *   bun mental-models.ts define --persona <slug> --question "..." [--interval 86400]
 *   bun mental-models.ts refresh --id <modelId>
 *   bun mental-models.ts refresh-due
 *   bun mental-models.ts read --persona <slug> --question "..."
 *   bun mental-models.ts list [--persona <slug>]
 */

import { randomUUID } from 'crypto';
import { getDatabase } from './database.js';
import { llmCall } from './llm.js';

export interface MentalModel {
  id: string;
  persona: string;
  question: string;
  answer: string;
  model: string | null;
  evidenceCount: number;
  refreshIntervalS: number;
  refreshedAt: number | null;
  createdAt: number;
}

export function ensureMentalModelSchema(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mental_models (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      model TEXT,
      evidence_count INTEGER DEFAULT 0,
      refresh_interval_s INTEGER DEFAULT 86400,
      refreshed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(persona, question)
    );
    CREATE INDEX IF NOT EXISTS idx_mental_models_persona ON mental_models(persona);
  `);
}

interface MentalModelRow {
  id: string; persona: string; question: string; answer: string;
  model: string | null; evidence_count: number; refresh_interval_s: number;
  refreshed_at: number | null; created_at: number;
}

function rowToMentalModel(r: MentalModelRow): MentalModel {
  return {
    id: r.id, persona: r.persona, question: r.question, answer: r.answer,
    model: r.model, evidenceCount: r.evidence_count,
    refreshIntervalS: r.refresh_interval_s, refreshedAt: r.refreshed_at, createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Define / read
// ---------------------------------------------------------------------------

/** Define a standing question for a persona. Idempotent per (persona, question). */
export function defineMentalModel(input: {
  persona?: string;
  question: string;
  refreshIntervalS?: number;
}): MentalModel {
  ensureMentalModelSchema();
  const db = getDatabase();
  const persona = input.persona || 'shared';
  const existing = db.query(
    'SELECT * FROM mental_models WHERE persona = ? AND question = ?',
  ).get(persona, input.question) as MentalModelRow | null;
  if (existing) return rowToMentalModel(existing);

  const id = randomUUID();
  db.run(
    'INSERT INTO mental_models (id, persona, question, refresh_interval_s) VALUES (?, ?, ?, ?)',
    [id, persona, input.question, input.refreshIntervalS ?? 86400],
  );
  return rowToMentalModel(db.query('SELECT * FROM mental_models WHERE id = ?').get(id) as MentalModelRow);
}

/**
 * Read a standing answer. This is deliberately a PLAIN DATABASE READ — the
 * defining property of the concept: no retrieval, no LLM call, zero tokens.
 * Returns null when the question was never defined; returns the model with an
 * empty answer when it is defined but not yet refreshed (caller may trigger
 * refreshMentalModel).
 */
export function readMentalModel(persona: string, question: string): MentalModel | null {
  ensureMentalModelSchema();
  const db = getDatabase();
  const row = db.query(
    'SELECT * FROM mental_models WHERE (persona = ? OR persona = ?) AND question = ? ORDER BY CASE WHEN persona = ? THEN 0 ELSE 1 END LIMIT 1',
  ).get(persona, 'shared', question, persona) as MentalModelRow | null;
  return row ? rowToMentalModel(row) : null;
}

export function listMentalModels(options: { persona?: string } = {}): MentalModel[] {
  ensureMentalModelSchema();
  const db = getDatabase();
  let sql = 'SELECT * FROM mental_models';
  const params: string[] = [];
  if (options.persona) { sql += ' WHERE persona = ?'; params.push(options.persona); }
  sql += ' ORDER BY refreshed_at DESC, created_at DESC';
  return (db.query(sql).all(...params) as MentalModelRow[]).map(rowToMentalModel);
}

// ---------------------------------------------------------------------------
// Refresh (background writer)
// ---------------------------------------------------------------------------

interface EvidenceRow { value: string; importance: number; created_at: number }

function gatherEvidence(persona: string, limit = 40): EvidenceRow[] {
  const db = getDatabase();
  return db.query(`
    SELECT value, importance, created_at FROM facts
    WHERE (persona = ? OR persona = 'shared')
      AND (expires_at IS NULL OR expires_at > CAST(strftime('%s','now') AS INTEGER))
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(persona, limit) as EvidenceRow[];
}

/**
 * Refresh a mental model's answer from current evidence. The write path may
 * use an LLM; the read path never does. Falls back to a deterministic
 * evidence digest when the model call is unavailable.
 */
export async function refreshMentalModel(id: string): Promise<MentalModel> {
  ensureMentalModelSchema();
  const db = getDatabase();
  const row = db.query('SELECT * FROM mental_models WHERE id = ?').get(id) as MentalModelRow | null;
  if (!row) throw new Error(`Mental model not found: ${id}`);

  const evidence = gatherEvidence(row.persona);
  const now = Math.floor(Date.now() / 1000);
  let answer: string;
  let modelUsed: string;

  const digest = evidence.slice(0, 10).map(e => `- ${e.value}`).join('\n');
  try {
    const model = process.env.ZO_MENTAL_MODEL_MODEL || 'gpt-4o-mini';
    const result = await llmCall({
      model,
      system: 'You maintain a standing answer page for an agent memory bank. Answer the standing question using ONLY the supplied memory facts. Be concise (under 200 words). If the facts cannot answer the question, say what is known and what is missing. Never invent facts.',
      prompt: `Standing question: ${row.question}\n\nMemory facts (importance-ordered):\n${digest || '(no facts stored yet)'}\n\nWrite the current standing answer:`,
      temperature: 0.2,
      maxTokens: 400,
    });
    answer = result.content.trim();
    modelUsed = model;
    if (!answer) throw new Error('empty model response');
  } catch {
    // Fail-safe fallback: deterministic digest, clearly labelled.
    answer = evidence.length === 0
      ? `No memory facts available yet to answer: "${row.question}"`
      : `Standing answer (deterministic digest; model refresh unavailable):\n${digest}`;
    modelUsed = 'deterministic-fallback';
  }

  db.run(
    'UPDATE mental_models SET answer = ?, model = ?, evidence_count = ?, refreshed_at = ? WHERE id = ?',
    [answer, modelUsed, evidence.length, now, id],
  );
  return rowToMentalModel(db.query('SELECT * FROM mental_models WHERE id = ?').get(id) as MentalModelRow);
}

/** Refresh every mental model whose refresh interval has elapsed. For cron. */
export async function refreshDueMentalModels(): Promise<{ refreshed: number; skipped: number }> {
  ensureMentalModelSchema();
  const db = getDatabase();
  const rows = db.query(`
    SELECT * FROM mental_models
    WHERE refreshed_at IS NULL
       OR refreshed_at + refresh_interval_s <= CAST(strftime('%s','now') AS INTEGER)
  `).all() as MentalModelRow[];
  let refreshed = 0;
  for (const r of rows) {
    await refreshMentalModel(r.id);
    refreshed++;
  }
  const total = (db.query('SELECT COUNT(*) as c FROM mental_models').get() as { c: number }).c;
  return { refreshed, skipped: total - refreshed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Mental Models CLI\n\nCommands:\n  define --persona <slug> --question "..." [--interval 86400]\n  refresh --id <modelId>\n  refresh-due\n  read --persona <slug> --question "..."\n  list [--persona <slug>]');
    process.exit(0);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] || '';
  const command = args[0];

  const { loadConfig } = await import('zouroboros-core');
  const { initDatabase, runMigrations } = await import('./database.js');
  const config = loadConfig();
  const memoryConfig = { ...config.memory };
  const envDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
  if (envDb) memoryConfig.dbPath = envDb;
  initDatabase(memoryConfig);
  runMigrations(memoryConfig);

  if (command === 'define') {
    if (!flags.question) { console.error('--question required'); process.exit(1); }
    const m = defineMentalModel({ persona: flags.persona, question: flags.question, refreshIntervalS: flags.interval ? parseInt(flags.interval, 10) : undefined });
    console.log(`Defined mental model ${m.id.slice(0, 8)} for persona "${m.persona}": ${m.question}`);
  } else if (command === 'refresh') {
    if (!flags.id) { console.error('--id required'); process.exit(1); }
    const all = listMentalModels();
    const target = all.find(m => m.id === flags.id) ?? all.find(m => m.id.startsWith(flags.id));
    if (!target) { console.error('Mental model not found.'); process.exit(1); }
    const m = await refreshMentalModel(target.id);
    console.log(`Refreshed (${m.model}, ${m.evidenceCount} facts):\n\n${m.answer}`);
  } else if (command === 'refresh-due') {
    const r = await refreshDueMentalModels();
    console.log(`Refreshed ${r.refreshed} mental model(s); ${r.skipped} still fresh.`);
  } else if (command === 'read') {
    if (!flags.question) { console.error('--question required'); process.exit(1); }
    const m = readMentalModel(flags.persona || 'shared', flags.question);
    if (!m) { console.log('No mental model defined for that question.'); process.exit(0); }
    console.log(m.answer || '(defined but not yet refreshed — run: refresh --id ' + m.id.slice(0, 8) + ')');
  } else if (command === 'list') {
    const models = listMentalModels({ persona: flags.persona });
    if (models.length === 0) console.log('No mental models defined.');
    for (const m of models) {
      const freshness = m.refreshedAt ? new Date(m.refreshedAt * 1000).toISOString().slice(0, 10) : 'never';
      console.log(`  ${m.id.slice(0, 8)} [${m.persona}] ${m.question}\n    refreshed=${freshness} model=${m.model ?? '-'} evidence=${m.evidenceCount}`);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
