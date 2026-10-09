import { describe, expect, test } from "bun:test";
import type { AskFailure, AskOutcome, AskRequest } from "../../../../integration/ask.ts";
import { AskGovernor, GovernorError, type GovernorTelemetry, type GovernedRequest } from "./governor.ts";
import { governedAsk } from "./client.ts";

// Upstream calls are injected: no Hermes process, provider or credential is involved.
function ok(output = "ok"): AskOutcome {
  return { ok: true, output, exitCode: 0, ms: 1, model: "" };
}
function fail(failure: AskFailure): AskOutcome {
  return { ok: false, output: "", exitCode: failure === "timeout" ? 124 : 1, ms: 1, model: "", failure };
}

function request(overrides: Partial<GovernedRequest> = {}): GovernedRequest {
  return {
    payload: { input: "ping" },
    policy: { caller: "test", maxAttempts: 3, budgetLimit: 100 },
    ...overrides,
  };
}

describe("AskGovernor", () => {
  test("caps concurrent upstream calls at two", async () => {
    let active = 0;
    let maximum = 0;
    const governor = new AskGovernor({
      concurrency: 2,
      invoke: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Bun.sleep(10);
        active--;
        return ok();
      },
    });
    await Promise.all(Array.from({ length: 8 }, () => governor.submit(request())));
    expect(maximum).toBe(2);
  });

  test("uses full-jitter retry for transient failures", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const governor = new AskGovernor({
      random: () => 0.5,
      sleep: async (ms) => { sleeps.push(ms); },
      invoke: async () => ++calls === 1 ? fail("timeout") : ok(),
    });
    const result = await governor.submit(request());
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  test("never retries a permanent failure", async () => {
    for (const failure of ["usage", "unavailable", "interrupted"] as const) {
      let calls = 0;
      const governor = new AskGovernor({ invoke: async () => { calls++; return fail(failure); } });
      await expect(governor.submit(request())).rejects.toMatchObject({ upstreamFailure: failure });
      expect(calls).toBe(1);
    }
  });

  test("treats empty output reported by the ask layer as a failure", async () => {
    const governor = new AskGovernor({ invoke: async () => fail("failed") });
    await expect(governor.submit(request({ policy: { caller: "test", maxAttempts: 1 } }))).rejects.toBeInstanceOf(GovernorError);
  });

  test("an unfunded provider (402) is never retried and never opens the circuit", async () => {
    let calls = 0;
    const governor = new AskGovernor({ failureThreshold: 1, sleep: async () => {}, invoke: async () => { calls++; return fail("unfunded"); } });
    for (let i = 0; i < 3; i++) {
      await expect(governor.submit(request())).rejects.toMatchObject({ upstreamFailure: "unfunded", status: 402, code: "upstream_unfunded" });
    }
    expect(calls).toBe(3);
    expect(governor.health().circuit).toBe("closed");
  });

  test("opens the circuit after repeated transient failures", async () => {
    const governor = new AskGovernor({
      failureThreshold: 2,
      sleep: async () => {},
      invoke: async () => fail("failed"),
    });
    await expect(governor.submit(request({ policy: { caller: "test", maxAttempts: 2 } }))).rejects.toBeInstanceOf(GovernorError);
    expect(governor.health().circuit).toBe("open");
    await expect(governor.submit(request())).rejects.toMatchObject({ code: "circuit_open" });
  });

  test("persists an open circuit across service restarts", async () => {
    let snapshot = { consecutiveFailures: 0, openUntil: 0 };
    let now = 1_000;
    const first = new AskGovernor({
      now: () => now,
      failureThreshold: 1,
      cooldownMs: 60_000,
      persistCircuit: (value) => { snapshot = value; },
      invoke: async () => fail("failed"),
    });
    await expect(first.submit(request({ policy: { caller: "test", maxAttempts: 1 } }))).rejects.toBeInstanceOf(GovernorError);
    expect(snapshot.openUntil).toBe(61_000);

    let calls = 0;
    const restarted = new AskGovernor({
      now: () => now,
      initialCircuit: snapshot,
      invoke: async () => { calls++; return ok(); },
    });
    await expect(restarted.submit(request())).rejects.toMatchObject({ code: "circuit_open" });
    expect(calls).toBe(0);
    now = 61_001;
    await restarted.submit(request());
    expect(calls).toBe(1);
  });

  test("enforces named attempt budgets", async () => {
    const governor = new AskGovernor({ invoke: async () => ok() });
    const limited = request({ policy: { caller: "test", budgetKey: "daily", budgetLimit: 1 } });
    await governor.submit(limited);
    await expect(governor.submit(limited)).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  test("coalesces duplicate requests", async () => {
    let calls = 0;
    const governor = new AskGovernor({ invoke: async () => { calls++; await Bun.sleep(5); return ok(); } });
    const duplicate = request({ policy: { caller: "test", dedupeKey: "same" } });
    const [first, second] = await Promise.all([governor.submit(duplicate), governor.submit(duplicate)]);
    expect(calls).toBe(1);
    expect(first.request_id).toBe(second.request_id);
    expect(governor.health().metrics.coalesced).toBe(1);
  });

  test("passes the remaining deadline to the call and redacts telemetry", async () => {
    let seen: AskRequest | undefined;
    const events: GovernorTelemetry[] = [];
    const governor = new AskGovernor({
      telemetry: (event) => events.push(event),
      invoke: async (call) => { seen = call; return ok("private-output"); },
    });
    await governor.submit(request({ payload: { input: "private-input", model: "model-a" }, policy: { caller: "test", timeoutMs: 30_000 } }));
    expect(seen).toMatchObject({ prompt: "private-input", model: "model-a", timeoutSec: 30 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private-input");
    expect(serialized).not.toContain("private-output");
  });

  test("rejects a provider override without a model", () => {
    const governor = new AskGovernor({ invoke: async () => ok() });
    expect(() => governor.submit(request({ payload: { input: "x", provider: "p" } }))).toThrow(GovernorError);
  });
});

describe("governedAsk client", () => {
  test("uses an in-process governor when no service is configured", async () => {
    const previous = process.env.ZOUROBOROS_ASK_GOVERNOR_URL;
    delete process.env.ZOUROBOROS_ASK_GOVERNOR_URL;
    try {
      const governor = new AskGovernor({ invoke: async () => ok("pong") });
      const result = await governedAsk({ input: "ping" }, { caller: "client-test", governor });
      expect(result.output).toBe("pong");
    } finally {
      if (previous !== undefined) process.env.ZOUROBOROS_ASK_GOVERNOR_URL = previous;
    }
  });

  test("fails closed when the configured governor service is unavailable", async () => {
    const urls: string[] = [];
    await expect(governedAsk(
      { input: "ping" },
      {
        caller: "client-test",
        governorUrl: "http://127.0.0.1:7821/v1/ask",
        fetchImpl: (async (url: string | URL | Request) => {
          urls.push(String(url));
          throw new Error("governor unavailable");
        }) as unknown as typeof fetch,
      },
    )).rejects.toThrow("governor unavailable");
    expect(urls).toEqual(["http://127.0.0.1:7821/v1/ask"]);
  });
});
