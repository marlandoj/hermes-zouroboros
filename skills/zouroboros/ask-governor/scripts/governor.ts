#!/usr/bin/env bun
/**
 * Provider-agnostic governor for one-shot model calls.
 *
 * hermes-zouroboros: replaces the source workspace's Zo Ask governor. Upstream calls go through
 * integration/ask.ts (the profile's executor registry, default hermes-vps), so the governor holds
 * no credential and no endpoint. Concurrency, queueing, named budgets, deduplication, the circuit
 * breaker, bounded full-jitter retries and redacted telemetry are unchanged.
 */
import { mkdirSync, renameSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ask, TRANSIENT_FAILURES, type AskFailure, type AskOutcome, type AskRequest } from "../../../../integration/ask.ts";
import { paths } from "../../../../integration/profile.ts";

export interface AskPayload {
  input: string;
  /** Empty means the Hermes profile's configured model. */
  model?: string;
  provider?: string;
  executor?: string;
  workdir?: string;
}

export interface RequestPolicy {
  caller: string;
  priority?: number;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  maxAttempts?: number;
  budgetKey?: string;
  budgetLimit?: number;
  budgetWindowMs?: number;
  dedupeKey?: string;
}

export interface GovernedRequest {
  payload: AskPayload;
  policy: RequestPolicy;
}

export interface GovernedResult {
  output: string;
  model: string;
  attempts: number;
  request_id: string;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface BudgetState {
  startedAt: number;
  count: number;
  limit: number;
  windowMs: number;
}

export interface CircuitSnapshot {
  consecutiveFailures: number;
  openUntil: number;
}

interface QueueEntry {
  id: string;
  seq: number;
  enqueuedAt: number;
  deadlineAt: number;
  request: GovernedRequest;
  resolve: (value: GovernedResult) => void;
  reject: (reason: unknown) => void;
}

export interface GovernorTelemetry {
  ts: string;
  event: string;
  request_id?: string;
  caller?: string;
  duration_ms?: number;
  queue_ms?: number;
  attempts?: number;
  error_class?: string;
  circuit_state: CircuitState;
  budget_key?: string;
}

/** Upstream call: one attempt, bounded by timeoutMs. Must not throw for model failures. */
export type Invoke = (request: AskRequest) => Promise<AskOutcome>;

export interface GovernorOptions {
  invoke?: Invoke;
  concurrency?: number;
  queueCapacity?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  telemetry?: (event: GovernorTelemetry) => void;
  persistBudgets?: (budgets: Record<string, BudgetState>) => void;
  initialBudgets?: Record<string, BudgetState>;
  persistCircuit?: (circuit: CircuitSnapshot) => void;
  initialCircuit?: CircuitSnapshot;
}

export class GovernorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly upstreamFailure?: string,
  ) {
    super(message);
    this.name = "GovernorError";
  }
}

/** Local status and code for each failure class from integration/ask.ts. */
const FAILURE_STATUS: Record<string, [number, string]> = {
  usage: [400, "upstream_usage"],
  unavailable: [503, "executor_unavailable"],
  timeout: [504, "upstream_timeout"],
  interrupted: [503, "upstream_interrupted"],
  failed: [502, "upstream_error"],
  // Expected and quiet: never retried and never counted toward the circuit breaker.
  unfunded: [402, "upstream_unfunded"],
};

export class AskGovernor {
  private readonly invoke: Invoke;
  private readonly concurrency: number;
  private readonly queueCapacity: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly emit: (event: GovernorTelemetry) => void;
  private readonly persistBudgets?: (budgets: Record<string, BudgetState>) => void;
  private readonly persistCircuit?: (circuit: CircuitSnapshot) => void;
  private queue: QueueEntry[] = [];
  private inFlight = 0;
  private seq = 0;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenInFlight = false;
  private readonly dedupe = new Map<string, Promise<GovernedResult>>();
  private readonly budgets = new Map<string, BudgetState>();
  private readonly metrics = {
    accepted: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    rejected: 0,
    coalesced: 0,
  };

