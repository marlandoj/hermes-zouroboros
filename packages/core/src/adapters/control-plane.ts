/**
 * Scheduler adapter backed by the standalone control-plane operator API
 * (`@zouroboros/control-plane`). Where the bare-box fallback can only print
 * crontab instructions, this adapter registers a durable, timezone-aware
 * schedule in the control-plane store over HTTP — no compile-time coupling to
 * the control-plane package. It degrades like every adapter: registration
 * failure yields `scheduled: false` with instructions, never a throw.
 */

import type { ScheduleResult, Scheduler, ScheduleSpec } from './types.js';

export interface ControlPlaneSchedulerConfig {
  /** Base URL of the control-plane operator API, e.g. http://127.0.0.1:8600. */
  baseUrl: string;
  /** Operator API bearer token. */
  token: string;
  /**
   * IANA zone for cron interpretation; explicit UTC by default. The
   * control-plane rejects unknown zones at registration (fail closed).
   */
  zone?: string;
  /** Task kind the fired occurrences enqueue as. */
  taskKind?: string;
  /** Injected for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TASK_KIND = 'scheduled_command';

export class ControlPlaneScheduler implements Scheduler {
  readonly kind = 'control-plane' as const;
  private readonly config: ControlPlaneSchedulerConfig;

  constructor(config: ControlPlaneSchedulerConfig) {
    this.config = config;
  }

  async schedule(spec: ScheduleSpec): Promise<ScheduleResult> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    let expression_type: 'cron' | 'interval';
    let expression: string;
    if (spec.cron) {
      expression_type = 'cron';
      expression = spec.cron;
    } else if (spec.intervalMinutes && spec.intervalMinutes >= 1) {
      expression_type = 'interval';
      expression = String(Math.round(spec.intervalMinutes * 60_000));
    } else {
      return {
        scheduled: false,
        instructions: `Schedule "${spec.name}" has neither a cron expression nor an interval; nothing was registered.`,
      };
    }
    try {
      const response = await fetchImpl(`${this.config.baseUrl.replace(/\/$/, '')}/schedules`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schedule_id: spec.name,
          kind: this.config.taskKind ?? DEFAULT_TASK_KIND,
          payload: { command: spec.command },
          expression_type,
          expression,
          zone: this.config.zone ?? 'UTC',
        }),
      });
      if (response.ok) return { scheduled: true };
      if (response.status === 409) {
        // Already registered under this name: the durable store owns it.
        return { scheduled: true };
      }
      const body = await response.text().catch(() => '');
      return {
        scheduled: false,
        instructions: `Control-plane rejected schedule "${spec.name}" (HTTP ${response.status}): ${body}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        scheduled: false,
        instructions: `Control-plane unreachable for schedule "${spec.name}": ${reason}. Start the control-plane daemon and retry.`,
      };
    }
  }
}
