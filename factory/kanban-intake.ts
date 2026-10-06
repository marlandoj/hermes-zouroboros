// Derived from workspace Projects/zouroboros-software-factory/scripts/kanban-intake.ts; see PROVENANCE.json.
/**
 * kanban-intake.ts — read-only Factory intake from the Hermes Kanban board.
 *
 * Replaces the Linear puller as the Factory ticket source. Opens the
 * `software-factory` board database read-only (query_only, one read
 * transaction), checks its integrity and that its table schema matches the
 * hash pinned in the deployed Hermes foundation manifest, then returns task
 * rows. It never claims, comments on, or otherwise writes to the board.
 *
 * Pullable = status `ready` with no live claim, which is the status Hermes
 * workers claim from. Ordering follows the Hermes dispatcher:
 * priority DESC, created_at ASC (task id breaks remaining ties).
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KANBAN_BOARD = 'software-factory';
/** Pinned hermes_cli/kanban_db.py `_new_task_id`: "t_" + secrets.token_hex(4). */
export const KANBAN_TASK_ID = /^t_[0-9a-f]{8}$/;
/** Pinned hermes_cli/kanban_db.py VALID_STATUSES. */
export const KANBAN_STATUSES: ReadonlySet<string> = new Set([
  'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived',
]);
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'archived']);
export const MAX_TASKS = 1000;
const MAX_TITLE = 512;
const MAX_BODY_BYTES = 65_536;

export interface KanbanTask {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  /** Unix seconds, as stored by Hermes. */
  created_at: number;
  claimed: boolean;
}

export interface BoardSnapshot {
  board: typeof KANBAN_BOARD;
  schema_sha256: string;
  tasks: KanbanTask[];
}

export interface IntakeTicket {
  /** Hermes task id; also the plan/receipt file stem. */
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  created_at: string;
}

export interface BoardReadOptions {
  boardDir: string;
  manifestPath: string;
}

/** Same digest as hermes_foundation.py: table DDL ordered by name, joined by newlines. */
export function tableSchemaSha256(db: Database): string {
  const rows = db.query("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as { sql: string | null }[];
  return createHash('sha256').update(rows.map(r => r.sql ?? '').join('\n')).digest('hex');
}

export function readBoardSnapshot(options: BoardReadOptions): BoardSnapshot {
  if (!options?.boardDir || !options?.manifestPath) throw new Error('Explicit boardDir and manifestPath are required');
  const boardDir = options.boardDir;
  const manifest = JSON.parse(readFileSync(options.manifestPath, 'utf8'));
  if (manifest?.board !== KANBAN_BOARD || typeof manifest.schema_sha256 !== 'string' ||
      !Number.isInteger(manifest.schema_version)) throw new Error('Invalid Hermes manifest');
  const metadata = JSON.parse(readFileSync(join(boardDir, 'board.json'), 'utf8'));
  if (metadata?.slug !== KANBAN_BOARD || metadata.archived) throw new Error('Board identity mismatch or archived board');

  const db = new Database(join(boardDir, 'kanban.db'), { readonly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    // Integrity, schema and rows must describe one read snapshot.
    db.exec('BEGIN');
    try {
      const integrity = db.query('PRAGMA quick_check').all() as { quick_check: string }[];
      if (integrity.length !== 1 || integrity[0]!.quick_check !== 'ok') throw new Error('Board integrity failure');
      const schema = tableSchemaSha256(db);
      const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (schema !== manifest.schema_sha256 || version !== manifest.schema_version) throw new Error('Unqualified board schema');
      const rows = db.query(
        'SELECT id, title, body, status, priority, created_at, claim_lock FROM main.tasks ORDER BY id LIMIT ?',
      ).all(MAX_TASKS + 1) as Array<{
        id: unknown; title: unknown; body: unknown; status: unknown; priority: unknown; created_at: unknown; claim_lock: unknown;
      }>;
      if (rows.length > MAX_TASKS) throw new Error('Board exceeds intake limit');
      const tasks = rows.map((row): KanbanTask => {
        const body = row.body ?? '';
        if (typeof row.id !== 'string' || !KANBAN_TASK_ID.test(row.id) ||
            typeof row.title !== 'string' || !row.title.trim() || row.title.length > MAX_TITLE ||
            typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_BYTES ||
            typeof row.status !== 'string' || !KANBAN_STATUSES.has(row.status) ||
            !Number.isInteger(row.priority ?? 0) || !Number.isInteger(row.created_at)) throw new Error('Invalid board task');
        return {
          id: row.id, title: row.title.trim(), body, status: row.status,
          priority: (row.priority ?? 0) as number, created_at: row.created_at as number,
          claimed: row.claim_lock !== null && row.claim_lock !== undefined,
        };
      });
      return { board: KANBAN_BOARD, schema_sha256: schema, tasks };
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}

export function isPullable(task: KanbanTask): boolean {
  return task.status === 'ready' && !task.claimed;
}

export function toTicket(task: KanbanTask): IntakeTicket {
  return {
    identifier: task.id, title: task.title, description: task.body, status: task.status,
    priority: task.priority, created_at: new Date(task.created_at * 1000).toISOString(),
  };
}

/** Hermes dispatcher order: priority DESC, created_at ASC. */
export function pickHighestPriority(tickets: IntakeTicket[], limit = 1): IntakeTicket[] {
  const sorted = [...tickets].sort((a, b) =>
    b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.identifier.localeCompare(b.identifier));
  return sorted.slice(0, Math.max(0, limit));
}
