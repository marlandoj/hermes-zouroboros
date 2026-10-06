export type ScheduleExpressionType = "cron" | "interval";

export type OverlapPolicy = "skip" | "allow";

export interface ScheduleRecord {
  readonly schedule_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly expression_type: ScheduleExpressionType;
  readonly expression: string;
  readonly zone: string;
  readonly anchor_at: string;
  readonly next_fire_at: string;
  readonly paused: boolean;
  readonly overlap_policy: OverlapPolicy;
  readonly catch_up_limit: number;
  readonly retry_max_attempts: number;
  readonly retry_backoff_ms: number;
  readonly requires_approval: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RegisterScheduleInput {
  readonly schedule_id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly expression_type: ScheduleExpressionType;
  readonly expression: string;
  readonly zone?: string;
  readonly overlap_policy?: OverlapPolicy;
  readonly catch_up_limit?: number;
  readonly retry_max_attempts?: number;
  readonly retry_backoff_ms?: number;
  readonly requires_approval?: boolean;
  readonly actor: string;
}

// Every scheduling decision and schedule mutation lands as one immutable,
// hash-chained evidence row. "fired" may describe an original occurrence or a
// retry (detail.retry_n > 0); the remaining run kinds are terminal decisions
// about one occurrence.
export type ScheduleRunKind =
  | "registered"
  | "paused"
  | "resumed"
  | "removed"
  | "fired"
  | "skipped_overlap"
  | "missed"
  | "retry_scheduled"
  | "exhausted_retries";

export interface ScheduleRunRow {
  readonly seq: number;
  readonly run_id: string;
  readonly schedule_id: string;
  readonly kind: ScheduleRunKind;
  readonly fire_at: string | null;
  readonly task_id: string | null;
  readonly actor: string;
  readonly detail_json: string;
  readonly occurred_at: string;
  readonly prev_hash: string | null;
  readonly event_hash: string;
}

export interface TickReport {
  readonly failed: number;
  readonly fired: number;
  readonly skipped_overlap: number;
  readonly missed: number;
  readonly retries_fired: number;
  readonly retries_scheduled: number;
  readonly exhausted: number;
}

export interface ScheduleFault {
  readonly schedule_id: string;
  readonly reason: string;
  readonly error: string;
  readonly occurred_at: string;
}

// `degraded` is the durable starvation signal: at least one schedule is wedged
// at its current occurrence and will not advance without operator action.
// `last_tick_error` is the most recent recorded fault of any kind, including
// transient ones that have since cleared, and so is reported independently.
export interface SchedulerStats {
  readonly schedules: number;
  readonly paused: number;
  readonly pending_retries: number;
  readonly next_fire_at: string | null;
  readonly evidence_rows: number;
  readonly degraded: boolean;
  readonly failing_schedules: number;
  readonly last_tick_error: ScheduleFault | null;
}
