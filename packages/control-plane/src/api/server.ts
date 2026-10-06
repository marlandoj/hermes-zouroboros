import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import { ControlPlaneError } from "../contracts.js";
import type { DurableTaskQueue } from "../queue/task-queue.js";
import type { ControlPlaneDaemon } from "../daemon/daemon.js";
import type { DurableScheduleStore } from "../scheduler/schedule-store.js";
import type { OverlapPolicy, ScheduleExpressionType } from "../scheduler/contracts.js";
import { listAudit, verifyAuditChain } from "../audit/audit-log.js";

export interface OperatorApiOptions {
  readonly queue: DurableTaskQueue;
  readonly daemon: ControlPlaneDaemon;
  readonly schedules?: DurableScheduleStore;
  readonly token: string;
  readonly port?: number;
  readonly hostname?: string;
}

const MIN_TOKEN_LENGTH = 16;

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface EnqueueBody {
  readonly kind?: string;
  readonly payload?: unknown;
  readonly idempotency_scope?: string;
  readonly idempotency_key?: string;
  readonly max_attempts?: number;
  readonly requires_approval?: boolean;
}

interface RegisterScheduleBody {
  readonly schedule_id?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly expression_type?: ScheduleExpressionType;
  readonly expression?: string;
  readonly zone?: string;
  readonly overlap_policy?: OverlapPolicy;
  readonly catch_up_limit?: number;
  readonly retry_max_attempts?: number;
  readonly retry_backoff_ms?: number;
  readonly requires_approval?: boolean;
}

export function startOperatorApi(options: OperatorApiOptions): Server<unknown> {
  const token = options.token;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new ControlPlaneError(
      "auth_unconfigured",
      `operator API refuses to start without a bearer token of at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const { queue, daemon, schedules } = options;

  function authorize(request: Request): string | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    if (!constantTimeEqual(header.slice(7), token)) return null;
    return "operator";
  }

  async function handle(request: Request): Promise<Response> {
    const actor = authorize(request);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ...daemon.health(), audit_chain: verifyAuditChain(queue.db) });
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        const state = url.searchParams.get("state");
        return json({ tasks: queue.list((state as never) ?? undefined) });
      }
      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = (await request.json()) as EnqueueBody;
        if (!body.kind || !body.idempotency_scope || !body.idempotency_key || body.payload === undefined) {
          return json({ error: "kind, payload, idempotency_scope, idempotency_key are required" }, 400);
        }
        const result = queue.enqueue({
          kind: body.kind,
          payload_json: JSON.stringify(body.payload),
          idempotency_scope: body.idempotency_scope,
          idempotency_key: body.idempotency_key,
          max_attempts: body.max_attempts,
          requires_approval: body.requires_approval,
          actor,
        });
        if (result.outcome === "idempotency_conflict") {
          return json({ outcome: result.outcome, existing: result.existing }, 409);
        }
        return json(result, result.outcome === "enqueued" ? 201 : 200);
      }
      if (segments[0] === "tasks" && segments.length === 2 && request.method === "GET") {
        const task = queue.get(segments[1]);
        return json({ task, audit: listAudit(queue.db, task.task_id) });
      }
      if (segments[0] === "tasks" && segments.length === 3 && request.method === "POST") {
        const task_id = segments[1];
        const action = segments[2];
        if (action === "approve") return json({ task: queue.approve(task_id, actor) });
        if (action === "reject") {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          return json({ task: queue.reject(task_id, actor, body.reason ?? "rejected by operator") });
        }
        if (action === "cancel") return json({ task: queue.cancel(task_id, actor) });
        if (action === "replay") {
          const body = (await request.json().catch(() => ({}))) as { payload_digest?: string };
          if (!body.payload_digest) {
            return json({ error: "replay requires the expected payload_digest" }, 400);
          }
          const replayed = queue.replay(task_id, actor, body.payload_digest);
          return json({ task: replayed.task, superseded_task_id: replayed.superseded_task_id });
        }
        if (action === "reconcile") {
          const body = (await request.json().catch(() => ({}))) as {
            disposition?: string;
            result_json?: string;
          };
          if (body.disposition !== "applied" && body.disposition !== "not_applied") {
            return json({ error: "reconcile requires disposition 'applied' or 'not_applied'" }, 400);
          }
          return json({
            task: queue.reconcile(task_id, actor, body.disposition, body.result_json ?? null),
          });
        }
        if (action === "rollback") {
          const body = (await request.json().catch(() => ({}))) as { reason?: string };
          return json({ task: queue.rollback(task_id, actor, body.reason ?? "operator rollback") });
        }
      }
      if (request.method === "POST" && url.pathname === "/queue/pause") {
        queue.pause(actor);
        return json({ paused: true });
      }
      if (request.method === "POST" && url.pathname === "/queue/resume") {
        queue.resume(actor);
        return json({ paused: false });
      }
      if (request.method === "GET" && url.pathname === "/audit") {
        return json({ chain: verifyAuditChain(queue.db), events: listAudit(queue.db) });
      }
      if (schedules && segments[0] === "schedules") {
        if (request.method === "GET" && segments.length === 1) {
          return json({ schedules: schedules.list(), chain: schedules.verifyRunChain() });
        }
        if (request.method === "POST" && segments.length === 1) {
          const body = (await request.json()) as RegisterScheduleBody;
          if (
            !body.schedule_id ||
            !body.kind ||
            body.payload === undefined ||
            !body.expression_type ||
            !body.expression
          ) {
            return json(
              { error: "schedule_id, kind, payload, expression_type, expression are required" },
              400,
            );
          }
          const schedule = schedules.register({
            schedule_id: body.schedule_id,
            kind: body.kind,
            payload_json: JSON.stringify(body.payload),
            expression_type: body.expression_type,
            expression: body.expression,
            zone: body.zone,
            overlap_policy: body.overlap_policy,
            catch_up_limit: body.catch_up_limit,
            retry_max_attempts: body.retry_max_attempts,
            retry_backoff_ms: body.retry_backoff_ms,
            requires_approval: body.requires_approval,
            actor,
          });
          return json({ schedule }, 201);
        }
        if (segments.length === 2 && request.method === "GET") {
          const schedule = schedules.get(segments[1]);
          return json({
            schedule,
            next_fire: schedules.localNextFire(segments[1]),
            runs: schedules.runs(segments[1]),
          });
        }
        if (segments.length === 2 && request.method === "DELETE") {
          schedules.remove(segments[1], actor);
          return json({ removed: true });
        }
        if (segments.length === 3 && request.method === "POST") {
          if (segments[2] === "pause") return json({ schedule: schedules.pause(segments[1], actor) });
          if (segments[2] === "resume") return json({ schedule: schedules.resume(segments[1], actor) });
        }
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        const status =
          error.code === "task_not_found" || error.code === "schedule_not_found"
            ? 404
            : error.code === "schedule_invalid"
              ? 400
              : error.code === "idempotency_mismatch" ||
                  error.code === "invalid_transition" ||
                  error.code === "schedule_exists"
                ? 409
                : error.code === "lease_invalid" || error.code === "lease_expired"
                  ? 423
                  : 500;
        return json({ error: error.code, message: error.message }, status);
      }
      return json({ error: "internal", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: handle,
  });
}
