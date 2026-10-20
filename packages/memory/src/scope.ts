/**
 * Scope resolution — the single choke point for persona/actor scoping.
 *
 * Every retrieval and mutation path in this package resolves its SQL
 * visibility predicate HERE. No module hand-rolls
 * `(persona = ? OR persona = 'shared')` anymore; they call resolveScope()
 * and splice `scopeSql()` into their queries.
 *
 * Actor contract:
 *  - `actor` is an optional caller-declared identity (MCP tool arg /
 *    function param) used to scope visibility: an actor sees its own
 *    persona plus the shared pool.
 *  - A missing, empty, or non-string actor is NOT an error: it resolves
 *    to the shared scope ('shared'), so plain single-user callers work
 *    without declaring an identity.
 *  - Misattribution is detectable, not preventable, at this trust boundary
 *    (every MCP client is a first-party local harness): the memory_audit
 *    trail records actor + scope for every access.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from './database.js';

/** Persona an actor-less call runs under: the cross-persona shared pool. */
export const DEFAULT_ACTOR = 'shared';

/**
 * Normalize a caller-supplied actor: a non-empty string is trimmed and
 * used as-is; anything else (missing, empty, non-string) resolves to the
 * default shared actor.
 */
export function resolveActor(actor: unknown): string {
  if (typeof actor !== 'string') return DEFAULT_ACTOR;
  const trimmed = actor.trim();
  return trimmed.length === 0 ? DEFAULT_ACTOR : trimmed;
}

/**
 * The resolved visibility scope for one actor.
 * `personas` is the exact set of persona values the actor may read.
 * `key` is a stable cache key (graph cache, etc.).
 */
export interface ScopePredicate {
  actor: string;
  personas: string[];
  key: string;
}

/**
 * Build the scope for an actor: the actor's own persona plus the shared
 * pool. The ONLY place the visibility rule lives. An absent or unusable
 * actor resolves to the shared scope.
 */
export function resolveScope(actor: unknown): ScopePredicate {
  const a = resolveActor(actor);
  const personas = a === 'shared' ? ['shared'] : [a, 'shared'];
  return { actor: a, personas, key: personas.join('||') };
}

/**
 * Render the scope as a SQL predicate for `column` (default `persona`).
 * Returns the parenthesized SQL fragment and its bind params, in order.
 */
export function scopeSql(
  scope: ScopePredicate,
  column = 'persona',
): { sql: string; params: string[] } {
  const placeholders = scope.personas.map(() => `${column} = ?`).join(' OR ');
  return { sql: `(${placeholders})`, params: [...scope.personas] };
}

// ---------------------------------------------------------------------------
// Audit — every scoped access leaves a row in memory_audit.
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'store'
  | 'search'
  | 'search_vector'
  | 'get'
  | 'delete'
  | 'forget'
  | 'restore'
  | 'purge'
  | 'promotion_stage'
  | 'review_decision';

export interface AuditEvent {
  actor: string;
  /** Human-readable scope the action ran under (persona list or target persona). */
  scope: string;
  action: AuditAction;
  factId?: string | null;
  /** Correlates the rows of one logical call (e.g. hybrid = keyword + vector legs). */
  callId?: string | null;
}

/** Mint a correlation id for one logical memory call. */
export function newCallId(): string {
  return randomUUID();
}

/**
 * Record an audit row. Deliberately NOT best-effort: if the audit substrate
 * is broken the operation fails, because an unauditable memory plane is a
 * substrate failure the caller should see, not silently absorb.
 */
export function recordAudit(event: AuditEvent): void {
  const db = getDatabase();
  db.run(
    `INSERT INTO memory_audit (actor, scope, action, fact_id, call_id)
     VALUES (?, ?, ?, ?, ?)`,
    [event.actor, event.scope, event.action, event.factId ?? null, event.callId ?? null],
  );
}
