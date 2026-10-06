import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ClaimedTask,
  EnqueueInput,
  EnqueueResult,
  LeaseRecord,
  ReconcileDisposition,
  ReplayResult,
  TaskRecord,
  TaskState,
} from "../contracts.js";
import { ControlPlaneError, isTerminalTaskState, PRE_DISPATCH_TASK_STATES } from "../contracts.js";
import { appendAudit, initAuditSchema } from "../audit/audit-log.js";

interface TaskRow {
  readonly task_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly payload_digest: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly state: TaskState;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly requires_approval: number;
  readonly exhausted: number;
  readonly cancel_requested: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_error: string | null;
  readonly result_json: string | null;
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    ...row,
    requires_approval: row.requires_approval === 1,
    exhausted: row.exhausted === 1,
    cancel_requested: row.cancel_requested === 1,
  };
}

export interface TaskQueueOptions {
  readonly dbPath: string;
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
}

export interface QueueStats {
  readonly by_state: Readonly<Record<string, number>>;
  readonly active_leases: number;
  readonly paused: boolean;
  readonly total: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

// Every state-changing edge this package can emit, listed adjacent to the
// emitters that produce it. "staged" is a genesis audit event only — enqueue()
// inserts the row already at awaiting_approval or approved — so no task ever
// rests in staged and staged -> canceled is not emittable. The A4 conformance test asserts canTransition()
// admits each pair, so adding an emitter without adding its edge here — or
// adding an edge the canonical policy forbids — fails the battery closed.
export const EMITTED_LIFECYCLE_EDGES: readonly (readonly [TaskState | null, TaskState])[] = [
  [null, "staged"],
  ["staged", "awaiting_approval"],
  ["awaiting_approval", "approved"],
  ["awaiting_approval", "rejected"],
  ["approved", "applying"],
  ["applying", "applied"],
  ["applying", "failed_retryable"],
  ["applying", "outcome_unknown"],
  ["failed_retryable", "approved"],
  ["outcome_unknown", "reconciled"],
  ["awaiting_approval", "canceled"],
  ["approved", "canceled"],
  ["applied", "compensated"],
  ["reconciled", "compensated"],
];

// Annotation events record operator intent without moving the task. They are
// deliberately not transitions; this list is the complete set, pinned so the
// conformance test can prove no other self-edge exists.
export const EMITTED_ANNOTATION_EDGES: readonly (readonly [TaskState, TaskState])[] = [
  ["applying", "applying"],
];

export class DurableTaskQueue {
  readonly db: Database;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;

