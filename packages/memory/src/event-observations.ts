/**
 * event-observations.ts — Agent-lifecycle event capture (adopted from agentmemory)
 *
 * Concept source: rohitg00/agentmemory hook pipeline. Coding agents emit a
 * stream of lifecycle events (tool use, prompts, session boundaries); each
 * event is an *event observation*. This module is the ingest boundary for
 * those events, implementing three agentmemory concepts:
 *
 *   1. Privacy-first capture  — secrets are redacted BEFORE storage
 *      (privacy-filter.ts). The observation lands, the credential does not.
 *   2. SHA-256 dedup window   — identical observations within 5 minutes are
 *      stored once (agentmemory: 5min dedup window on PostToolUse). Re-fires
 *      of the same hook (editor retries, double-saves) do not flood memory.
 *   3. Tiered lifecycle       — observations land in the WORKING tier (raw,
 *      short-TTL). Promotion to the episodic tier is handled by
 *      promoteObservations() below, matching agentmemory's
 *      working -> episodic -> semantic -> procedural flow.
 *
 * LLM-written compression is deliberately NOT default-on (mirrors
 * AGENTMEMORY_AUTO_COMPRESS): only synthetic compression (trim) runs here.
 *
 * Naming (2026-09-27 reconciliation): this module was developed uncommitted on
 * the VPS under the name "observations" with a table of the same name, which
 * collided with the hindsight-style *belief* observations merged in PR #799
 * (src/observations.ts). Hook-event capture now lives in the
 * `event_observations` table; `observations` belongs to evidence-backed
 * beliefs. reconcileLegacyHookObservations() upgrades a database carrying the
 * pre-reconciliation table shape (legacy `observations` table with a `hash`
 * column and no `persona` column).
 */

import { createHash, randomUUID } from 'crypto';
import type { MemoryConfig } from 'zouroboros-core';
import { initDatabase, getDatabase, runMigrations, reconcileLegacyHookObservations } from './database.js';
import { redactSecrets } from './privacy-filter.js';
import { createEpisode } from './episodes.js';

type Db = ReturnType<typeof getDatabase>;

