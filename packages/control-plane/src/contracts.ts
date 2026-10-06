import type { ActionState } from "@zouroboros/capability-runtime";

export type TaskState = Extract<
  ActionState,
  | "staged"
  | "awaiting_approval"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "canceled"
  | "failed_retryable"
  | "outcome_unknown"
  | "reconciled"
  | "compensated"
>;

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "applied",
  "rejected",
  "canceled",
  "reconciled",
  "compensated",
]);

// States a task may occupy before dispatch. Cancellation is legal only from
// these, mirroring canCancel(from, "not_dispatched") in the canonical policy.
export const PRE_DISPATCH_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "staged",
  "awaiting_approval",
  "approved",
]);

// The confirmed real-world disposition of an outcome_unknown task, supplied by
// the operator when reconciling.
export type ReconcileDisposition = "applied" | "not_applied";

export function isTerminalTaskState(task: Pick<TaskRecord, "state" | "exhausted">): boolean {
  return TERMINAL_TASK_STATES.has(task.state) || (task.state === "failed_retryable" && task.exhausted);
}

export interface TaskRecord {
  readonly task_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly payload_digest: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly state: TaskState;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly requires_approval: boolean;
  readonly exhausted: boolean;
  readonly cancel_requested: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_error: string | null;
  readonly result_json: string | null;
}

export interface LeaseRecord {
  readonly lease_id: string;
  readonly task_id: string;
  readonly worker_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

export interface ClaimedTask {
  readonly task: TaskRecord;
  readonly lease: LeaseRecord;
}

export interface EnqueueInput {
  readonly kind: string;
  readonly payload_json: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly max_attempts?: number;
  readonly requires_approval?: boolean;
  readonly actor: string;
}

export type EnqueueResult =
  | { readonly outcome: "enqueued"; readonly task: TaskRecord }
  | { readonly outcome: "existing"; readonly task: TaskRecord }
  | { readonly outcome: "idempotency_conflict"; readonly existing: TaskRecord };

export interface GovernanceEvidence {
  readonly ok: boolean;
  readonly evidence_digest: string;
  readonly verified_at: string;
  readonly reasons: readonly string[];
}

export interface GovernanceVerifier {
  verify(): Promise<GovernanceEvidence>;
}

export interface ExecutionOutcome {
  readonly status: "applied" | "failed_retryable";
  readonly result_json?: string;
  readonly error?: string;
}

export interface ReplayResult {
  readonly task: TaskRecord;
  readonly superseded_task_id: string | null;
}

export interface ExecutorPort {
  readonly name: string;
  execute(task: TaskRecord): Promise<ExecutionOutcome>;
}

export class ControlPlaneError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ControlPlaneError";
  }
}
