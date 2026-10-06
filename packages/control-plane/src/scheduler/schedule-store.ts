import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ControlPlaneError } from "../contracts.js";
import type { DurableTaskQueue } from "../queue/task-queue.js";
import { parseCron } from "./cron.js";
import { assertValidZone, nextCronFireUtc, nextIntervalFireUtc, wallClock } from "./timezone.js";
import type {
  OverlapPolicy,
  RegisterScheduleInput,
  ScheduleRecord,
  ScheduleFault,
  ScheduleRunKind,
  ScheduleRunRow,
  SchedulerStats,
  ScheduleExpressionType,
  TickReport,
} from "./contracts.js";

interface ScheduleRow {
  readonly schedule_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly expression_type: ScheduleExpressionType;
  readonly expression: string;
  readonly zone: string;
  readonly anchor_at: string;
  readonly next_fire_at: string;
  readonly paused: number;
  readonly overlap_policy: OverlapPolicy;
  readonly catch_up_limit: number;
  readonly retry_max_attempts: number;
  readonly retry_backoff_ms: number;
  readonly requires_approval: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RetryRow {
  readonly schedule_id: string;
  readonly fire_at: string;
  readonly retry_n: number;
  readonly due_at: string;
  readonly failed_task_id: string;
}

function toRecord(row: ScheduleRow): ScheduleRecord {
  return {
    ...row,
    paused: row.paused === 1,
    requires_approval: row.requires_approval === 1,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
// Bounds one tick's catch-up walk. When a schedule is further behind than this
// (weeks of downtime on a minutely schedule), the walk collapses the remainder
// into a single missed record rather than enumerating every occurrence.
const MAX_OCCURRENCES_PER_TICK = 1_000;

// One tick processes many independent units of work. A fault in any one of them
// is isolated to that unit: it is recorded as durable evidence and the loop
// continues, so a single wedged schedule can never starve the ones behind it
// (the due list is next_fire_at ASC, which puts a wedge first by construction)
// nor skip the trailing retry-reconciliation pass.
const TICK_FAILURE_REASONS = ["schedule_tick_failed", "schedule_retry_failed", "schedule_reconcile_failed"] as const;
type TickFailureReason = (typeof TICK_FAILURE_REASONS)[number];

const NON_TERMINAL_TASK_SQL = `
  SELECT COUNT(*) AS n FROM cp_tasks
  WHERE idempotency_scope = ?
    AND (
      state IN ('staged', 'awaiting_approval', 'approved', 'applying', 'outcome_unknown')
      OR (state = 'failed_retryable' AND exhausted = 0)
    )
`;

export interface ScheduleStoreOptions {
  readonly queue: DurableTaskQueue;
  readonly now?: () => Date;
}

export class DurableScheduleStore {
  private readonly queue: DurableTaskQueue;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: ScheduleStoreOptions) {
    this.queue = options.queue;
    this.db = options.queue.db;
    this.now = options.now ?? (() => new Date());
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_schedules (
        schedule_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expression_type TEXT NOT NULL,
        expression TEXT NOT NULL,
        zone TEXT NOT NULL,
        anchor_at TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        overlap_policy TEXT NOT NULL,
        catch_up_limit INTEGER NOT NULL,
        retry_max_attempts INTEGER NOT NULL,
        retry_backoff_ms INTEGER NOT NULL,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_schedule_retries (
        schedule_id TEXT NOT NULL REFERENCES cp_schedules(schedule_id),
        fire_at TEXT NOT NULL,
        retry_n INTEGER NOT NULL,
        due_at TEXT NOT NULL,
        failed_task_id TEXT NOT NULL,
        PRIMARY KEY (schedule_id, fire_at, retry_n)
      ) STRICT
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cp_schedule_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        schedule_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        fire_at TEXT,
        task_id TEXT,
        actor TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        prev_hash TEXT,
        event_hash TEXT NOT NULL
      ) STRICT
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS cp_schedule_runs_schedule ON cp_schedule_runs(schedule_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS cp_schedule_runs_task ON cp_schedule_runs(task_id)");
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS cp_schedule_runs_no_update BEFORE UPDATE ON cp_schedule_runs
      BEGIN SELECT RAISE(ABORT, 'cp_schedule_runs is append-only'); END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS cp_schedule_runs_no_delete BEFORE DELETE ON cp_schedule_runs
      BEGIN SELECT RAISE(ABORT, 'cp_schedule_runs is append-only'); END
    `);
  }

  private appendRun(input: {
    schedule_id: string;
    kind: ScheduleRunKind;
    fire_at?: string | null;
    task_id?: string | null;
    actor: string;
    detail?: Record<string, unknown>;
  }): ScheduleRunRow {
    const tail = this.db
      .query<{ event_hash: string }, []>("SELECT event_hash FROM cp_schedule_runs ORDER BY seq DESC LIMIT 1")
      .get();
    const prev_hash = tail?.event_hash ?? null;
    const run_id = randomUUID();
    const occurred_at = this.now().toISOString();
    const detail_json = JSON.stringify(input.detail ?? {});
    const body = JSON.stringify({
      run_id,
      schedule_id: input.schedule_id,
      kind: input.kind,
      fire_at: input.fire_at ?? null,
      task_id: input.task_id ?? null,
      actor: input.actor,
      detail_json,
      occurred_at,
      prev_hash,
    });
    const event_hash = sha256(body);
    this.db
      .query(
        `INSERT INTO cp_schedule_runs (run_id, schedule_id, kind, fire_at, task_id, actor, detail_json, occurred_at, prev_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run_id,
        input.schedule_id,
        input.kind,
        input.fire_at ?? null,
        input.task_id ?? null,
        input.actor,
        detail_json,
        occurred_at,
        prev_hash,
        event_hash,
      );
    const row = this.db
      .query<ScheduleRunRow, [string]>("SELECT * FROM cp_schedule_runs WHERE run_id = ?")
      .get(run_id);
    if (!row) throw new ControlPlaneError("evidence_append_failed", "schedule run row not visible after insert");
    return row;
  }

  private getRow(schedule_id: string): ScheduleRow {
    const row = this.db
      .query<ScheduleRow, [string]>("SELECT * FROM cp_schedules WHERE schedule_id = ?")
      .get(schedule_id);
    if (!row) throw new ControlPlaneError("schedule_not_found", `no schedule ${schedule_id}`);
    return row;
  }

  private nextFireMs(row: Pick<ScheduleRow, "expression_type" | "expression" | "zone" | "anchor_at">, afterMs: number): number {
    if (row.expression_type === "interval") {
      return nextIntervalFireUtc(Date.parse(row.anchor_at), Number(row.expression), afterMs);
    }
    const next = nextCronFireUtc(parseCron(row.expression), row.zone, afterMs);
    if (next === null) {
      throw new ControlPlaneError("schedule_invalid", `cron "${row.expression}" cannot fire within the search horizon`);
    }
    return next;
  }

  // Registration fails closed: an unparseable expression, unknown zone, or
  // never-firing schedule is rejected here and never coerced or stored.
  register(input: RegisterScheduleInput): ScheduleRecord {
    if (!input.schedule_id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.schedule_id)) {
      throw new ControlPlaneError("schedule_invalid", "schedule_id must be a non-empty identifier");
    }
    if (!input.kind) throw new ControlPlaneError("schedule_invalid", "kind is required");
    try {
      JSON.parse(input.payload_json);
    } catch {
      throw new ControlPlaneError("schedule_invalid", "payload_json must be valid JSON");
    }
    const zone = input.zone ?? "UTC";
    assertValidZone(zone);
    if (input.expression_type === "cron") {
      parseCron(input.expression);
    } else if (input.expression_type === "interval") {
      const intervalMs = Number(input.expression);
      if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        throw new ControlPlaneError(
          "schedule_invalid",
          `interval expression must be an integer >= ${MIN_INTERVAL_MS} milliseconds`,
        );
      }
    } else {
      throw new ControlPlaneError("schedule_invalid", `unknown expression_type ${String(input.expression_type)}`);
    }
    const overlap = input.overlap_policy ?? "skip";
    if (overlap !== "skip" && overlap !== "allow") {
      throw new ControlPlaneError("schedule_invalid", `unknown overlap_policy ${String(overlap)}`);
    }
    const catch_up_limit = input.catch_up_limit ?? 0;
    const retry_max_attempts = input.retry_max_attempts ?? 0;
    const retry_backoff_ms = input.retry_backoff_ms ?? DEFAULT_RETRY_BACKOFF_MS;
    for (const [name, value] of Object.entries({ catch_up_limit, retry_max_attempts, retry_backoff_ms })) {
      if (!Number.isInteger(value) || value < 0) {
        throw new ControlPlaneError("schedule_invalid", `${name} must be a non-negative integer`);
      }
    }
    return this.db.transaction((): ScheduleRecord => {
      const existing = this.db
        .query<{ schedule_id: string }, [string]>("SELECT schedule_id FROM cp_schedules WHERE schedule_id = ?")
        .get(input.schedule_id);
      if (existing) throw new ControlPlaneError("schedule_exists", `schedule ${input.schedule_id} already exists`);
      const at = this.now();
      const anchor_at = at.toISOString();
      const next_fire_at = new Date(
        this.nextFireMs(
          {
            expression_type: input.expression_type,
            expression: input.expression,
            zone,
            anchor_at,
          },
          at.getTime(),
        ),
      ).toISOString();
      this.db
        .query(
          `INSERT INTO cp_schedules (schedule_id, kind, payload_json, expression_type, expression, zone, anchor_at, next_fire_at, paused, overlap_policy, catch_up_limit, retry_max_attempts, retry_backoff_ms, requires_approval, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.schedule_id,
          input.kind,
          input.payload_json,
          input.expression_type,
          input.expression,
          zone,
          anchor_at,
          next_fire_at,
          overlap,
          catch_up_limit,
          retry_max_attempts,
          retry_backoff_ms,
          input.requires_approval ? 1 : 0,
          anchor_at,
          anchor_at,
        );
      this.appendRun({
        schedule_id: input.schedule_id,
        kind: "registered",
        actor: input.actor,
        detail: {
          expression_type: input.expression_type,
          expression: input.expression,
          zone,
          overlap_policy: overlap,
          catch_up_limit,
          retry_max_attempts,
          retry_backoff_ms,
          requires_approval: input.requires_approval === true,
          next_fire_at,
        },
      });
      return toRecord(this.getRow(input.schedule_id));
    })();
  }

  pause(schedule_id: string, actor: string): ScheduleRecord {
    return this.db.transaction((): ScheduleRecord => {
      const row = this.getRow(schedule_id);
      if (row.paused === 0) {
        this.db
          .query("UPDATE cp_schedules SET paused = 1, updated_at = ? WHERE schedule_id = ?")
          .run(this.now().toISOString(), schedule_id);
        this.appendRun({ schedule_id, kind: "paused", actor });
      }
      return toRecord(this.getRow(schedule_id));
    })();
  }

  resume(schedule_id: string, actor: string): ScheduleRecord {
    return this.db.transaction((): ScheduleRecord => {
      const row = this.getRow(schedule_id);
      if (row.paused === 1) {
        this.db
          .query("UPDATE cp_schedules SET paused = 0, updated_at = ? WHERE schedule_id = ?")
          .run(this.now().toISOString(), schedule_id);
        this.appendRun({ schedule_id, kind: "resumed", actor });
      }
      return toRecord(this.getRow(schedule_id));
    })();
  }

  remove(schedule_id: string, actor: string): void {
    this.db.transaction(() => {
      this.getRow(schedule_id);
      this.db.query("DELETE FROM cp_schedule_retries WHERE schedule_id = ?").run(schedule_id);
      this.db.query("DELETE FROM cp_schedules WHERE schedule_id = ?").run(schedule_id);
      this.appendRun({ schedule_id, kind: "removed", actor });
    })();
  }

  get(schedule_id: string): ScheduleRecord {
    return toRecord(this.getRow(schedule_id));
  }

  list(): readonly ScheduleRecord[] {
    return this.db
      .query<ScheduleRow, []>("SELECT * FROM cp_schedules ORDER BY schedule_id ASC")
      .all()
      .map(toRecord);
  }

  runs(schedule_id?: string): readonly ScheduleRunRow[] {
    if (schedule_id) {
      return this.db
        .query<ScheduleRunRow, [string]>("SELECT * FROM cp_schedule_runs WHERE schedule_id = ? ORDER BY seq ASC")
        .all(schedule_id);
    }
    return this.db.query<ScheduleRunRow, []>("SELECT * FROM cp_schedule_runs ORDER BY seq ASC").all();
  }

  verifyRunChain(): { readonly ok: boolean; readonly length: number; readonly broken_at: number | null } {
    const rows = this.runs();
    let prev: string | null = null;
    for (const row of rows) {
      if (row.prev_hash !== prev) return { ok: false, length: rows.length, broken_at: row.seq };
      const body = JSON.stringify({
        run_id: row.run_id,
        schedule_id: row.schedule_id,
        kind: row.kind,
        fire_at: row.fire_at,
        task_id: row.task_id,
        actor: row.actor,
        detail_json: row.detail_json,
        occurred_at: row.occurred_at,
        prev_hash: row.prev_hash,
      });
      if (sha256(body) !== row.event_hash) return { ok: false, length: rows.length, broken_at: row.seq };
      prev = row.event_hash;
    }
    return { ok: true, length: rows.length, broken_at: null };
  }

  stats(): SchedulerStats {
    const schedules = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cp_schedules").get()?.n ?? 0;
    const paused =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cp_schedules WHERE paused = 1").get()?.n ?? 0;
    const pending_retries =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cp_schedule_retries").get()?.n ?? 0;
    const next = this.db
      .query<{ next_fire_at: string }, []>(
        "SELECT next_fire_at FROM cp_schedules WHERE paused = 0 ORDER BY next_fire_at ASC LIMIT 1",
      )
      .get();
    const evidence_rows =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cp_schedule_runs").get()?.n ?? 0;
    // A schedule counts as failing only while its recorded fault still binds to
    // the occurrence it is stuck on; once next_fire_at advances the signal
    // clears on its own, with the evidence row retained.
    const failing_schedules =
      this.db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM cp_schedules s WHERE EXISTS (
             SELECT 1 FROM cp_schedule_runs r
             WHERE r.schedule_id = s.schedule_id AND r.kind = 'missed' AND r.fire_at = s.next_fire_at
               AND json_extract(r.detail_json, '$.reason') = 'schedule_tick_failed'
           )`,
        )
        .get()?.n ?? 0;
    const lastFault = this.db
      .query<{ schedule_id: string; detail_json: string; occurred_at: string }, []>(
        `SELECT schedule_id, detail_json, occurred_at FROM cp_schedule_runs
         WHERE kind = 'missed' AND json_extract(detail_json, '$.reason') IN ('schedule_tick_failed', 'schedule_retry_failed', 'schedule_reconcile_failed')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get();
    let last_tick_error: ScheduleFault | null = null;
    if (lastFault) {
      const detail = JSON.parse(lastFault.detail_json) as { reason: string; error?: string };
      last_tick_error = {
        schedule_id: lastFault.schedule_id,
        reason: detail.reason,
        error: detail.error ?? "",
        occurred_at: lastFault.occurred_at,
      };
    }
    return {
      schedules,
      paused,
      pending_retries,
      next_fire_at: next?.next_fire_at ?? null,
      evidence_rows,
      degraded: failing_schedules > 0,
      failing_schedules,
      last_tick_error,
    };
  }

  // Fault evidence is written in its own transaction because the transaction
  // that would have carried it is the one that just rolled back. It is keyed on
  // (schedule_id, fire_at, reason) so a schedule wedged across thousands of
  // ticks records exactly one row per stuck occurrence, not one per tick.
  private recordTickFailure(
    schedule_id: string,
    fire_at: string | null,
    reason: TickFailureReason,
    error: unknown,
    actor: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.db.transaction(() => {
        const existing = this.db
          .query<{ n: number }, [string, string | null, string]>(
            `SELECT COUNT(*) AS n FROM cp_schedule_runs
             WHERE schedule_id = ? AND kind = 'missed' AND fire_at IS ?
               AND json_extract(detail_json, '$.reason') = ?`,
          )
          .get(schedule_id, fire_at, reason);
        if ((existing?.n ?? 0) > 0) return;
        this.appendRun({
          schedule_id,
          kind: "missed",
          fire_at,
          actor,
          detail: { reason, error: message },
        });
      })();
    } catch {
      // Evidence itself is unwritable for this schedule (an append-only guard
      // or a poisoned row). The fault is still isolated and the loop continues;
      // suppressing here cannot mask the wedge, which stays visible as a
      // never-advancing next_fire_at.
    }
  }

  private scopeOf(schedule_id: string): string {
    return `schedule:${schedule_id}`;
  }

  private hasActiveTask(schedule_id: string): boolean {
    const row = this.db.query<{ n: number }, [string]>(NON_TERMINAL_TASK_SQL).get(this.scopeOf(schedule_id));
    return (row?.n ?? 0) > 0;
  }

  private firedEvidenceExists(schedule_id: string, fire_at: string, retry_n: number): boolean {
    const rows = this.db
      .query<{ detail_json: string }, [string, string]>(
        "SELECT detail_json FROM cp_schedule_runs WHERE schedule_id = ? AND fire_at = ? AND kind = 'fired'",
      )
      .all(schedule_id, fire_at);
    return rows.some((row) => (JSON.parse(row.detail_json) as { retry_n?: number }).retry_n === retry_n);
  }

  // Enqueue exactly one task for one occurrence (or retry) of a schedule, with
  // the run evidence persisted in the same transaction — the evidence row and
  // the queue insert commit or roll back together, so a fire can never exist
  // without its evidence nor evidence without its fire.
  private fireOccurrence(row: ScheduleRow, fire_at: string, retry_n: number, actor: string): "fired" | "duplicate" {
    if (this.firedEvidenceExists(row.schedule_id, fire_at, retry_n)) return "duplicate";
    const idempotency_key = retry_n === 0 ? fire_at : `${fire_at}#retry-${retry_n}`;
    const result = this.queue.enqueue({
      kind: row.kind,
      payload_json: row.payload_json,
      idempotency_scope: this.scopeOf(row.schedule_id),
      idempotency_key,
      max_attempts: 1,
      requires_approval: row.requires_approval === 1,
      actor,
    });
    const task =
      result.outcome === "idempotency_conflict" ? result.existing : result.task;
    this.appendRun({
      schedule_id: row.schedule_id,
      kind: "fired",
      fire_at,
      task_id: task.task_id,
      actor,
      detail: { retry_n, enqueue_outcome: result.outcome, local_zone: row.zone },
    });
    return "fired";
  }

  tick(at?: Date): TickReport {
    const nowDate = at ?? this.now();
    const nowMs = nowDate.getTime();
    const nowIso = nowDate.toISOString();
    const actor = "scheduler";
    let failed = 0;
    let fired = 0;
    let skipped_overlap = 0;
    let missed = 0;
    let retries_fired = 0;
    let retries_scheduled = 0;
    let exhausted = 0;

    const dueRetries = this.db
      .query<RetryRow, [string]>("SELECT * FROM cp_schedule_retries WHERE due_at <= ? ORDER BY due_at ASC")
      .all(nowIso);
    for (const retry of dueRetries) {
      try {
        this.db.transaction(() => {
          const pending = this.db
            .query<RetryRow, [string, string, number]>(
              "SELECT * FROM cp_schedule_retries WHERE schedule_id = ? AND fire_at = ? AND retry_n = ?",
            )
            .get(retry.schedule_id, retry.fire_at, retry.retry_n);
          if (!pending) return;
          this.db
            .query("DELETE FROM cp_schedule_retries WHERE schedule_id = ? AND fire_at = ? AND retry_n = ?")
            .run(retry.schedule_id, retry.fire_at, retry.retry_n);
          const row = this.db
            .query<ScheduleRow, [string]>("SELECT * FROM cp_schedules WHERE schedule_id = ?")
            .get(retry.schedule_id);
          if (!row || row.paused === 1) return;
          if (this.fireOccurrence(row, retry.fire_at, retry.retry_n, actor) === "fired") retries_fired += 1;
        })();
      } catch (error) {
        failed += 1;
        this.recordTickFailure(retry.schedule_id, retry.fire_at, "schedule_retry_failed", error, actor);
      }
    }

    const due = this.db
      .query<{ schedule_id: string }, [string]>(
        "SELECT schedule_id FROM cp_schedules WHERE paused = 0 AND next_fire_at <= ? ORDER BY next_fire_at ASC",
      )
      .all(nowIso);
    for (const { schedule_id } of due) {
      try {
        this.db.transaction(() => {
          const row = this.db
            .query<ScheduleRow, [string]>("SELECT * FROM cp_schedules WHERE schedule_id = ?")
            .get(schedule_id);
          if (!row || row.paused === 1) return;
          let occMs = Date.parse(row.next_fire_at);
          if (occMs > nowMs) return;
          const occurrences: number[] = [];
          let collapsed = 0;
          while (occMs <= nowMs) {
            if (occurrences.length >= MAX_OCCURRENCES_PER_TICK) {
              collapsed = 1;
              break;
            }
            occurrences.push(occMs);
            occMs = this.nextFireMs(row, occMs);
          }
          if (collapsed) {
            this.appendRun({
              schedule_id,
              kind: "missed",
              fire_at: new Date(occurrences[0]).toISOString(),
              actor,
              detail: {
                reason: "catch_up_walk_collapsed",
                walk_cap: MAX_OCCURRENCES_PER_TICK,
                span_from: new Date(occurrences[0]).toISOString(),
                span_through: nowIso,
                enumerated: occurrences.length,
              },
            });
            missed += 1;
          }
          const allowed = row.catch_up_limit + 1;
          const missedOccurrences = collapsed
            ? []
            : occurrences.slice(0, Math.max(0, occurrences.length - allowed));
          const toFire = collapsed ? [] : occurrences.slice(Math.max(0, occurrences.length - allowed));
          for (const missedMs of missedOccurrences) {
            this.appendRun({
              schedule_id,
              kind: "missed",
              fire_at: new Date(missedMs).toISOString(),
              actor,
              detail: { reason: "beyond_catch_up_limit", catch_up_limit: row.catch_up_limit },
            });
            missed += 1;
          }
          for (const fireMs of toFire) {
            const fireIso = new Date(fireMs).toISOString();
            if (row.overlap_policy === "skip" && this.hasActiveTask(schedule_id)) {
              this.appendRun({
                schedule_id,
                kind: "skipped_overlap",
                fire_at: fireIso,
                actor,
                detail: { overlap_policy: row.overlap_policy },
              });
              skipped_overlap += 1;
              continue;
            }
            if (this.fireOccurrence(row, fireIso, 0, actor) === "fired") fired += 1;
          }
          const nextMs = collapsed ? this.nextFireMs(row, nowMs) : occMs;
          this.db
            .query("UPDATE cp_schedules SET next_fire_at = ?, updated_at = ? WHERE schedule_id = ?")
            .run(new Date(nextMs).toISOString(), nowIso, schedule_id);
        })();
      } catch (error) {
        failed += 1;
        const stuck = this.db
          .query<{ next_fire_at: string }, [string]>("SELECT next_fire_at FROM cp_schedules WHERE schedule_id = ?")
          .get(schedule_id);
        this.recordTickFailure(schedule_id, stuck?.next_fire_at ?? null, "schedule_tick_failed", error, actor);
      }
    }

    // Retry reconciliation is tick-driven and durable: an exhausted failed
    // scheduler task with no recorded disposition gets exactly one — either a
    // scheduled retry within budget or an exhausted_retries record. Crash
    // between settle and this pass loses nothing; the next tick sees the same
    // undisposed task.
    const failedTasks = this.db
      .query<
        { task_id: string; idempotency_scope: string; idempotency_key: string; last_error: string | null },
        []
      >(
        `SELECT task_id, idempotency_scope, idempotency_key, last_error FROM cp_tasks
         WHERE idempotency_scope LIKE 'schedule:%' AND state = 'failed_retryable' AND exhausted = 1`,
      )
      .all();
    for (const task of failedTasks) {
      try {
        this.db.transaction(() => {
          const disposed = this.db
            .query<{ n: number }, [string]>(
              "SELECT COUNT(*) AS n FROM cp_schedule_runs WHERE task_id = ? AND kind IN ('retry_scheduled', 'exhausted_retries')",
            )
            .get(task.task_id);
          if ((disposed?.n ?? 0) > 0) return;
          const schedule_id = task.idempotency_scope.slice("schedule:".length);
          const row = this.db
            .query<ScheduleRow, [string]>("SELECT * FROM cp_schedules WHERE schedule_id = ?")
            .get(schedule_id);
          if (!row) return;
          const retryMatch = /^(.*)#retry-(\d+)$/.exec(task.idempotency_key);
          const fire_at = retryMatch ? retryMatch[1] : task.idempotency_key;
          const prior_retry_n = retryMatch ? Number(retryMatch[2]) : 0;
          const next_retry_n = prior_retry_n + 1;
          if (next_retry_n <= row.retry_max_attempts) {
            const backoff = row.retry_backoff_ms * 2 ** prior_retry_n;
            const due_at = new Date(nowMs + backoff).toISOString();
            this.db
              .query(
                "INSERT INTO cp_schedule_retries (schedule_id, fire_at, retry_n, due_at, failed_task_id) VALUES (?, ?, ?, ?, ?)",
              )
              .run(schedule_id, fire_at, next_retry_n, due_at, task.task_id);
            this.appendRun({
              schedule_id,
              kind: "retry_scheduled",
              fire_at,
              task_id: task.task_id,
              actor,
              detail: { retry_n: next_retry_n, due_at, backoff_ms: backoff, error: task.last_error },
            });
            retries_scheduled += 1;
          } else {
            this.appendRun({
              schedule_id,
              kind: "exhausted_retries",
              fire_at,
              task_id: task.task_id,
              actor,
              detail: { retry_max_attempts: row.retry_max_attempts, error: task.last_error },
            });
            exhausted += 1;
          }
        })();
      } catch (error) {
        failed += 1;
        this.recordTickFailure(
          task.idempotency_scope.slice("schedule:".length),
          task.idempotency_key,
          "schedule_reconcile_failed",
          error,
          actor,
        );
      }
    }

    return { failed, fired, skipped_overlap, missed, retries_fired, retries_scheduled, exhausted };
  }

  // Diagnostic view of a schedule's local rendering of its next fire, for the
  // operator API; never used in fire decisions.
  localNextFire(schedule_id: string): { readonly next_fire_at: string; readonly local: string; readonly zone: string } {
    const row = this.getRow(schedule_id);
    const wc = wallClock(Date.parse(row.next_fire_at), row.zone);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return {
      next_fire_at: row.next_fire_at,
      local: `${wc.year}-${pad(wc.month)}-${pad(wc.day)} ${pad(wc.hour)}:${pad(wc.minute)}`,
      zone: row.zone,
    };
  }
}
