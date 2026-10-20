/**
 * Fact storage and retrieval operations
 */

import { randomUUID } from 'crypto';
import { getDatabase, atomicWriteGroup } from './database.js';
import { generateEmbedding, serializeEmbedding, deserializeEmbedding, generateHyDEExpansion, blendEmbeddings, resolveEmbeddingProvider, PRODUCTION_EMBEDDING_DIMENSION } from './embeddings.js';
import { invalidateGraphCache } from './graph.js';
import { rerankResults } from './reranker.js';
import { applyDefense, DefenseBlockedError } from './defense.js';
import { resolveActor, resolveScope, scopeSql, recordAudit, newCallId } from './scope.js';
import type { MemoryConfig, MemoryEntry, MemorySearchResult, DecayClass } from 'zouroboros-core';

/** Retrieval paths must never surface reversibly-forgotten facts. */
const NOT_FORGOTTEN_SQL = `id NOT IN (SELECT fact_id FROM fact_forgotten)`;

/** Same predicate for queries that alias the facts table. */
export function notForgottenSql(column = 'id'): string {
  return `${column} NOT IN (SELECT fact_id FROM fact_forgotten)`;
}

/** Calibrated against the 2026-09-09 production shadow probe and 2026-09-10 post-threshold probe (RAG-2). */
export const DEFAULT_VECTOR_SIMILARITY_THRESHOLD = 0.46;

// Decay class TTLs in seconds (activity-set vocabulary)
const TTL_DEFAULTS: Record<DecayClass, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

type Category = 'preference' | 'fact' | 'decision' | 'convention' | 'other' | 'reference' | 'project';

const DEDUP_SUBSTR_LEN = 60;

/**
 * Deduplicate search results by checking for 60-char substring overlap.
 * Keeps the higher-scored entry when overlap is found.
 */
function deduplicateResults(results: MemorySearchResult[]): MemorySearchResult[] {
  const seen: string[] = [];
  return results.filter(r => {
    const val = r.entry.value;
    const substr = val.slice(0, DEDUP_SUBSTR_LEN);
    if (seen.some(s => s === substr || val.includes(s) || s.includes(substr.slice(0, 40)))) {
      return false;
    }
    seen.push(substr);
    return true;
  });
}

