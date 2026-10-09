import { persistentGovernor, type AskGovernor, type AskPayload, type GovernedRequest, type GovernedResult, type RequestPolicy } from "./governor.ts";

export interface AskClientOptions extends Partial<RequestPolicy> {
  caller: string;
  /** Service URL; defaults to ZOUROBOROS_ASK_GOVERNOR_URL. Unset means an in-process governor. */
  governorUrl?: string;
  fetchImpl?: typeof fetch;
  /** In-process governor override (tests). */
  governor?: AskGovernor;
}

let shared: AskGovernor | undefined;

/**
 * Governed one-shot model call. With a governor service configured, the call goes to that
 * service and fails closed if it is unreachable; there is no silent fallback to an ungoverned
 * path. Without one, an in-process governor applies the same policy, with budgets and circuit
 * state persisted in the profile's state directory.
 */
export async function governedAsk(payload: AskPayload, options: AskClientOptions): Promise<GovernedResult> {
  const policy: RequestPolicy = {
    caller: options.caller,
    priority: options.priority,
    timeoutMs: options.timeoutMs,
    queueTimeoutMs: options.queueTimeoutMs,
    maxAttempts: options.maxAttempts,
    budgetKey: options.budgetKey,
    budgetLimit: options.budgetLimit,
    budgetWindowMs: options.budgetWindowMs,
    dedupeKey: options.dedupeKey,
  };
  const request: GovernedRequest = { payload, policy };
  const url = options.governorUrl ?? process.env.ZOUROBOROS_ASK_GOVERNOR_URL;
  if (!url) {
    const governor = options.governor ?? (shared ??= persistentGovernor());
    return governor.submit(request);
  }
  const timeoutMs = (options.timeoutMs ?? 120_000) + (options.queueTimeoutMs ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as GovernedResult & { error?: string; code?: string };
    if (!response.ok || body.error) throw new Error(`Ask governor ${body.code ?? response.status}: ${body.error ?? "request failed"}`);
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Ask governor timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