  constructor(options: GovernorOptions = {}) {
    this.invoke = options.invoke ?? ask;
    this.concurrency = options.concurrency ?? 2;
    this.queueCapacity = options.queueCapacity ?? 100;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? Bun.sleep;
    this.emit = options.telemetry ?? (() => {});
    this.persistBudgets = options.persistBudgets;
    this.persistCircuit = options.persistCircuit;
    if (options.initialCircuit) {
      this.consecutiveFailures = Math.max(0, Math.floor(options.initialCircuit.consecutiveFailures));
      this.openUntil = Math.max(0, Math.floor(options.initialCircuit.openUntil));
    }
    for (const [key, value] of Object.entries(options.initialBudgets ?? {})) this.budgets.set(key, value);
  }

  health() {
    return {
      ok: this.circuitState() !== "open",
      circuit: this.circuitState(),
      in_flight: this.inFlight,
      concurrency: this.concurrency,
      queued: this.queue.length,
      queue_capacity: this.queueCapacity,
      metrics: { ...this.metrics },
      budgets: Object.fromEntries(
        [...this.budgets.entries()].map(([key, value]) => [key, {
          count: value.count,
          limit: value.limit,
          remaining: Math.max(0, value.limit - value.count),
          resets_at: new Date(value.startedAt + value.windowMs).toISOString(),
        }]),
      ),
    };
  }

  submit(request: GovernedRequest): Promise<GovernedResult> {
    this.validate(request);
    const dedupeKey = request.policy.dedupeKey;
    if (dedupeKey && this.dedupe.has(dedupeKey)) {
      this.metrics.coalesced++;
      return this.dedupe.get(dedupeKey)!;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.metrics.rejected++;
      throw new GovernorError("Ask governor queue is full", 503, "queue_full");
    }
    const promise = new Promise<GovernedResult>((resolve, reject) => {
      const now = this.now();
      this.queue.push({
        id: randomUUID(),
        seq: this.seq++,
        enqueuedAt: now,
        deadlineAt: now + (request.policy.queueTimeoutMs ?? 30_000),
        request,
        resolve,
        reject,
      });
      this.metrics.accepted++;
      this.queue.sort((a, b) => (b.request.policy.priority ?? 5) - (a.request.policy.priority ?? 5) || a.seq - b.seq);
      this.drain();
    });
    if (dedupeKey) {
      this.dedupe.set(dedupeKey, promise);
      void promise.finally(() => this.dedupe.delete(dedupeKey)).catch(() => {});
    }
    return promise;
  }

