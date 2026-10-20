/**
 * A-Mem-style memory routing gate (M10 W4 t9).
 *
 * Inserts an explicit decision node before every unified memory query:
 * classifies the query as parametric / episodic / semantic / procedural and
 * persists the routing decision to `memory_routing_log` for downstream
 * analysis (which kinds dominate, which yield zero hits, where the hit-rate
 * imbalance is).
 *
 * v1: classify + log + delegate to existing search. Future iterations can
 * branch on `kind` to skip vector cost for parametric or hand off to
 * procedural search instead.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getMemoryDbPath } from 'zouroboros-core';
import { searchFactsHybrid } from './facts.js';
import { searchFactsGraphBoosted, extractQueryEntities } from './graph.js';
import { resolveScope } from './scope.js';
import type { MemorySearchResult } from 'zouroboros-core';

type MemoryConfig = import('zouroboros-core').MemoryConfig;

export type MemoryQueryKind =
  | 'parametric'
  | 'episodic'
  | 'semantic'
  | 'procedural';

export interface RoutingDecision {
  kind: MemoryQueryKind;
  confidence: number;
  reason: string;
}

export interface RouteOptions {
  /** Caller identity; an absent actor defaults to the shared scope (see scope.ts). */
  actor: string;
  limit?: number;
  vectorWeight?: number;
  rerank?: boolean;
  sessionId?: string;
}

function getDB(): string { return getMemoryDbPath(); }

const _ensuredPaths = new Set<string>();

/** Test-only: clear the ensure-table cache so the next call re-creates if missing. */
export function _resetRoutingGateCache(): void {
  _ensuredPaths.clear();
}