  constructor(options: TaskQueueOptions) {
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_tasks (
        task_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        exhausted INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        result_json TEXT,
        UNIQUE(idempotency_scope, idempotency_key)
      ) STRICT
    `);
    // Databases created before the approval class was persisted lack the
    // column; the additive migration defaults their existing rows to 0
    // (auto-approved), matching what enqueue() recorded for them at the time.
    const taskColumns = this.db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('cp_tasks')")
      .all();
    if (!taskColumns.some((column) => column.name === "requires_approval")) {
      this.db.run("ALTER TABLE cp_tasks ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0");
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_leases (
        lease_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES cp_tasks(task_id),
        worker_id TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_queue_control (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);
    initAuditSchema(this.db);
  }

  static payloadDigest(payload_json: string): string {
    return createHash("sha256").update(payload_json, "utf8").digest("hex");
  }

  private transition(fn: () => TaskRecord): TaskRecord {
    return this.db.transaction(fn)();
  }

  private getRow(task_id: string): TaskRow {
    const row = this.db.query<TaskRow, [string]>("SELECT * FROM cp_tasks WHERE task_id = ?").get(task_id);
    if (!row) throw new ControlPlaneError("task_not_found", `no task ${task_id}`);
    return row;
  }

  private setState(
    task_id: string,
    to: TaskState,
    fields: Partial<{ attempts: number; exhausted: number; cancel_requested: number; last_error: string | null; result_json: string | null }> = {},
  ): void {
    const sets: string[] = ["state = ?", "updated_at = ?"];
    const args: (string | number | null)[] = [to, this.now().toISOString()];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      args.push(value as string | number | null);
    }
    args.push(task_id);
    this.db.query(`UPDATE cp_tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...args);
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    const payload_digest = DurableTaskQueue.payloadDigest(input.payload_json);
    return this.db.transaction((): EnqueueResult => {
      const existing = this.db
        .query<TaskRow, [string, string]>(
          "SELECT * FROM cp_tasks WHERE idempotency_scope = ? AND idempotency_key = ?",
        )
        .get(input.idempotency_scope, input.idempotency_key);
      if (existing) {
        if (existing.payload_digest === payload_digest) return { outcome: "existing", task: toRecord(existing) };
        return { outcome: "idempotency_conflict", existing: toRecord(existing) };
      }
      const task_id = randomUUID();
      const at = this.now().toISOString();
      const initial: TaskState = input.requires_approval ? "awaiting_approval" : "approved";
      this.db
        .query(
          `INSERT INTO cp_tasks (task_id, kind, payload_json, payload_digest, idempotency_scope, idempotency_key, state, attempts, max_attempts, requires_approval, exhausted, cancel_requested, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?)`,
        )
        .run(
          task_id,
          input.kind,
          input.payload_json,
          payload_digest,
          input.idempotency_scope,
          input.idempotency_key,
          initial,
          Math.max(1, input.max_attempts ?? 1),
          input.requires_approval ? 1 : 0,
          at,
          at,
        );
      appendAudit(this.db, {
        task_id,
        kind: "staged",
        actor: input.actor,
        from_state: null,
        to_state: "staged",
        attempts: 0,
        payload_digest,
        occurred_at: at,
      });
      appendAudit(this.db, {
        task_id,
        kind: "awaiting_approval",
        actor: input.actor,
        from_state: "staged",
        to_state: "awaiting_approval",
        attempts: 0,
        payload_digest,
        occurred_at: at,
      });
      if (initial === "approved") {
        appendAudit(this.db, {
          task_id,
          kind: "approved",
          actor: input.actor,
          from_state: "awaiting_approval",
          to_state: "approved",
          attempts: 0,
          payload_digest,
          detail: { auto_approved: true },
          occurred_at: at,
        });
      }
      return { outcome: "enqueued", task: toRecord(this.getRow(task_id)) };
    })();
  }