  private validate(request: GovernedRequest) {
    if (!request || typeof request !== "object" || !request.payload || !request.policy) {
      throw new GovernorError("Invalid governed request", 400, "invalid_request");
    }
    if (typeof request.payload.input !== "string" || !request.payload.input.trim()) {
      throw new GovernorError("Ask input must be non-empty", 400, "invalid_input");
    }
    if (!request.policy.caller?.trim()) {
      throw new GovernorError("A caller name is required", 400, "invalid_caller");
    }
    if (request.payload.provider && !request.payload.model) {
      throw new GovernorError("A provider override requires a model", 400, "invalid_provider");
    }
    const attempts = request.policy.maxAttempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
      throw new GovernorError("maxAttempts must be between 1 and 5", 400, "invalid_attempts");
    }
  }

  private drain() {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (this.now() >= entry.deadlineAt) {
        this.metrics.rejected++;
        entry.reject(new GovernorError("Ask request expired in queue", 504, "queue_timeout"));
        continue;
      }
      if (!this.canPassCircuit()) {
        this.metrics.rejected++;
        entry.reject(new GovernorError("Ask circuit is open", 503, "circuit_open"));
        continue;
      }
      this.inFlight++;
      void this.execute(entry)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.inFlight--;
          if (this.halfOpenInFlight) this.halfOpenInFlight = false;
          this.drain();
        });
    }
  }

  private circuitState(): CircuitState {
    if (this.openUntil === 0) return "closed";
    if (this.now() < this.openUntil) return "open";
    return "half-open";
  }

  private canPassCircuit(): boolean {
    const state = this.circuitState();
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.halfOpenInFlight) return false;
    this.halfOpenInFlight = true;
    return true;
  }

  private recordSuccess() {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenInFlight = false;
    this.saveCircuit();
  }

  private recordFailure(retryable: boolean) {
    if (!retryable) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold || this.circuitState() === "half-open") {
      this.openUntil = this.now() + this.cooldownMs;
    }
    this.saveCircuit();
  }

  private saveCircuit() {
    this.persistCircuit?.({ consecutiveFailures: this.consecutiveFailures, openUntil: this.openUntil });
  }

  private consumeBudget(policy: RequestPolicy) {
    const key = policy.budgetKey ?? policy.caller;
    const limit = policy.budgetLimit ?? 100;
    const windowMs = policy.budgetWindowMs ?? 86_400_000;
    const now = this.now();
    let state = this.budgets.get(key);
    if (!state || now >= state.startedAt + state.windowMs || state.limit !== limit || state.windowMs !== windowMs) {
      state = { startedAt: now, count: 0, limit, windowMs };
    }
    if (state.count >= state.limit) {
      throw new GovernorError(`Ask budget exhausted for ${key}`, 429, "budget_exhausted");
    }
    state.count++;
    this.budgets.set(key, state);
    this.persistBudgets?.(Object.fromEntries(this.budgets));
    return key;
  }

  private async execute(entry: QueueEntry): Promise<GovernedResult> {
    const startedAt = this.now();
    const policy = entry.request.policy;
    const payload = entry.request.payload;
    const maxAttempts = policy.maxAttempts ?? 3;
    const timeoutMs = policy.timeoutMs ?? 120_000;
    let attempts = 0;
    let lastError: GovernorError | undefined;
    let budgetKey = policy.budgetKey ?? policy.caller;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        budgetKey = this.consumeBudget(policy);
        const remainingMs = timeoutMs - (this.now() - startedAt);
        if (remainingMs <= 0) throw new GovernorError("Ask request deadline exceeded", 504, "request_timeout");
        const outcome = await this.invoke({
          prompt: payload.input, model: payload.model || undefined, provider: payload.provider,
          executor: payload.executor, workdir: payload.workdir, timeoutSec: Math.ceil(remainingMs / 1000),
        });
        if (!outcome.ok) {
          const failure = outcome.failure ?? "failed";
          const [status, code] = FAILURE_STATUS[failure] ?? [502, "upstream_error"];
          throw new GovernorError(`Ask ${failure}${outcome.detail ? `: ${outcome.detail.slice(0, 300)}` : ""}`, status, code, failure);
        }
        this.recordSuccess();
        this.metrics.completed++;
        this.emit({
          ts: new Date(this.now()).toISOString(),
          event: "completed",
          request_id: entry.id,
          caller: policy.caller,
          duration_ms: this.now() - startedAt,
          queue_ms: startedAt - entry.enqueuedAt,
          attempts,
          circuit_state: this.circuitState(),
          budget_key: budgetKey,
        });
        return { output: outcome.output, model: outcome.model, attempts, request_id: entry.id };
      } catch (error) {
        const governed = error instanceof GovernorError
          ? error
          : new GovernorError(error instanceof Error ? error.message : String(error), 503, "unknown_error", "failed");
        lastError = governed;
        const retryable = governed.upstreamFailure !== undefined
          && TRANSIENT_FAILURES.has(governed.upstreamFailure as AskFailure);
        this.recordFailure(retryable);
        if (!retryable || attempts >= maxAttempts || this.circuitState() === "open") break;
        this.metrics.retried++;
        const cap = Math.min(30_000, 1_000 * 2 ** (attempts - 1));
        await this.sleep(Math.floor(this.random() * cap));
      }
    }

    this.metrics.failed++;
    this.emit({
      ts: new Date(this.now()).toISOString(),
      event: "failed",
      request_id: entry.id,
      caller: policy.caller,
      duration_ms: this.now() - startedAt,
      queue_ms: startedAt - entry.enqueuedAt,
      attempts,
      error_class: lastError?.code ?? "unknown_error",
      circuit_state: this.circuitState(),
      budget_key: budgetKey,
    });
    throw lastError ?? new GovernorError("Ask failed", 503, "unknown_error");
  }
}

