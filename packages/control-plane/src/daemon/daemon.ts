import type { GovernanceEvidence, GovernanceVerifier, TaskRecord } from "../contracts.js";
import { ControlPlaneError } from "../contracts.js";
import { DurableTaskQueue } from "../queue/task-queue.js";
import type { ExecutorRegistry } from "../dispatch/executor-port.js";
import type { DurableScheduleStore } from "../scheduler/schedule-store.js";
import type { SchedulerStats } from "../scheduler/contracts.js";

export interface DaemonOptions {
  readonly queue: DurableTaskQueue;
  readonly executors: ExecutorRegistry;
  readonly governance: GovernanceVerifier;
  readonly schedules?: DurableScheduleStore;
  readonly workerCount?: number;
  readonly pollMs?: number;
  readonly reclaimMs?: number;
  readonly heartbeatMs?: number;
  readonly scheduleTickMs?: number;
  readonly onTaskSettled?: (task: TaskRecord) => void;
}

export interface DaemonHealth {
  readonly running: boolean;
  readonly started_at: string | null;
  readonly workers: number;
  readonly queue: ReturnType<DurableTaskQueue["stats"]>;
  readonly adapters: readonly { kind: string; executor: string }[];
  readonly policy: { readonly lifecycle: "fail_closed"; readonly dispatch: "lease_required" };
  readonly evidence: GovernanceEvidence | null;
  readonly scheduler: SchedulerStats | null;
  readonly schedule_bootstrap_error: string | null;
  readonly schedule_tick_error: string | null;
}