interface StoreFactInput {
  /** Caller identity; an absent actor defaults to the shared scope (see scope.ts). */
  actor: string;
  entity: string;
  key?: string;
  value: string;
  /** Persona the fact is stored under; defaults to the actor, never 'shared'. */
  persona?: string;
  category?: Category;
  decay?: DecayClass;
  importance?: number;
  source?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Store a fact in memory
 */
export async function storeFact(
  input: StoreFactInput,
  config: MemoryConfig
): Promise<MemoryEntry> {
  const actor = resolveActor(input.actor);
  const persona = input.persona ?? actor;
  const db = getDatabase();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const decay = input.decay || 'stable';
  const ttl = TTL_DEFAULTS[decay];
  const expiresAt = ttl ? now + ttl : null;

  // Memory Defense (concept adopted from vectorize-io/hindsight): scan the
  // retain payload for secrets/PII before anything reaches storage. Default
  // policy is redact (fail-safe); 'block' rejects the write entirely.
  const defense = applyDefense(input.value);
  if (defense.blocked) throw new DefenseBlockedError(defense.findings);
  const safeValue = defense.text;

  // Provenance (Constitution Art. VI): record that a redaction happened
  // without storing the secret itself.
  const metadata = defense.findings.length > 0
    ? {
        ...(input.metadata || {}),
        defense: {
          policy: (process.env.ZO_MEMORY_DEFENSE || 'redact').trim().toLowerCase(),
          redactions: defense.findings.map(f => f.pattern),
        },
      }
    : input.metadata;

  const text = input.key
    ? `${input.entity} ${input.key} ${safeValue}`
    : `${input.entity} ${safeValue}`;

  const entry: MemoryEntry = {
    id,
    entity: input.entity,
    key: input.key || null,
    value: safeValue,
    decay,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Generate the embedding BEFORE the atomic write group: provider calls are
  // soft-fail and must never run between the mutation and its mandatory audit.
  let embeddingRow: { serialized: Buffer; model: string } | null = null;
  if (config.vectorEnabled) {
    try {
      const embedding = await generateEmbedding(text, config);
      const { model } = resolveEmbeddingProvider(config);
      embeddingRow = { serialized: serializeEmbedding(embedding), model };
    } catch (error) {
      console.warn('Failed to generate embedding:', error);
    }
  }

  // MEM-12: fact insert, embedding insert, promotion entry, and mandatory
  // audit are one atomic write group. An audit failure rolls everything back
  // instead of leaving a durable unaudited fact.
  atomicWriteGroup(() => {
    db.run(
      `INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source,
                          created_at, expires_at, confidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        persona,
        input.entity,
        input.key || null,
        safeValue,
        text,
        input.category || 'fact',
        decay,
        input.importance || 1.0,
        input.source || 'manual',
        now,
        expiresAt,
        input.confidence || 1.0,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    if (embeddingRow) {
      db.run(
        'INSERT INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)',
        [id, embeddingRow.serialized, embeddingRow.model]
      );
    }
    // Every stored fact enters the promotion pipeline at the capture stage.
    db.run(
      `INSERT INTO fact_promotions (id, fact_id, stage, decided_by) VALUES (?, ?, 'capture', ?)`,
      [randomUUID(), id, actor],
    );
    recordAudit({ actor, scope: persona, action: 'store', factId: id });
  });

  invalidateGraphCache();
  return entry;
}

const MAX_SEARCH_TERMS = 16;

/**
 * Search facts by keyword: every whitespace-separated term must occur (in any
 * order) in the fact's text, entity or value. LIKE wildcards in terms are literal.
 * `options.actor` is required; visibility is actor-scoped via resolveScope.
 */
export function searchFacts(
  query: string,
  options: {
    actor: string;
    id?: string;
    entity?: string;
    category?: string;
    limit?: number;
    /** Correlates audit rows of a composite call (hybrid/routed search). */
    callId?: string;
  }
): MemoryEntry[] {
  const db = getDatabase();
  const { id, entity, category, limit = 10 } = options;
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);

  const terms = query.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) {
    recordAudit({
      actor: scope.actor,
      scope: scope.personas.join(','),
      action: 'search',
      callId: options.callId ?? newCallId(),
    });
    return [];
  }

  let sql = `
    SELECT id, persona, entity, key, value, category, decay_class as decayClass,
           importance, source, created_at as createdAt, expires_at as expiresAt,
           confidence, metadata
    FROM facts
    WHERE (expires_at IS NULL OR expires_at > strftime('%s', 'now'))
      AND ${NOT_FORGOTTEN_SQL}
      AND ${predicate.sql}
  `;
  const params: (string | number)[] = [...predicate.params];

  for (const term of terms) {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    sql += " AND (text LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')";
    params.push(pattern, pattern, pattern);
  }

  if (id) {
    sql += ' AND id = ?';
    params.push(id);
  }

  if (entity) {
    sql += ' AND entity = ?';
    params.push(entity);
  }

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.query(sql).all(...params) as Array<{
    id: string;
    entity: string;
    key: string | null;
    value: string;
    category: string;
    decayClass: DecayClass;
    importance: number;
    source: string;
    createdAt: number;
    expiresAt: number | null;
    confidence: number;
    metadata: string | null;
  }>;

  recordAudit({
    actor: scope.actor,
    scope: scope.personas.join(','),
    action: 'search',
    callId: options.callId ?? newCallId(),
  });

  return rows.map(row => ({
    id: row.id,
    entity: row.entity,
    key: row.key,
    value: row.value,
    decay: row.decayClass,
    createdAt: new Date(row.createdAt * 1000).toISOString(),
    updatedAt: new Date(row.createdAt * 1000).toISOString(),
    tags: row.category ? [row.category] : undefined,
  }));
}

/**
 * Search facts using vector similarity.
 * `options.actor` is required; visibility is actor-scoped via resolveScope.
 */
export async function searchFactsVector(
  query: string,
  config: MemoryConfig,
  options: {
    actor: string;
    limit?: number;
    threshold?: number;
    useHyDE?: boolean;
    callId?: string;
  }
): Promise<MemorySearchResult[]> {
  if (!config.vectorEnabled) {
    throw new Error('Vector search is disabled. Enable it in configuration.');
  }

  const scope = resolveScope(options.actor);
  const db = getDatabase();
  const { limit = 10, threshold = DEFAULT_VECTOR_SIMILARITY_THRESHOLD, useHyDE } = options;

  // Generate query embedding, optionally with HyDE expansion
  let queryEmbedding: number[];
  const shouldUseHyDE = useHyDE ?? config.hydeExpansion;

  if (shouldUseHyDE) {
    const hyde = await generateHyDEExpansion(query, config);
    queryEmbedding = blendEmbeddings(hyde.original, hyde.expanded);
  } else {
    queryEmbedding = await generateEmbedding(query, config);
  }

  // Get all facts with embeddings, visibility routed through the scope choke point
  const predicate = scopeSql(scope, 'f.persona');
  const factsSql = `
    SELECT f.id, f.entity, f.key, f.value, f.category, f.decay_class as decayClass,
           f.importance, f.created_at as createdAt, f.persona, fe.embedding
    FROM facts f
    JOIN fact_embeddings fe ON f.id = fe.fact_id
    WHERE (f.expires_at IS NULL OR f.expires_at > strftime('%s', 'now'))
      AND ${notForgottenSql('f.id')}
      AND length(fe.embedding) = ?
      AND ${predicate.sql}
  `;
  const factsParams: Array<string | number> = [
    PRODUCTION_EMBEDDING_DIMENSION * Float32Array.BYTES_PER_ELEMENT,
    ...predicate.params,
  ];

  const rows = db.query(factsSql).all(...factsParams) as Array<{
    id: string;
    entity: string;
    key: string | null;
    value: string;
    category: string;
    decayClass: DecayClass;
    importance: number;
    createdAt: number;
    embedding: Buffer;
  }>;

  // Calculate similarity and filter
  const { cosineSimilarity, deserializeEmbedding } = await import('./embeddings.js');
  
  const results: MemorySearchResult[] = rows
    .map(row => {
      const embedding = deserializeEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      
      return {
        entry: {
          id: row.id,
          entity: row.entity,
          key: row.key,
          value: row.value,
          decay: row.decayClass,
          createdAt: new Date(row.createdAt * 1000).toISOString(),
          updatedAt: new Date(row.createdAt * 1000).toISOString(),
          tags: row.category ? [row.category] : undefined,
        },
        score: similarity,
        matchType: 'semantic' as const,
      };
    })
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  recordAudit({
    actor: scope.actor,
    scope: scope.personas.join(','),
    action: 'search_vector',
    callId: options.callId ?? newCallId(),
  });

  return results;
}

/**
 * Hybrid search combining exact and vector search.
 * `options.actor` is required; both legs run under the same resolved scope
 * and share one audit call id.
 */
export async function searchFactsHybrid(
  query: string,
  config: MemoryConfig,
  options: {
    actor: string;
    limit?: number;
    vectorWeight?: number;
    rerank?: boolean;
    callId?: string;
  }
): Promise<MemorySearchResult[]> {
  const { limit = 10, vectorWeight = 0.7 } = options;
  const actor = resolveActor(options.actor);
  const callId = options.callId ?? newCallId();
  const shouldRerank = options.rerank ?? config.reranker?.enabled ?? false;

  // When reranking, fetch more candidates for the reranker to choose from
  const fetchLimit = shouldRerank ? Math.max(limit * 2, 20) : limit;

  // Get exact matches
  const exactMatches = searchFacts(query, { actor, limit: fetchLimit * 2, callId });

  // Get vector matches
  let vectorMatches: MemorySearchResult[] = [];
  if (config.vectorEnabled) {
    try {
      vectorMatches = await searchFactsVector(query, config, { actor, limit: fetchLimit * 2, callId });
    } catch (error) {
      console.warn('Vector search failed:', error);
    }
  }

  // RRF fusion
  const k = 60;
  const scores = new Map<string, { entry: MemoryEntry; score: number }>();

  // Score exact matches
  exactMatches.forEach((entry, rank) => {
    const id = entry.id;
    const rrfScore = 1 / (k + rank + 1);
    scores.set(id, { entry, score: rrfScore * (1 - vectorWeight) });
  });

  // Score vector matches
  vectorMatches.forEach((result, rank) => {
    const id = result.entry.id;
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(id);

    if (existing) {
      existing.score += rrfScore * vectorWeight;
    } else {
      scores.set(id, { entry: result.entry, score: rrfScore * vectorWeight });
    }
  });

  // Sort by combined score
  let fused: MemorySearchResult[] = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, fetchLimit)
    .map(r => ({
      entry: r.entry,
      score: r.score,
      matchType: 'hybrid' as const,
    }));

  // Deduplicate by 60-char substring overlap (Gap 10)
  fused = deduplicateResults(fused);

  // LLM reranking pass
  if (shouldRerank && fused.length > 0) {
    fused = await rerankResults(query, fused, config, limit);
  } else {
    fused = fused.slice(0, limit);
  }

  return fused;
}

/**
 * Get a fact by ID. Scope-checked: an actor can only read facts within its
 * resolved scope; forgotten facts are invisible here like every other path.
 */
export function getFact(id: string, options: { actor: string }): MemoryEntry | null {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();

  const row = db.query(`
    SELECT id, entity, key, value, category, decay_class as decayClass,
           importance, source, created_at as createdAt, expires_at as expiresAt,
           confidence, metadata
    FROM facts
    WHERE id = ?
      AND ${NOT_FORGOTTEN_SQL}
      AND ${predicate.sql}
  `).get(id, ...predicate.params) as {
    id: string;
    entity: string;
    key: string | null;
    value: string;
    category: string;
    decayClass: DecayClass;
    importance: number;
    source: string;
    createdAt: number;
    expiresAt: number | null;
    confidence: number;
    metadata: string | null;
  } | null;

  if (!row) return null;

  recordAudit({
    actor: scope.actor,
    scope: scope.personas.join(','),
    action: 'get',
    factId: id,
  });

  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    value: row.value,
    decay: row.decayClass,
    createdAt: new Date(row.createdAt * 1000).toISOString(),
    updatedAt: new Date(row.createdAt * 1000).toISOString(),
    tags: row.category ? [row.category] : undefined,
  };
}

/**
 * Delete a fact by ID. Scope-checked: an actor can only delete facts within
 * its resolved scope (own persona + shared). Deleting outside scope is a
 * silent no-op returning false — fail closed, no information disclosure.
 */
export function deleteFact(id: string, options: { actor: string }): boolean {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();
  // MEM-12: delete and its mandatory audit are one atomic write group.
  const deleted = atomicWriteGroup(() => {
    const result = db.run(
      `DELETE FROM facts WHERE id = ? AND ${predicate.sql}`,
      [id, ...predicate.params],
    );
    if (result.changes > 0) {
      recordAudit({
        actor: scope.actor,
        scope: scope.personas.join(','),
        action: 'delete',
        factId: id,
      });
      return true;
    }
    return false;
  });
  if (deleted) invalidateGraphCache();
  return deleted;
}

/**
 * Update fact access time
 */
export function touchFact(id: string): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.run('UPDATE facts SET last_accessed = ? WHERE id = ?', [now, id]);
}

/**
 * Clean up expired facts
 */
export function cleanupExpiredFacts(): number {
  const db = getDatabase();
  const result = db.run(`
    DELETE FROM facts
    WHERE expires_at IS NOT NULL
      AND expires_at < strftime('%s', 'now')
  `);
  if (result.changes > 0) invalidateGraphCache();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Reversible forgetting (Track 1 decay).
//
// Forgetting hides a fact from every retrieval path (NOT_FORGOTTEN_SQL) but
// keeps the row; restore removes the hide. Hard deletion only happens via
// purgeForgottenFacts after a retention window. The decay sweep scores
// non-permanent facts on recency / importance / relevance honoring the
// canonical vocabulary (permanent/stable/active/session/checkpoint) and
// forgets — never deletes — the ones below threshold.
// ---------------------------------------------------------------------------

/** Recency half-life per decay class, in seconds. Permanent facts never decay. */
const DECAY_HALF_LIFE_S: Record<Exclude<DecayClass, 'permanent'>, number> = {
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

/** Facts scoring below this retention score are reversibly forgotten. */
export const DEFAULT_RETENTION_THRESHOLD = 0.05;

/** Default retention window before a forgotten fact may be hard-purged. */
export const DEFAULT_PURGE_RETENTION_DAYS = 30;

export interface RetentionSignals {
  recency: number;
  importance: number;
  relevance: number;
  score: number;
}

/**
 * Score one fact's retention on recency (exponential decay of last access,
 * half-life set by decay class), importance (normalized stored importance),
 * and relevance (whether the fact has been accessed since creation).
 */
export function scoreRetention(
  fact: { decay: DecayClass; importance: number; createdAt: number; lastAccessed: number | null },
  nowSec: number,
): RetentionSignals {
  if (fact.decay === 'permanent') {
    return { recency: 1, importance: 1, relevance: 1, score: 1 };
  }
  const halfLife = DECAY_HALF_LIFE_S[fact.decay];
  const lastTouch = fact.lastAccessed ?? fact.createdAt;
  const age = Math.max(0, nowSec - lastTouch);
  const recency = Math.pow(2, -age / halfLife);
  const importance = Math.min(Math.max(fact.importance, 0) / 2, 1);
  // Relevance: a fact that has been accessed after creation has demonstrated
  // retrieval value; one never touched since creation has not.
  const relevance = fact.lastAccessed !== null && fact.lastAccessed > fact.createdAt ? 1 : 0.3;
  const score = 0.5 * recency + 0.35 * importance + 0.15 * relevance;
  return { recency, importance, relevance, score };
}

/**
 * Reversibly forget a fact: hide it from every retrieval path. Scope-checked.
 * Returns false if the fact is outside scope, already forgotten, or missing.
 */
export function forgetFact(
  id: string,
  options: { actor: string; reason?: string; retentionScore?: number },
): boolean {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();
  const visible = db.query(
    `SELECT id FROM facts WHERE id = ? AND ${NOT_FORGOTTEN_SQL} AND ${predicate.sql}`,
  ).get(id, ...predicate.params);
  if (!visible) return false;
  // MEM-12: forget marker and its mandatory audit are one atomic write group.
  atomicWriteGroup(() => {
    db.run(
      `INSERT INTO fact_forgotten (fact_id, forgotten_by, reason, retention_score) VALUES (?, ?, ?, ?)`,
      [id, scope.actor, options.reason ?? null, options.retentionScore ?? null],
    );
    recordAudit({ actor: scope.actor, scope: scope.personas.join(','), action: 'forget', factId: id });
  });
  invalidateGraphCache();
  return true;
}

/**
 * Restore a reversibly-forgotten fact. Scope-checked against the underlying
 * fact's persona. Returns false when nothing was restored.
 */
export function restoreFact(id: string, options: { actor: string }): boolean {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();
  // MEM-12: restore and its mandatory audit are one atomic write group.
  const restored = atomicWriteGroup(() => {
    const result = db.run(
      `DELETE FROM fact_forgotten
       WHERE fact_id = ?
         AND fact_id IN (SELECT id FROM facts WHERE ${predicate.sql})`,
      [id, ...predicate.params],
    );
    if (result.changes > 0) {
      recordAudit({ actor: scope.actor, scope: scope.personas.join(','), action: 'restore', factId: id });
      return true;
    }
    return false;
  });
  if (restored) invalidateGraphCache();
  return restored;
}

/**
 * List forgotten facts within the actor's scope (for review / restore).
 */
export function listForgottenFacts(options: { actor: string; limit?: number }): Array<{
  factId: string;
  entity: string;
  value: string;
  forgottenAt: number;
  forgottenBy: string;
  reason: string | null;
  retentionScore: number | null;
}> {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope, 'f.persona');
  const db = getDatabase();
  return db.query(`
    SELECT ff.fact_id as factId, f.entity, f.value,
           ff.forgotten_at as forgottenAt, ff.forgotten_by as forgottenBy,
           ff.reason, ff.retention_score as retentionScore
    FROM fact_forgotten ff
    JOIN facts f ON f.id = ff.fact_id
    WHERE ${predicate.sql}
    ORDER BY ff.forgotten_at DESC
    LIMIT ?
  `).all(...predicate.params, options.limit ?? 50) as Array<{
    factId: string;
    entity: string;
    value: string;
    forgottenAt: number;
    forgottenBy: string;
    reason: string | null;
    retentionScore: number | null;
  }>;
}

/**
 * Hard-delete facts that have been forgotten longer than the retention
 * window. This is the ONLY path from forgotten to gone.
 */
export function purgeForgottenFacts(options: {
  actor: string;
  retentionDays?: number;
}): number {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();
  const cutoff = Math.floor(Date.now() / 1000) - (options.retentionDays ?? DEFAULT_PURGE_RETENTION_DAYS) * 24 * 3600;
  // MEM-12: purge and its mandatory audit are one atomic write group.
  const purged = atomicWriteGroup(() => {
    const result = db.run(
      `DELETE FROM facts
       WHERE id IN (SELECT fact_id FROM fact_forgotten WHERE forgotten_at < ?)
         AND ${predicate.sql}`,
      [cutoff, ...predicate.params],
    );
    if (result.changes > 0) {
      recordAudit({ actor: scope.actor, scope: scope.personas.join(','), action: 'purge' });
      return result.changes as number;
    }
    return 0;
  });
  if (purged > 0) invalidateGraphCache();
  return purged;
}

export interface DecaySweepResult {
  examined: number;
  forgotten: Array<{ factId: string; score: number }>;
  dryRun: boolean;
}

/**
 * Decay sweep: reversibly forget in-scope, non-permanent facts whose
 * retention score (recency x importance x relevance) falls below threshold.
 * Expired facts are forgotten outright (reversible, unlike cleanupExpiredFacts).
 * Idempotent; dry-run supported.
 */
export function sweepDecay(options: {
  actor: string;
  threshold?: number;
  now?: number;
  dryRun?: boolean;
}): DecaySweepResult {
  const scope = resolveScope(options.actor);
  const predicate = scopeSql(scope);
  const db = getDatabase();
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const threshold = options.threshold ?? DEFAULT_RETENTION_THRESHOLD;

  const rows = db.query(`
    SELECT id, decay_class as decay, importance, created_at as createdAt,
           last_accessed as lastAccessed, expires_at as expiresAt
    FROM facts
    WHERE decay_class != 'permanent'
      AND ${NOT_FORGOTTEN_SQL}
      AND ${predicate.sql}
  `).all(...predicate.params) as Array<{
    id: string;
    decay: DecayClass;
    importance: number;
    createdAt: number;
    lastAccessed: number | null;
    expiresAt: number | null;
  }>;

  const forgotten: Array<{ factId: string; score: number }> = [];
  for (const row of rows) {
    const expired = row.expiresAt !== null && row.expiresAt < nowSec;
    const { score } = scoreRetention(row, nowSec);
    if (!expired && score >= threshold) continue;
    forgotten.push({ factId: row.id, score });
    if (!options.dryRun) {
      forgetFact(row.id, {
        actor: scope.actor,
        reason: expired ? 'decay-sweep: expired' : 'decay-sweep: retention below threshold',
        retentionScore: score,
      });
    }
  }

  return { examined: rows.length, forgotten, dryRun: options.dryRun ?? false };
}