/** Governor state lives in the profile's state directory, never in the skill tree. */
export function stateDir(): string {
  return process.env.ZOUROBOROS_ASK_GOVERNOR_STATE_DIR
    || join(process.env.ZOUROBOROS_STATE_DIR || join(paths().data, "state"), "ask-governor");
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function loadCircuit(path: string): CircuitSnapshot {
  const parsed = readJson<Partial<CircuitSnapshot>>(path, {});
  return {
    consecutiveFailures: Number.isFinite(parsed.consecutiveFailures) ? Number(parsed.consecutiveFailures) : 0,
    openUntil: Number.isFinite(parsed.openUntil) ? Number(parsed.openUntil) : 0,
  };
}

/** A governor whose budgets, circuit and redacted telemetry persist under stateDir(). */
export function persistentGovernor(options: GovernorOptions = {}): AskGovernor {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const budgetPath = join(dir, "budgets.json");
  const circuitPath = join(dir, "circuit.json");
  const telemetryPath = join(dir, "events.ndjson");
  return new AskGovernor({
    concurrency: Number(process.env.ZOUROBOROS_ASK_GOVERNOR_CONCURRENCY ?? 2),
    queueCapacity: Number(process.env.ZOUROBOROS_ASK_GOVERNOR_QUEUE_CAPACITY ?? 100),
    failureThreshold: Number(process.env.ZOUROBOROS_ASK_GOVERNOR_FAILURE_THRESHOLD ?? 5),
    cooldownMs: Number(process.env.ZOUROBOROS_ASK_GOVERNOR_COOLDOWN_MS ?? 60_000),
    initialBudgets: readJson<Record<string, BudgetState>>(budgetPath, {}),
    initialCircuit: loadCircuit(circuitPath),
    persistBudgets: (budgets) => atomicJson(budgetPath, budgets),
    persistCircuit: (circuit) => atomicJson(circuitPath, circuit),
    telemetry: (event) => appendFileSync(telemetryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
    ...options,
  });
}

/** Optional host-local service so several processes share one concurrency limit. */
export function startServer() {
  const governor = persistentGovernor();
  const port = Number(process.env.ZOUROBOROS_ASK_GOVERNOR_PORT ?? 7821);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json(governor.health(), { status: 200 });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/ask") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      try {
        const governed = await governor.submit(await request.json() as GovernedRequest);
        return Response.json(governed, { status: 200 });
      } catch (error) {
        const governed = error instanceof GovernorError
          ? error
          : new GovernorError(error instanceof Error ? error.message : String(error), 500, "internal_error");
        return Response.json({ error: governed.message, code: governed.code }, { status: governed.status });
      }
    },
  });
}

if (import.meta.main) {
  const command = process.argv[2] ?? "help";
  if (command === "serve") {
    const server = startServer();
    console.log(JSON.stringify({ event: "ask_governor_started", host: server.hostname, port: server.port }));
  } else if (command === "health") {
    console.log(JSON.stringify(persistentGovernor().health(), null, 2));
  } else if (command === "where") {
    console.log(stateDir());
  } else {
    console.log("ask-governor\n  serve    host-local service on 127.0.0.1 (ZOUROBOROS_ASK_GOVERNOR_PORT, default 7821)\n  health   persisted circuit and budget state\n  where    state directory");
    if (!["help", "--help", "-h"].includes(command)) process.exitCode = 2;
  }
}