export class ControlPlaneDaemon {
  private readonly queue: DurableTaskQueue;
  private readonly executors: ExecutorRegistry;
  private readonly governance: GovernanceVerifier;
  private readonly schedules: DurableScheduleStore | null;
  private readonly workerCount: number;
  private readonly pollMs: number;
  private readonly reclaimMs: number;
  private readonly heartbeatMs: number;
  private readonly scheduleTickMs: number;
  private readonly onTaskSettled?: (task: TaskRecord) => void;
  private evidence: GovernanceEvidence | null = null;
  private scheduleBootstrapError: string | null = null;
  private scheduleTickError: string | null = null;
  private startedAt: string | null = null;
  private running = false;
  private stopRequested = false;
  private workerLoops: Promise<void>[] = [];
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DaemonOptions) {
    this.queue = options.queue;
    this.executors = options.executors;
    this.governance = options.governance;
    this.schedules = options.schedules ?? null;
    this.workerCount = Math.max(1, options.workerCount ?? 1);
    this.pollMs = options.pollMs ?? 250;
    this.reclaimMs = options.reclaimMs ?? 5_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.scheduleTickMs = options.scheduleTickMs ?? 1_000;
    this.onTaskSettled = options.onTaskSettled;
  }

  async start(): Promise<GovernanceEvidence> {
    if (this.running) throw new ControlPlaneError("already_running", "daemon already started");
    let evidence: GovernanceEvidence;
    try {
      evidence = await this.governance.verify();
    } catch (error) {
      throw new ControlPlaneError(
        "governance_unverifiable",
        `governance evidence unavailable; refusing to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!evidence.ok) {
      throw new ControlPlaneError(
        "governance_unverifiable",
        `governance evidence failed verification; refusing to start: ${evidence.reasons.join("; ")}`,
      );
    }
    this.evidence = evidence;
    this.running = true;
    this.stopRequested = false;
    this.startedAt = new Date().toISOString();
    this.queue.recoverExpiredLeases();
    this.reclaimTimer = setInterval(() => {
      try {
        this.queue.recoverExpiredLeases();
      } catch {
        // reclaim retries on next tick; queue integrity is transaction-guarded
      }
    }, this.reclaimMs);
    // Worker loops spawn before the scheduler bootstrap. The scheduler is an
    // optional add-on; queue dispatch is not. Starting dispatch first means no
    // scheduler fault can take pre-existing queue processing down with it.
    for (let index = 0; index < this.workerCount; index++) {
      this.workerLoops.push(this.workerLoop(`worker-${index + 1}`));
    }
    this.scheduleBootstrapError = null;
    this.scheduleTickError = null;
    if (this.schedules) {
      // Recovery tick before the loop: schedules recovered purely from the
      // durable store fire (or record missed/skip decisions) immediately on
      // restart rather than waiting one interval. A failure here is recorded
      // and surfaced through health() rather than swallowed or allowed to
      // abandon the daemon half-started.
      const store = this.schedules;
      try {
        store.tick();
      } catch (error) {
        this.scheduleBootstrapError = error instanceof Error ? error.message : String(error);
      }
      this.scheduleTimer = setInterval(() => {
        try {
          store.tick();
          this.scheduleTickError = null;
        } catch (error) {
          // a failed tick fires nothing (evidence-first, transaction-guarded);
          // the next tick re-derives due work from the durable store, and the
          // reason stays visible on health() until one succeeds
          this.scheduleTickError = error instanceof Error ? error.message : String(error);
        }
      }, this.scheduleTickMs);
    }
    return evidence;
  }

  private async workerLoop(worker_id: string): Promise<void> {
    while (!this.stopRequested) {
      let claimed;
      try {
        claimed = this.queue.claim(worker_id);
      } catch {
        claimed = null;
      }
      if (!claimed) {
        await Bun.sleep(this.pollMs);
        continue;
      }
      await this.runClaimed(worker_id, claimed.task.task_id, claimed.lease.lease_id, claimed.task);
    }
  }

  private async runClaimed(worker_id: string, task_id: string, lease_id: string, task: TaskRecord): Promise<void> {
    const executor = this.executors.resolve(task.kind);
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      if (!executor) {
        // Pre-dispatch: nothing executed, so fail() is exact here. In the
        // catch below no such certainty exists — a throw before any effect is
        // indistinguishable from a throw after one, and over-reporting the
        // ambiguous case as outcome_unknown is the safe direction.
        const settled = this.queue.fail(task_id, lease_id, worker_id, `no executor registered for kind ${task.kind}`);
        this.onTaskSettled?.(settled);
        return;
      }
      heartbeat = setInterval(() => {
        try {
          this.queue.heartbeat(task_id, lease_id);
        } catch {
          // an expired or superseded lease fails closed at completion time
        }
      }, this.heartbeatMs);
      const outcome = await executor.execute(task);
      const current = this.queue.get(task_id);
      const canceling = current.cancel_requested && current.state === "applying";
      let settled;
      if (outcome.status === "applied") {
        // The executor already committed its effect. A cancel that arrived
        // during execution cannot unmake that, so the result is persisted and
        // the task settles as applied — the truth — with the unhonored cancel
        // recorded in the audit payload rather than overwriting the outcome.
        settled = this.queue.complete(
          task_id,
          lease_id,
          worker_id,
          outcome.result_json ?? null,
          canceling ? { cancel_requested_during_apply: true, cancel_honored: false } : undefined,
        );
      } else if (canceling) {
        settled = this.queue.failUnderCancel(
          task_id,
          lease_id,
          worker_id,
          outcome.error ?? "executor reported failure",
        );
      } else {
        settled = this.queue.fail(task_id, lease_id, worker_id, outcome.error ?? "executor reported failure");
      }
      this.onTaskSettled?.(settled);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        // A throw leaves the effect ambiguous. While a retry remains in
        // budget the contract re-runs the task and idempotency converges it,
        // so failed_retryable is correct; when nothing will re-run — a cancel
        // pending OR the attempt budget spent — the ambiguity is durable and
        // must be surfaced as outcome_unknown for operator reconciliation.
        const current = this.queue.get(task_id);
        const unrecoverable =
          current.state === "applying" &&
          (current.cancel_requested || current.attempts >= current.max_attempts);
        const settled = unrecoverable
          ? this.queue.settleOutcomeUnknown(task_id, worker_id, reason, lease_id)
          : this.queue.fail(task_id, lease_id, worker_id, reason);
        this.onTaskSettled?.(settled);
      } catch {
        // lease lost; recovery reclaims the task without duplicate settlement
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.reclaimTimer = null;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
    await Promise.all(this.workerLoops);
    this.workerLoops = [];
    this.running = false;
  }

  health(): DaemonHealth {
    return {
      running: this.running,
      started_at: this.startedAt,
      workers: this.workerCount,
      queue: this.queue.stats(),
      adapters: this.executors.status(),
      policy: { lifecycle: "fail_closed", dispatch: "lease_required" },
      evidence: this.evidence,
      scheduler: this.schedules?.stats() ?? null,
      schedule_bootstrap_error: this.scheduleBootstrapError,
      schedule_tick_error: this.scheduleTickError,
    };
  }
}
