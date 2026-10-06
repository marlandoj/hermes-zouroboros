import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  ActionEventKind,
  ActionEventProposalV1,
  ActionReceiptWriter,
  CanonicalReceiptRef,
} from "@zouroboros/capability-runtime";
import type { TaskState } from "../contracts.js";
import { ControlPlaneError } from "../contracts.js";

export interface AuditAppendInput {
  readonly task_id: string;
  readonly kind: ActionEventKind;
  readonly actor: string;
  readonly from_state: TaskState | null;
  readonly to_state: TaskState;
  readonly attempts: number;
  readonly payload_digest: string;
  readonly detail?: Record<string, unknown>;
  readonly occurred_at: string;
}

export interface AuditRow {
  readonly seq: number;
  readonly event_id: string;
  readonly task_id: string;
  readonly kind: ActionEventKind;
  readonly actor: string;
  readonly from_state: TaskState | null;
  readonly to_state: TaskState;
  readonly attempts: number;
  readonly payload_digest: string;
  readonly detail_json: string;
  readonly occurred_at: string;
  readonly prev_hash: string | null;
  readonly event_hash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalEventBody(input: AuditAppendInput, event_id: string, prev_hash: string | null): string {
  return JSON.stringify({
    event_id,
    task_id: input.task_id,
    kind: input.kind,
    actor: input.actor,
    from_state: input.from_state,
    to_state: input.to_state,
    attempts: input.attempts,
    payload_digest: input.payload_digest,
    detail: input.detail ?? {},
    occurred_at: input.occurred_at,
    prev_hash,
  });
}

export function initAuditSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS cp_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      prev_hash TEXT,
      event_hash TEXT NOT NULL
    ) STRICT
  `);
  db.run("CREATE INDEX IF NOT EXISTS cp_audit_task ON cp_audit(task_id)");
  db.run(`
    CREATE TRIGGER IF NOT EXISTS cp_audit_no_update BEFORE UPDATE ON cp_audit
    BEGIN SELECT RAISE(ABORT, 'cp_audit is append-only'); END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS cp_audit_no_delete BEFORE DELETE ON cp_audit
    BEGIN SELECT RAISE(ABORT, 'cp_audit is append-only'); END
  `);
}

export function appendAudit(db: Database, input: AuditAppendInput): AuditRow {
  const tail = db
    .query<{ event_hash: string }, []>("SELECT event_hash FROM cp_audit ORDER BY seq DESC LIMIT 1")
    .get();
  const prev_hash = tail?.event_hash ?? null;
  const event_id = randomUUID();
  const body = canonicalEventBody(input, event_id, prev_hash);
  const event_hash = sha256(body);
  db.query(
    `INSERT INTO cp_audit (event_id, task_id, kind, actor, from_state, to_state, attempts, payload_digest, detail_json, occurred_at, prev_hash, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event_id,
    input.task_id,
    input.kind,
    input.actor,
    input.from_state,
    input.to_state,
    input.attempts,
    input.payload_digest,
    JSON.stringify(input.detail ?? {}),
    input.occurred_at,
    prev_hash,
    event_hash,
  );
  const row = db
    .query<AuditRow, [string]>("SELECT * FROM cp_audit WHERE event_id = ?")
    .get(event_id);
  if (!row) throw new ControlPlaneError("audit_append_failed", "audit row not visible after insert");
  return row;
}

export function verifyAuditChain(db: Database): { readonly ok: boolean; readonly length: number; readonly broken_at: number | null } {
  const rows = db.query<AuditRow, []>("SELECT * FROM cp_audit ORDER BY seq ASC").all();
  let prev: string | null = null;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, length: rows.length, broken_at: row.seq };
    const body = canonicalEventBody(
      {
        task_id: row.task_id,
        kind: row.kind,
        actor: row.actor,
        from_state: row.from_state,
        to_state: row.to_state,
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail: JSON.parse(row.detail_json) as Record<string, unknown>,
        occurred_at: row.occurred_at,
      },
      row.event_id,
      row.prev_hash,
    );
    if (sha256(body) !== row.event_hash) return { ok: false, length: rows.length, broken_at: row.seq };
    prev = row.event_hash;
  }
  return { ok: true, length: rows.length, broken_at: null };
}

export function listAudit(db: Database, task_id?: string): readonly AuditRow[] {
  if (task_id) {
    return db.query<AuditRow, [string]>("SELECT * FROM cp_audit WHERE task_id = ? ORDER BY seq ASC").all(task_id);
  }
  return db.query<AuditRow, []>("SELECT * FROM cp_audit ORDER BY seq ASC").all();
}

export function toActionEventProposal(row: AuditRow, run_id: string): ActionEventProposalV1 {
  const content_digest = sha256(
    JSON.stringify({ event_id: row.event_id, event_hash: row.event_hash, run_id }),
  );
  return {
    schema_family: "zcr.action-event-proposal",
    schema_major: 1,
    event_id: row.event_id,
    action_id: row.task_id,
    run_id,
    action_sequence: row.attempts,
    kind: row.kind,
    from_state: row.from_state,
    to_state: row.to_state,
    action_content_digest: row.payload_digest,
    payload_digest: row.payload_digest,
    proof_digests: [row.event_hash],
    occurred_at: row.occurred_at,
    content_digest,
  };
}

export function createReceiptForwarder(
  db: Database,
  writer: ActionReceiptWriter,
  run_id: string,
): { forwardAll(): Promise<readonly CanonicalReceiptRef[]> } {
  return {
    async forwardAll() {
      const rows = listAudit(db);
      if (rows.length === 0) return [];
      return writer.appendBatch(rows.map((row) => toActionEventProposal(row, run_id)));
    },
  };
}