function ensureRoutingTable(): boolean {
  const dbPath = getDB();
  if (_ensuredPaths.has(dbPath)) return true;
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(
      `CREATE TABLE IF NOT EXISTS memory_routing_log (` +
      `id TEXT PRIMARY KEY, ` +
      `query TEXT NOT NULL, ` +
      `classified_kind TEXT NOT NULL CHECK(classified_kind IN ('parametric','episodic','semantic','procedural')), ` +
      `confidence REAL NOT NULL, ` +
      `reason TEXT, ` +
      `latency_ms INTEGER, ` +
      `hit_count INTEGER, ` +
      `persona TEXT, ` +
      `session_id TEXT, ` +
      `created_at INTEGER DEFAULT (strftime('%s','now'))` +
      `); ` +
      `CREATE INDEX IF NOT EXISTS idx_memory_routing_log_kind ON memory_routing_log(classified_kind, created_at DESC); ` +
      `CREATE INDEX IF NOT EXISTS idx_memory_routing_log_created ON memory_routing_log(created_at DESC);`
    );
    // Track 1: actor column on pre-existing deployed tables.
    const cols = db.query('PRAGMA table_info(memory_routing_log)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'actor')) {
      db.exec('ALTER TABLE memory_routing_log ADD COLUMN actor TEXT');
    }
    _ensuredPaths.add(dbPath);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

const PROCEDURAL_RX = /\b(how (to|do|can|should)|steps? (to|for)|procedure for|workflow for|process to|recipe for|guide to)\b/i;
const EPISODIC_RX = /\b(yesterday|last (week|month|time|year|night)|when (did|was)|what (happened|did we)|previous(ly)?|recent(ly)?|earlier|two days ago|today|this morning|this afternoon)\b/i;
const SEMANTIC_RX = /\b(who is|what is the|what are the|where is|definition of|email|address|phone|password|api key|version of|config(uration)? for)\b/i;

/**
 * Heuristic-only classifier (advisor's v1 directive — no LLM call on the hot path).
 * Returns the kind plus a confidence ∈ [0, 1] and a short reason string.
 */
export function classifyMemoryQuery(query: string): RoutingDecision {
  const q = (query || '').trim();
  if (!q) {
    return { kind: 'parametric', confidence: 0.4, reason: 'empty query' };
  }

  if (PROCEDURAL_RX.test(q)) {
    return { kind: 'procedural', confidence: 0.85, reason: 'how-to/steps pattern' };
  }
  if (EPISODIC_RX.test(q)) {
    return { kind: 'episodic', confidence: 0.85, reason: 'temporal/event pattern' };
  }
  if (SEMANTIC_RX.test(q)) {
    return { kind: 'semantic', confidence: 0.8, reason: 'fact-lookup pattern' };
  }

  // Fallback: very short generic queries → parametric (likely answerable
  // from model weights), longer entity-rich queries → semantic.
  const tokenCount = q.split(/\s+/).length;
  if (tokenCount <= 3 && !/[A-Z][a-z]/.test(q)) {
    return { kind: 'parametric', confidence: 0.55, reason: 'short generic query' };
  }
  return { kind: 'semantic', confidence: 0.5, reason: 'default semantic fallback' };
}

/**
 * Persist a routing decision. Best-effort — never throws.
 */
/**
 * Persist a routing decision. Best-effort — never throws.
 *
 * Uses bun:sqlite prepared statements with bound parameters. Caller-controlled
 * text (query, reason, actor, session) is never interpolated into SQL and never
 * touches a shell (MEM-09).
 */
export function logMemoryRoute(
  query: string,
  decision: RoutingDecision,
  latencyMs: number,
  hitCount: number,
  actor?: string,
  sessionId?: string,
): void {
  if (!ensureRoutingTable()) return;
  let db: Database | null = null;
  try {
    db = new Database(getDB());
    db.exec('PRAGMA busy_timeout = 5000');
    // The actor doubles as the persona column value so pre-Track-1 analysis
    // queries keep working; the dedicated actor column is authoritative.
    const actorValue = (actor || '').slice(0, 100);
    db.query(
      `INSERT INTO memory_routing_log(id,query,classified_kind,confidence,reason,latency_ms,hit_count,persona,actor,session_id) ` +
      `VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      query.slice(0, 500),
      decision.kind,
      decision.confidence,
      decision.reason.slice(0, 200),
      latencyMs,
      hitCount,
      actorValue,
      actorValue,
      (sessionId || '').slice(0, 100),
    );
  } catch {
    // best-effort logging; never break the search path
  } finally {
    db?.close();
  }
}

/**
 * Wrap searchFactsHybrid with the routing gate, then fuse the graph signal.
 * Three-signal retrieval (keyword + vector + graph) is the default whenever
 * config.graphBoost is enabled (default true); set graphBoost: false to opt
 * out. The graph boost is purely additive — on any failure it returns the
 * hybrid results unchanged.
 *
 * Callers should prefer this over direct searchFactsHybrid() so all unified
 * memory queries pass through the gate.
 */
export async function routeMemoryQuery(
  query: string,
  config: MemoryConfig,
  options: RouteOptions,
): Promise<MemorySearchResult[]> {
  const scope = resolveScope(options.actor);
  const decision = classifyMemoryQuery(query);
  const start = Date.now();
  let results = await searchFactsHybrid(query, config, {
    actor: scope.actor,
    limit: options.limit,
    vectorWeight: options.vectorWeight,
    rerank: options.rerank,
  });
  if (config.graphBoost !== false) {
    try {
      const queryEntities = extractQueryEntities(query, scope);
      results = searchFactsGraphBoosted(results, queryEntities, scope, {
        limit: options.limit ?? 10,
      });
    } catch {
      // Graph boost is additive; never break the search path.
    }
  }
  const latency = Date.now() - start;
  logMemoryRoute(query, decision, latency, results.length, scope.actor, options.sessionId);
  return results;
}

/**
 * Read recent routing log entries. Used by introspect telemetry + tests.
 */
export interface RoutingLogEntry {
  id: string;
  query: string;
  kind: MemoryQueryKind;
  confidence: number;
  reason: string;
  latencyMs: number;
  hitCount: number;
  persona: string;
  actor: string;
  sessionId: string;
  createdAt: number;
}

export function getRecentRoutingDecisions(limit = 100): RoutingLogEntry[] {
  if (!ensureRoutingTable()) return [];
  let db: Database | null = null;
  try {
    db = new Database(getDB());
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.query(
      `SELECT id,query,classified_kind,confidence,reason,latency_ms,hit_count,persona,actor,session_id,created_at ` +
      `FROM memory_routing_log ORDER BY created_at DESC LIMIT ?`
    ).all(Math.max(1, Math.floor(limit))) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id ?? ''),
      query: String(r.query ?? ''),
      kind: (String(r.classified_kind ?? 'semantic') as MemoryQueryKind),
      confidence: Number(r.confidence ?? 0) || 0,
      reason: String(r.reason ?? ''),
      latencyMs: Number(r.latency_ms ?? 0) || 0,
      hitCount: Number(r.hit_count ?? 0) || 0,
      persona: String(r.persona ?? ''),
      actor: String(r.actor ?? ''),
      sessionId: String(r.session_id ?? ''),
      createdAt: Number(r.created_at ?? 0) || 0,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export interface RoutingDistribution {
  total: number;
  byKind: Record<MemoryQueryKind, { count: number; avgHits: number; avgConfidence: number }>;
}

/**
 * Aggregate distribution stats — feeds the introspect scorecard later.
 */
export function getRoutingDistribution(sinceSeconds = 7 * 24 * 3600): RoutingDistribution {
  const empty: RoutingDistribution = {
    total: 0,
    byKind: {
      parametric: { count: 0, avgHits: 0, avgConfidence: 0 },
      episodic: { count: 0, avgHits: 0, avgConfidence: 0 },
      semantic: { count: 0, avgHits: 0, avgConfidence: 0 },
      procedural: { count: 0, avgHits: 0, avgConfidence: 0 },
    },
  };
  if (!ensureRoutingTable()) return empty;
  let db: Database | null = null;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    db = new Database(getDB());
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.query(
      `SELECT classified_kind, COUNT(*), AVG(hit_count), AVG(confidence) ` +
      `FROM memory_routing_log WHERE created_at >= ? GROUP BY classified_kind`
    ).all(cutoff) as { classified_kind: string; 'COUNT(*)': number; 'AVG(hit_count)': number; 'AVG(confidence)': number }[];
    let total = 0;
    for (const row of rows) {
      const k = row.classified_kind as MemoryQueryKind;
      if (k in empty.byKind) {
        const c = Math.floor(row['COUNT(*)'] ?? 0) || 0;
        total += c;
        empty.byKind[k] = {
          count: c,
          avgHits: Number(row['AVG(hit_count)'] ?? 0) || 0,
          avgConfidence: Number(row['AVG(confidence)'] ?? 0) || 0,
        };
      }
    }
    empty.total = total;
    return empty;
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}