  approve(task_id: string, actor: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (row.state !== "awaiting_approval") {
        throw new ControlPlaneError("invalid_transition", `approve requires awaiting_approval, got ${row.state}`);
      }
      this.setState(task_id, "approved");
      appendAudit(this.db, {
        task_id,
        kind: "approved",
        actor,
        from_state: row.state,
        to_state: "approved",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  reject(task_id: string, actor: string, reason: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (row.state !== "awaiting_approval") {
        throw new ControlPlaneError("invalid_transition", `reject requires awaiting_approval, got ${row.state}`);
      }
      this.setState(task_id, "rejected", { last_error: reason });
      appendAudit(this.db, {
        task_id,
        kind: "rejected",
        actor,
        from_state: row.state,
        to_state: "rejected",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail: { reason },
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  claim(worker_id: string): ClaimedTask | null {
    if (this.isPaused()) return null;
    const claimed = this.db.transaction((): ClaimedTask | null => {
      const row = this.db
        .query<TaskRow, []>(
          `SELECT t.* FROM cp_tasks t
           LEFT JOIN cp_leases l ON l.task_id = t.task_id
           WHERE t.state = 'approved' AND t.cancel_requested = 0 AND l.lease_id IS NULL
           ORDER BY t.created_at ASC LIMIT 1`,
        )
        .get();
      if (!row) return null;
      const at = this.now();
      const lease: LeaseRecord = {
        lease_id: randomUUID(),
        task_id: row.task_id,
        worker_id,
        issued_at: at.toISOString(),
        expires_at: new Date(at.getTime() + this.leaseTtlMs).toISOString(),
      };
      this.db
        .query("INSERT INTO cp_leases (lease_id, task_id, worker_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(lease.lease_id, lease.task_id, lease.worker_id, lease.issued_at, lease.expires_at);
      this.setState(row.task_id, "applying", { attempts: row.attempts + 1 });
      appendAudit(this.db, {
        task_id: row.task_id,
        kind: "claimed",
        actor: worker_id,
        from_state: row.state,
        to_state: "applying",
        attempts: row.attempts + 1,
        payload_digest: row.payload_digest,
        detail: { lease_id: lease.lease_id, expires_at: lease.expires_at },
        occurred_at: at.toISOString(),
      });
      return { task: toRecord(this.getRow(row.task_id)), lease };
    })();
    return claimed;
  }

  private requireValidLease(task_id: string, lease_id: string): LeaseRecord {
    const lease = this.db
      .query<LeaseRecord, [string]>("SELECT * FROM cp_leases WHERE task_id = ?")
      .get(task_id);
    if (!lease || lease.lease_id !== lease_id) {
      throw new ControlPlaneError("lease_invalid", `no matching lease for task ${task_id}`);
    }
    if (new Date(lease.expires_at).getTime() <= this.now().getTime()) {
      throw new ControlPlaneError("lease_expired", `lease ${lease_id} expired at ${lease.expires_at}`);
    }
    return lease;
  }

  heartbeat(task_id: string, lease_id: string): LeaseRecord {
    return this.db.transaction((): LeaseRecord => {
      this.requireValidLease(task_id, lease_id);
      const expires_at = new Date(this.now().getTime() + this.leaseTtlMs).toISOString();
      this.db.query("UPDATE cp_leases SET expires_at = ? WHERE lease_id = ?").run(expires_at, lease_id);
      const lease = this.db.query<LeaseRecord, [string]>("SELECT * FROM cp_leases WHERE lease_id = ?").get(lease_id);
      if (!lease) throw new ControlPlaneError("lease_invalid", "lease vanished during heartbeat");
      return lease;
    })();
  }

  complete(
    task_id: string,
    lease_id: string,
    worker_id: string,
    result_json: string | null,
    detail?: Record<string, unknown>,
  ): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      this.requireValidLease(task_id, lease_id);
      if (row.state !== "applying") {
        throw new ControlPlaneError("invalid_transition", `complete requires applying, got ${row.state}`);
      }
      this.setState(task_id, "applied", { result_json });
      this.db.query("DELETE FROM cp_leases WHERE lease_id = ?").run(lease_id);
      appendAudit(this.db, {
        task_id,
        kind: "applied",
        actor: worker_id,
        from_state: row.state,
        to_state: "applied",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail,
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  fail(task_id: string, lease_id: string, worker_id: string, error: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      this.requireValidLease(task_id, lease_id);
      if (row.state !== "applying") {
        throw new ControlPlaneError("invalid_transition", `fail requires applying, got ${row.state}`);
      }
      const exhausted = row.attempts >= row.max_attempts;
      this.db.query("DELETE FROM cp_leases WHERE lease_id = ?").run(lease_id);
      this.settleFailure(row, worker_id, error, exhausted, { requeued: !exhausted });
      return toRecord(this.getRow(task_id));
    });
  }

  // applying -> failed_retryable, then failed_retryable -> approved when the
  // task is still within budget. The second hop is the canonical requeue edge
  // and is guarded by canReturnToApproved(from, approvalStillValid): the
  // approval recorded at enqueue or by approve() remains valid across a retry,
  // so the guard holds without a re-approval round trip.
  private settleFailure(
    row: TaskRow,
    actor: string,
    error: string,
    exhausted: boolean,
    detail: Record<string, unknown>,
  ): void {
    const at = this.now().toISOString();
    this.setState(row.task_id, "failed_retryable", { exhausted: exhausted ? 1 : 0, last_error: error });
    appendAudit(this.db, {
      task_id: row.task_id,
      kind: "failed_retryable",
      actor,
      from_state: "applying",
      to_state: "failed_retryable",
      attempts: row.attempts,
      payload_digest: row.payload_digest,
      detail: { ...detail, error, exhausted },
      occurred_at: at,
    });
    if (exhausted) return;
    this.setState(row.task_id, "approved", { exhausted: 0 });
    appendAudit(this.db, {
      task_id: row.task_id,
      kind: "approved",
      actor,
      from_state: "failed_retryable",
      to_state: "approved",
      attempts: row.attempts,
      payload_digest: row.payload_digest,
      detail: { requeue: true, approval_still_valid: true },
      occurred_at: at,
    });
  }

  // The executor reported a clean failure while an operator cancel was pending.
  // The effect did not land, and the cancel forecloses further attempts, so the
  // task settles as an exhausted failed_retryable — terminal per
  // isTerminalTaskState — rather than taking the applying -> canceled edge the
  // canonical policy forbids after dispatch.
  failUnderCancel(task_id: string, lease_id: string, worker_id: string, error: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      this.requireValidLease(task_id, lease_id);
      if (row.state !== "applying" || row.cancel_requested !== 1) {
        throw new ControlPlaneError("invalid_transition", "failUnderCancel requires applying with cancel_requested");
      }
      this.db.query("DELETE FROM cp_leases WHERE lease_id = ?").run(lease_id);
      this.settleFailure(row, worker_id, error, true, { cancel_honored_as_exhaustion: true, requeued: false });
      return toRecord(this.getRow(task_id));
    });
  }

  // The worker vanished or threw while a cancel was pending: the effect may or
  // may not have landed and nothing will retry it, so the disposition is
  // genuinely unknown and must be surfaced rather than guessed.
  settleOutcomeUnknown(task_id: string, actor: string, reason: string, lease_id?: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (lease_id) this.requireValidLease(task_id, lease_id);
      if (row.state !== "applying") {
        throw new ControlPlaneError("invalid_transition", `settleOutcomeUnknown requires applying, got ${row.state}`);
      }
      this.setState(task_id, "outcome_unknown", { last_error: reason });
      this.db.query("DELETE FROM cp_leases WHERE task_id = ?").run(task_id);
      appendAudit(this.db, {
        task_id,
        kind: "outcome_unknown",
        actor,
        from_state: "applying",
        to_state: "outcome_unknown",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail: { reason, cancel_requested: row.cancel_requested === 1 },
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  // Operator resolution of an outcome_unknown task. The confirmed disposition
  // is recorded as the event kind — the canonical kind union has no
  // "reconciled" member — while to_state marks the lifecycle position.
  reconcile(
    task_id: string,
    actor: string,
    disposition: ReconcileDisposition,
    result_json: string | null = null,
  ): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (row.state !== "outcome_unknown") {
        throw new ControlPlaneError("invalid_transition", `reconcile requires outcome_unknown, got ${row.state}`);
      }
      this.setState(task_id, "reconciled", {
        result_json: disposition === "applied" ? result_json : null,
      });
      appendAudit(this.db, {
        task_id,
        kind: disposition === "applied" ? "applied" : "failed_retryable",
        actor,
        from_state: "outcome_unknown",
        to_state: "reconciled",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail: { reconciled: true, disposition },
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  cancel(task_id: string, actor: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (isTerminalTaskState(toRecord(row))) {
        throw new ControlPlaneError("invalid_transition", `cannot cancel terminal task in ${row.state}`);
      }
      if (row.state !== "applying" && !PRE_DISPATCH_TASK_STATES.has(row.state)) {
        throw new ControlPlaneError("invalid_transition", `cannot cancel a task in ${row.state}`);
      }
      if (row.state === "applying") {
        this.setState(task_id, row.state, { cancel_requested: 1 });
        appendAudit(this.db, {
          task_id,
          kind: "canceled",
          actor,
          from_state: row.state,
          to_state: row.state,
          attempts: row.attempts,
          payload_digest: row.payload_digest,
          detail: { cancel_requested: true, deferred: true, annotation: true },
          occurred_at: this.now().toISOString(),
        });
        return toRecord(this.getRow(task_id));
      }
      this.setState(task_id, "canceled", { cancel_requested: 1 });
      this.db.query("DELETE FROM cp_leases WHERE task_id = ?").run(task_id);
      appendAudit(this.db, {
        task_id,
        kind: "canceled",
        actor,
        from_state: row.state,
        to_state: "canceled",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  // Replay has two shapes because the canonical lifecycle has no edge out of a
  // truly terminal state. An exhausted failed_retryable task re-enters in place
  // over the legal failed_retryable -> approved edge. A task that reached
  // applied, rejected, canceled, reconciled, or compensated is immutable: the
  // replay stages a fresh superseding task instead, which is the canonical
  // shape (ActionRecordV1 carries supersedes_record_id for exactly this).
  replay(task_id: string, actor: string, expected_payload_digest: string): ReplayResult {
    return this.db.transaction((): ReplayResult => {
      const row = this.getRow(task_id);
      if (!isTerminalTaskState(toRecord(row))) {
        throw new ControlPlaneError("invalid_transition", `replay requires a terminal task, got ${row.state}`);
      }
      if (row.payload_digest !== expected_payload_digest) {
        throw new ControlPlaneError(
          "idempotency_mismatch",
          "replay payload digest does not match the recorded task payload",
        );
      }
      const at = this.now().toISOString();
      if (row.state === "failed_retryable") {
        this.setState(task_id, "approved", {
          attempts: 0,
          exhausted: 0,
          cancel_requested: 0,
          last_error: null,
          result_json: null,
        });
        appendAudit(this.db, {
          task_id,
          kind: "approved",
          actor,
          from_state: "failed_retryable",
          to_state: "approved",
          attempts: 0,
          payload_digest: row.payload_digest,
          detail: { replay: true, in_place: true },
          occurred_at: at,
        });
        return { task: toRecord(this.getRow(task_id)), superseded_task_id: null };
      }
      const ordinal =
        (this.db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM cp_tasks WHERE idempotency_scope = ? AND idempotency_key LIKE ?",
          )
          .get(row.idempotency_scope, `${row.idempotency_key}#replay-%`)?.n ?? 0) + 1;
      const replacement_id = randomUUID();
      // The approval class carries onto the replacement. A replacement is
      // auto-approved only when the original was itself auto-approved AND
      // reached applied, reconciled, or compensated; a rejected or canceled
      // original — an operator refusal — always stages its replacement at
      // awaiting_approval, and no approval event is fabricated for it. claim()
      // selects only state = 'approved', so an unapproved replacement is
      // structurally unclaimable until approve() runs.
      const auto_approved =
        row.requires_approval === 0 &&
        (row.state === "applied" || row.state === "reconciled" || row.state === "compensated");
      this.db
        .query(
          `INSERT INTO cp_tasks (task_id, kind, payload_json, payload_digest, idempotency_scope, idempotency_key, state, attempts, max_attempts, requires_approval, exhausted, cancel_requested, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?)`,
        )
        .run(
          replacement_id,
          row.kind,
          row.payload_json,
          row.payload_digest,
          row.idempotency_scope,
          `${row.idempotency_key}#replay-${ordinal}`,
          auto_approved ? "approved" : "awaiting_approval",
          row.max_attempts,
          auto_approved ? 0 : 1,
          at,
          at,
        );
      const supersedes = { replay: true, supersedes_task_id: task_id, superseded_state: row.state };
      appendAudit(this.db, {
        task_id: replacement_id,
        kind: "staged",
        actor,
        from_state: null,
        to_state: "staged",
        attempts: 0,
        payload_digest: row.payload_digest,
        detail: supersedes,
        occurred_at: at,
      });
      appendAudit(this.db, {
        task_id: replacement_id,
        kind: "awaiting_approval",
        actor,
        from_state: "staged",
        to_state: "awaiting_approval",
        attempts: 0,
        payload_digest: row.payload_digest,
        detail: supersedes,
        occurred_at: at,
      });
      if (auto_approved) {
        appendAudit(this.db, {
          task_id: replacement_id,
          kind: "approved",
          actor,
          from_state: "awaiting_approval",
          to_state: "approved",
          attempts: 0,
          payload_digest: row.payload_digest,
          detail: { ...supersedes, auto_approved: true },
          occurred_at: at,
        });
      }
      return { task: toRecord(this.getRow(replacement_id)), superseded_task_id: task_id };
    })();
  }

  rollback(task_id: string, actor: string, reason: string): TaskRecord {
    return this.transition(() => {
      const row = this.getRow(task_id);
      if (row.state !== "applied" && row.state !== "reconciled") {
        throw new ControlPlaneError("invalid_transition", `rollback requires applied or reconciled, got ${row.state}`);
      }
      this.setState(task_id, "compensated", { last_error: reason });
      appendAudit(this.db, {
        task_id,
        kind: "outcome_unknown",
        actor,
        from_state: row.state,
        to_state: "compensated",
        attempts: row.attempts,
        payload_digest: row.payload_digest,
        detail: { rollback: true, reason },
        occurred_at: this.now().toISOString(),
      });
      return toRecord(this.getRow(task_id));
    });
  }

  recoverExpiredLeases(): readonly TaskRecord[] {
    return this.db.transaction((): TaskRecord[] => {
      const nowIso = this.now().toISOString();
      const expired = this.db
        .query<LeaseRecord, [string]>("SELECT * FROM cp_leases WHERE expires_at <= ?")
        .all(nowIso);
      const recovered: TaskRecord[] = [];
      for (const lease of expired) {
        const row = this.getRow(lease.task_id);
        this.db.query("DELETE FROM cp_leases WHERE lease_id = ?").run(lease.lease_id);
        if (row.state !== "applying") continue;
        // outcome_unknown is scoped on "nothing will re-run", not on cancel
        // alone. A vanished worker leaves the effect unobserved; if a cancel is
        // pending OR the attempt budget is spent, no retry will ever converge
        // the ambiguity, so it is durable and must be surfaced for operator
        // reconciliation rather than buried as a terminal failure.
        const exhausted = row.attempts >= row.max_attempts;
        if (row.cancel_requested === 1 || exhausted) {
          this.setState(lease.task_id, "outcome_unknown", {
            last_error:
              row.cancel_requested === 1
                ? `lease ${lease.lease_id} expired while a cancel was pending`
                : `lease ${lease.lease_id} expired on the final attempt`,
          });
          appendAudit(this.db, {
            task_id: lease.task_id,
            kind: "outcome_unknown",
            actor: "recovery",
            from_state: "applying",
            to_state: "outcome_unknown",
            attempts: row.attempts,
            payload_digest: row.payload_digest,
            detail: {
              lease_expired: lease.lease_id,
              worker_id: lease.worker_id,
              cancel_requested: row.cancel_requested === 1,
              attempts_exhausted: exhausted,
            },
            occurred_at: nowIso,
          });
          recovered.push(toRecord(this.getRow(lease.task_id)));
          continue;
        }
        this.settleFailure(row, "recovery", `lease ${lease.lease_id} expired`, false, {
          lease_expired: lease.lease_id,
          worker_id: lease.worker_id,
          requeued: true,
        });
        recovered.push(toRecord(this.getRow(lease.task_id)));
      }
      return recovered;
    })();
  }

  pause(actor: string): void {
    this.db
      .query("INSERT INTO cp_queue_control (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ paused: true, actor, at: this.now().toISOString() }));
  }

  resume(actor: string): void {
    this.db
      .query("INSERT INTO cp_queue_control (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ paused: false, actor, at: this.now().toISOString() }));
  }

  isPaused(): boolean {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM cp_queue_control WHERE key = 'paused'")
      .get();
    if (!row) return false;
    return (JSON.parse(row.value) as { paused: boolean }).paused;
  }

  get(task_id: string): TaskRecord {
    return toRecord(this.getRow(task_id));
  }

  list(state?: TaskState): readonly TaskRecord[] {
    const rows = state
      ? this.db.query<TaskRow, [string]>("SELECT * FROM cp_tasks WHERE state = ? ORDER BY created_at ASC").all(state)
      : this.db.query<TaskRow, []>("SELECT * FROM cp_tasks ORDER BY created_at ASC").all();
    return rows.map(toRecord);
  }

  stats(): QueueStats {
    const rows = this.db
      .query<{ state: string; n: number }, []>("SELECT state, COUNT(*) AS n FROM cp_tasks GROUP BY state")
      .all();
    const by_state: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      by_state[row.state] = row.n;
      total += row.n;
    }
    const leases = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cp_leases").get();
    return { by_state, active_leases: leases?.n ?? 0, paused: this.isPaused(), total };
  }

  close(): void {
    this.db.close();
  }
}
