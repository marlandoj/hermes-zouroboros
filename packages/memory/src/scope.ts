/**
 * Scope resolution — the single choke point for persona/actor scoping.
 *
 * Track 1 (intelligence plane): every retrieval and mutation path in this
 * package resolves its SQL visibility predicate HERE. No module hand-rolls
 * `(persona = ? OR persona = 'shared')` anymore; they call resolveScope()
 * and splice `scopeSql()` into their queries. This is the fix for the
 * definer-rights leak class: a path that forgets to scope now fails to
 * compile (actor is a required parameter) instead of silently widening.
 *
 * Fail-closed contract (operator decision Q2, 2026-10-14):
 *  - `actor` is caller-declared identity (MCP tool arg / function param).
 *  - requireActor() throws on missing/empty/non-string — there is no silent
 *    default to 'shared'. Callers that want shared visibility declare
 *    actor 'shared' explicitly, which is itself a legitimate first-party
 *    actor for cross-harness facts.
 *  - Misattribution is detectable, not preventable, at this trust boundary
 *    (every MCP client is a first-party local harness): the memory_audit
 *    trail records actor + scope for every access.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from './database.js';

/** Error code surfaced when a call arrives without a usable actor. */
export class MissingActorError extends Error {
  readonly code = 'MISSING_ACTOR';
  constructor(context?: string) {
    super(
      `actor is required${context ? ` for ${context}` : ''}: ` +
      `pass a non-empty actor identity (fail-closed; no default scope)`,
    );
    this.name = 'MissingActorError';
  }
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
 * Fail-closed actor validation. Throws MissingActorError unless `actor`
 * is a non-empty string after trimming. Returns the trimmed actor.
 */
export function requireActor(actor: unknown, context?: string): string {
  if (typeof actor !== 'string') throw new MissingActorError(context);
  const trimmed = actor.trim();
  if (trimmed.length === 0) throw new MissingActorError(context);
  return trimmed;
}

/**
 * Build the scope for an actor: the actor's own persona plus the shared
 * pool. The ONLY place the visibility rule lives.
 */
export function resolveScope(actor: string, context?: string): ScopePredicate {
  const a = requireActor(actor, context);
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
 * is broken the operation fails (fail closed), because an unauditable
 * memory plane is the exact failure mode Track 1 exists to prevent.
 */
export function recordAudit(event: AuditEvent): void {
  const db = getDatabase();
  db.run(
    `INSERT INTO memory_audit (actor, scope, action, fact_id, call_id)
     VALUES (?, ?, ?, ?, ?)`,
    [event.actor, event.scope, event.action, event.factId ?? null, event.callId ?? null],
  );
}