function tableColumns(db: Db, table: string): Set<string> {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

// The reconcile implementation lives in database.ts (it must run inside
// initDatabase, before SCHEMA_SQL). Re-exported here for callers.
export { reconcileLegacyHookObservations };

/** Create the event_observations schema if missing (reconcile first). */
export function ensureEventObservationSchema(): void {
  const db = getDatabase();
  reconcileLegacyHookObservations(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_observations (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT,
      tool TEXT,
      content TEXT NOT NULL,
      redaction_count INTEGER NOT NULL DEFAULT 0,
      promoted_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_observations_hash ON event_observations(hash);
    CREATE INDEX IF NOT EXISTS idx_event_observations_created ON event_observations(created_at);
  `);
}

// Migrations are tracked in _migrations, so re-running them is a cheap no-op —
// but we must re-run whenever the singleton DB is replaced (embedders, tests
// that closeDatabase() + re-init). Track ensured instances, not a boolean.
const ensuredDbs = new WeakSet<object>();
function ensureMigrations(config: MemoryConfig): void {
  initDatabase(config);
  const db = getDatabase();
  if (ensuredDbs.has(db)) return;
  runMigrations(config);
  ensureEventObservationSchema();
  ensuredDbs.add(db);
}

export const DEDUP_WINDOW_MS = 5 * 60 * 1000; // agentmemory: 5-minute dedup window
const MAX_OBSERVATION_CHARS = 4000;

export interface RecordObservationInput {
  text: string;
  /** Where the observation came from, e.g. "hook:post-tool-use", "hook:user-prompt". */
  source?: string;
  sessionId?: string;
  tool?: string;
}

export interface RecordObservationResult {
  stored: boolean;
  id?: string;
  deduped: boolean;
  redactionCount: number;
  redactionKinds: string[];
  contentLength: number;
}

/** Normalize before hashing: collapse whitespace so cosmetic diffs dedup. */
export function normalizeObservationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_OBSERVATION_CHARS);
}

export function observationHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

// In-process recent-hash window; DB unique index is the durable backstop.
const recentHashes = new Map<string, number>();

function isRecentDuplicate(hash: string, now: number): boolean {
  const ts = recentHashes.get(hash);
  if (ts && now - ts < DEDUP_WINDOW_MS) return true;
  // Opportunistic sweep so the map cannot grow unbounded.
  if (recentHashes.size > 4096) {
    for (const [h, t] of recentHashes) {
      if (now - t > DEDUP_WINDOW_MS) recentHashes.delete(h);
    }
  }
  recentHashes.set(hash, now);
  return false;
}

/**
 * Record one observation. Privacy filter runs first; dedup second; storage last.
 * Never throws on duplicate — returns { stored: false, deduped: true }.
 */
export function recordObservation(
  input: RecordObservationInput,
  config: MemoryConfig
): RecordObservationResult {
  const raw = String(input.text ?? '');
  const filtered = redactSecrets(raw);
  const normalized = normalizeObservationText(filtered.text);
  const now = Date.now();

  if (normalized.length === 0) {
    return {
      stored: false,
      deduped: false,
      redactionCount: filtered.redactionCount,
      redactionKinds: filtered.kinds,
      contentLength: 0,
    };
  }

  const hash = observationHash(normalized);
  if (isRecentDuplicate(hash, now)) {
    return {
      stored: false,
      deduped: true,
      redactionCount: filtered.redactionCount,
      redactionKinds: filtered.kinds,
      contentLength: normalized.length,
    };
  }

  ensureMigrations(config);
  initDatabase(config);
  const db = getDatabase();
  const id = randomUUID();
  try {
    db.run(
      `INSERT INTO event_observations (id, hash, source, session_id, tool, content, redaction_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hash,
        input.source ?? 'hook:unknown',
        input.sessionId ?? null,
        input.tool ?? null,
        normalized,
        filtered.redactionCount,
      ]
    );
  } catch (err: any) {
    // Unique violation = concurrent duplicate landing outside the in-process window.
    if (typeof err?.message === 'string' && /UNIQUE/i.test(err.message)) {
      return {
        stored: false,
        deduped: true,
        redactionCount: filtered.redactionCount,
        redactionKinds: filtered.kinds,
        contentLength: normalized.length,
      };
    }
    throw err;
  }

  return {
    stored: true,
    id,
    deduped: false,
    redactionCount: filtered.redactionCount,
    redactionKinds: filtered.kinds,
    contentLength: normalized.length,
  };
}

export function getObservationStats(config: MemoryConfig): {
  observations: number;
  redacted: number;
} {
  ensureMigrations(config);
  initDatabase(config);
  const db = getDatabase();
  return {
    observations: (db.query('SELECT COUNT(*) AS c FROM event_observations').get() as { c: number }).c,
    redacted: (db.query('SELECT COUNT(*) AS c FROM event_observations WHERE redaction_count > 0').get() as { c: number }).c,
  };
}

// ---------------------------------------------------------------------------
// Promotion: working tier -> episodic tier
//
// Observations arrive raw from hooks. Left alone they grow into an
// unsearchable log. promoteObservations() batches unpromoted observations into
// one episode per session (or per time window for session-less observations),
// so hook-captured activity becomes searchable episodic memory through the
// same episodes table every other pipeline uses. Mirrors agentmemory's
// working -> episodic promotion, delegated to the existing episode store.
// ---------------------------------------------------------------------------

/** Observations younger than this are left for the next sweep. */
export const PROMOTION_GRACE_MS = 30 * 60 * 1000;
/** Session-less observations are grouped into fixed windows. */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_SUMMARY_CHARS = 600;
const MAX_BULLETS = 10;
const BULLET_CHARS = 120;

export interface PromotionResult {
  episodesCreated: number;
  observationsPromoted: number;
  groups: number;
}

interface ObservationRow {
  id: string;
  source: string;
  session_id: string | null;
  tool: string | null;
  content: string;
  redaction_count: number;
  created_at: number;
}

function ensurePromotionColumn(db: Db): void {
  if (!tableColumns(db, 'event_observations').has('promoted_at')) {
    db.exec('ALTER TABLE event_observations ADD COLUMN promoted_at INTEGER');
  }
}

function windowKey(row: ObservationRow): string {
  if (row.session_id) return `session:${row.session_id}`;
  return `window:${Math.floor((row.created_at * 1000) / WINDOW_MS)}`;
}

function buildSummary(group: ObservationRow[]): string {
  const tools = [...new Set(group.map((r) => r.tool).filter(Boolean))] as string[];
  const sources = [...new Set(group.map((r) => r.source))];
  const header =
    `${group.length} hook observation${group.length === 1 ? '' : 's'} ` +
    `(tools: ${tools.length ? tools.join(', ') : 'none'}, sources: ${sources.join(', ')})`;
  const bullets = group
    .slice(0, MAX_BULLETS)
    .map((r) => `- ${r.content.slice(0, BULLET_CHARS)}`);
  let summary = [header, ...bullets].join('\n');
  if (group.length > MAX_BULLETS) summary += `\n- …and ${group.length - MAX_BULLETS} more`;
  return summary.slice(0, MAX_SUMMARY_CHARS);
}

/**
 * Promote unpromoted observations older than the grace period into episodes.
 * One episode per session (or per time window for session-less rows).
 * Idempotent: promoted rows are marked and never reprocessed.
 */
export function promoteObservations(
  config: MemoryConfig,
  opts: { graceMs?: number; now?: number } = {}
): PromotionResult {
  ensureMigrations(config);
  initDatabase(config);
  const db = getDatabase();
  ensurePromotionColumn(db);

  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? PROMOTION_GRACE_MS;
  const cutoffSec = Math.floor((now - graceMs) / 1000);

  const rows = db
    .query(
      `SELECT id, source, session_id, tool, content, redaction_count, created_at
       FROM event_observations
       WHERE promoted_at IS NULL AND created_at <= ?
       ORDER BY created_at ASC`
    )
    .all(cutoffSec) as unknown as ObservationRow[];

  if (rows.length === 0) return { episodesCreated: 0, observationsPromoted: 0, groups: 0 };

  const groups = new Map<string, ObservationRow[]>();
  for (const row of rows) {
    const key = windowKey(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let episodesCreated = 0;
  let observationsPromoted = 0;

  for (const [, group] of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const happenedAt = new Date(first.created_at * 1000);
    const durationMs = Math.max(0, (last.created_at - first.created_at) * 1000);
    const sessionId = first.session_id ?? null;

    createEpisode({
      summary: buildSummary(group),
      outcome: 'ongoing',
      entities: [],
      happenedAt,
      durationMs,
      metadata: {
        source: 'observation-promotion',
        session_id: sessionId,
        observation_count: group.length,
        tools: [...new Set(group.map((r) => r.tool).filter(Boolean))],
        sources: [...new Set(group.map((r) => r.source))],
        redaction_count: group.reduce((n, r) => n + r.redaction_count, 0),
      },
    });

    const promotedAt = Math.floor(now / 1000);
    const mark = db.query('UPDATE event_observations SET promoted_at = ? WHERE id = ?');
    for (const row of group) {
      mark.run(promotedAt, row.id);
      observationsPromoted++;
    }
    episodesCreated++;
  }

  return { episodesCreated, observationsPromoted, groups: groups.size };
}
