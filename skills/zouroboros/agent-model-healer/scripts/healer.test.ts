import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AskOutcome } from "../../../../integration/ask.ts";
import {
  advanceStreak,
  classifyLatency,
  classifyProbe,
  classifyRung,
  DEFAULT_HEALTHY_RESPONSE_MS,
  HEALTHY_RESPONSE_ENV,
  healthyResponseThresholdMs,
  healthyThreshold,
  isExcludedModel,
  probeModel,
  ProbeInfrastructureError,
  streakMet,
  unhealthyThreshold,
  validateChain,
  validateExclusions,
  validateProbeSemantics,
} from "./healer.ts";

type Config = Parameters<typeof validateChain>[0];

function configWith(fallbacks: string[], labels: Record<string, string>): Config {
  return {
    probeConfig: {
      prompt: "test",
      expectedSubstring: "test",
      timeoutMs: 30000,
      retries: 0,
      healthyResponseMs: 10000,
    },
    fallbackChains: {
      "vendor/claude": { label: "Claude Sonnet", fallbacks },
      "vendor/gpt-oss": { label: "GPT-OSS-120B", fallbacks: [] },
      "vendor/sonnet-mini": { label: "Claude Haiku", fallbacks: [] },
    },
    modelLabels: labels,
  };
}

describe("model healer fallback-chain policy", () => {
  test("classifies GPT-OSS as open-weight before the generic GPT hint", () => {
    expect(classifyRung("vendor/model", "GPT-OSS-120B")).toBe("open-weight");
  });

  test("classifies GLM labels as open-weight (terminal rung eligibility)", () => {
    expect(classifyRung("z-ai/glm-5.3-flash", "GLM-5.3-Flash")).toBe("open-weight");
  });

  test("accepts a proprietary chain that ends on an open-weight rung", () => {
    const config = configWith(["vendor/gpt-oss"], {});
    config.fallbackChains["vendor/sonnet-mini"]!.fallbacks = ["vendor/gpt-oss"];
    expect(validateChain(config)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("rejects a proprietary chain without an open-weight rung", () => {
    const config = configWith(["vendor/sonnet-mini"], {});
    const errors = validateChain(config).errors;
    expect(errors).toContain("Proprietary chain 'Claude Sonnet' lacks an open-weight rung before terminal exhaustion");
    expect(errors).toContain("Chain 'Claude Haiku' has empty fallbacks but primary rung is 'proprietary' (expected open-weight)");
  });

  test("rejects a fallback that is not a registered chain model", () => {
    const config = configWith(["vendor/unknown-oss-llama"], {});
    expect(validateChain(config).errors.join("\n")).toContain("is not a registered chain model");
  });

  test("keeps the tracked fallback-chain example policy-compliant", () => {
    const example = JSON.parse(
      readFileSync(new URL("../assets/fallback-chain.example.json", import.meta.url), "utf8"),
    ) as Config;

    expect(validateChain(example)).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe("probe timing semantics", () => {
  test("healthy-response threshold defaults to 20s (hermes -z pays ~8s of startup per probe)", () => {
    const config = configWith([], {});
    delete config.probeConfig.healthyResponseMs;
    expect(DEFAULT_HEALTHY_RESPONSE_MS).toBe(20000);
    expect(healthyResponseThresholdMs(config, {})).toBe(20000);
    // A probe at the observed healthy end-to-end time (~11 s) is healthy, not degraded.
    expect(classifyLatency(11_000, config).health).toBe("healthy");
    expect(validateProbeSemantics(config).ok).toBe(true);
  });

  test("the configured threshold applies, and the environment override wins", () => {
    const config = configWith([], {});
    expect(healthyResponseThresholdMs(config, {})).toBe(10000);
    expect(healthyResponseThresholdMs(config, { [HEALTHY_RESPONSE_ENV]: "25000" })).toBe(25000);
    expect(healthyResponseThresholdMs(config, { [HEALTHY_RESPONSE_ENV]: "" })).toBe(10000);
    for (const bad of ["0", "-5", "12.5", "fast"]) expect(() => healthyResponseThresholdMs(config, { [HEALTHY_RESPONSE_ENV]: bad })).toThrow(HEALTHY_RESPONSE_ENV);
  });

  test("the shipped example uses the 20s default under a 30s timeout", () => {
    const example = JSON.parse(readFileSync(new URL("../assets/fallback-chain.example.json", import.meta.url), "utf8")) as Config;
    expect(example.probeConfig.healthyResponseMs).toBe(20000);
    expect(validateProbeSemantics(example).ok).toBe(true);
  });

  test("legacy latencyThresholds still feed the threshold when healthyResponseMs is absent", () => {
    const config = configWith([], {});
    delete config.probeConfig.healthyResponseMs;
    (config.probeConfig as any).latencyThresholds = { degradedMs: 8000, slowMs: 20000 };
    expect(healthyResponseThresholdMs(config)).toBe(8000);
  });

  test("timeout must sit strictly above the healthy-response threshold", () => {
    const bad = configWith([], {});
    bad.probeConfig.timeoutMs = 10000; // == threshold
    expect(validateProbeSemantics(bad).ok).toBe(false);

    const fractional = configWith([], {});
    fractional.probeConfig.timeoutMs = 30500; // the bridge timeout is whole seconds
    expect(validateProbeSemantics(fractional).ok).toBe(false);

    const good = configWith([], {});
    good.probeConfig.timeoutMs = 30000;
    expect(validateProbeSemantics(good).ok).toBe(true);
  });

  test("a completed response above the threshold is degraded with its real elapsed time", () => {
    const config = configWith([], {});
    const slow = classifyLatency(14500, config);
    expect(slow.health).toBe("degraded");
    expect(slow.warning).toContain("14500ms");

    const fast = classifyLatency(9000, config);
    expect(fast.health).toBe("healthy");
  });
});

describe("operator exclusions", () => {
  const exclusions = ["qwen3.8", "kimi-code/k3,thinking", "kimi-for-coding-highspeed"];

  test("excluded models match exactly or by case-insensitive substring", () => {
    const config = configWith([], {});
    config.excludedFromAutoFallback = exclusions;
    expect(isExcludedModel("Qwen3.8-Max", config)).toBe(true);
    expect(isExcludedModel("kimi-code/k3,thinking", config)).toBe(true);
    expect(isExcludedModel("svc:kimi-for-coding-highspeed", config)).toBe(true);
    expect(isExcludedModel("moonshotai/kimi-k3", config)).toBe(false);
  });

  test("warns when a chain primary is excluded from automatic healing", () => {
    const config = configWith([], {});
    config.excludedFromAutoFallback = ["claude"];
    const result = validateExclusions(config);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("will not be auto-healed");
  });
});

describe("probes through the Hermes ask layer", () => {
  const outcome = (o: Partial<AskOutcome>): AskOutcome => ({ ok: false, output: "", exitCode: 1, ms: 5, model: "m", ...o });

  test("a completed response with the marker is healthy; a slow one is degraded with its real time", () => {
    const config = configWith([], {});
    expect(classifyProbe("m", outcome({ ok: true, exitCode: 0, output: "1\n2\ntest", ms: 900 }), config)).toMatchObject({ healthy: true, health: "healthy", latencyMs: 900 });
    expect(classifyProbe("m", outcome({ ok: true, exitCode: 0, output: "test", ms: 12_000 }), config)).toMatchObject({ healthy: true, health: "degraded", latencyMs: 12_000 });
    expect(classifyProbe("m", outcome({ ok: true, exitCode: 0, output: "nope", ms: 900 }), config)).toMatchObject({ healthy: true, health: "degraded" });
  });

  test("a timeout records no latency; other model failures are categorized", () => {
    const config = configWith([], {});
    expect(classifyProbe("m", outcome({ failure: "timeout", exitCode: 124 }), config)).toMatchObject({ healthy: false, latencyMs: null, failureCategory: "timeout" });
    expect(classifyProbe("m", outcome({ failure: "failed", detail: "empty output" }), config)).toMatchObject({ failureCategory: "empty_response" });
    expect(classifyProbe("m", outcome({ failure: "failed", exitCode: 1 }), config)).toMatchObject({ failureCategory: "provider_error" });
  });

  test("an unfunded provider is an informational status, never healthy, never retried", async () => {
    const config = configWith([], {});
    expect(classifyProbe("m", outcome({ failure: "unfunded", exitCode: 88 }), config)).toMatchObject({
      healthy: false, health: "unfunded", failureCategory: "unfunded", warning: "unfunded (skipped)", latencyMs: null,
    });
    expect(classifyProbe("m", outcome({ failure: "unfunded", exitCode: 88 }), config).error).toBeUndefined();
    config.probeConfig.retries = 3;
    let calls = 0;
    const result = await probeModel("vendor/gpt-oss", config, async () => { calls++; return outcome({ failure: "unfunded", exitCode: 88 }); });
    expect(result.health).toBe("unfunded");
    expect(calls).toBe(1);
  });

  test("an unavailable probe path aborts instead of marking models unhealthy", () => {
    const config = configWith([], {});
    expect(() => classifyProbe("m", outcome({ failure: "unavailable", exitCode: 127 }), config)).toThrow(ProbeInfrastructureError);
  });

  test("probes pass the chain provider, whole-second timeout and retry on failure", async () => {
    const config = configWith([], {});
    config.probeConfig.retries = 1;
    config.fallbackChains["vendor/gpt-oss"]!.provider = "example-provider";
    const seen: unknown[] = [];
    const result = await probeModel("vendor/gpt-oss", config, async (request) => {
      seen.push(request);
      return seen.length === 1 ? outcome({ failure: "failed" }) : outcome({ ok: true, exitCode: 0, output: "test", ms: 10 });
    });
    expect(result.healthy).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ model: "vendor/gpt-oss", provider: "example-provider", timeoutSec: 30 });
  });
});

describe("hysteresis (flap guard)", () => {
  const configWithHysteresis = (h: { consecutiveUnhealthyToHeal?: number; consecutiveHealthyToRestore?: number }): Config => {
    const config = configWith(["vendor/gpt-oss"], {});
    config.hysteresis = h;
    return config;
  };

  test("a single unhealthy probe does not satisfy a heal threshold of 2", () => {
    let streak = advanceStreak(undefined, false, "2026-09-26T00:00:00Z");
    expect(streakMet(streak, false, unhealthyThreshold(configWithHysteresis({ consecutiveUnhealthyToHeal: 2 })))).toBe(false);
  });

  test("two consecutive unhealthy probes satisfy a heal threshold of 2", () => {
    let streak = advanceStreak(undefined, false, "2026-09-26T00:00:00Z");
    streak = advanceStreak(streak, false, "2026-09-26T00:15:00Z");
    expect(streakMet(streak, false, unhealthyThreshold(configWithHysteresis({ consecutiveUnhealthyToHeal: 2 })))).toBe(true);
  });

  test("a healthy sample in between resets the unhealthy run", () => {
    let streak = advanceStreak(undefined, false, "2026-09-26T00:00:00Z");
    streak = advanceStreak(streak, true, "2026-09-26T00:15:00Z");
    streak = advanceStreak(streak, false, "2026-09-26T00:30:00Z");
    expect(streak.consecutiveUnhealthy).toBe(1);
    expect(streakMet(streak, false, 2)).toBe(false);
  });

  test("alternating samples never reach a threshold of 2", () => {
    let streak = advanceStreak(undefined, false, "t0");
    for (let i = 0; i < 8; i++) {
      streak = advanceStreak(streak, i % 2 === 0, `t${i + 1}`);
    }
    expect(streakMet(streak, false, 2)).toBe(false);
    expect(streakMet(streak, true, 2)).toBe(false);
  });

  test("restore requires 3 consecutive healthy samples, heal only 2 unhealthy", () => {
    const config = configWithHysteresis({ consecutiveUnhealthyToHeal: 2, consecutiveHealthyToRestore: 3 });
    expect(unhealthyThreshold(config)).toBe(2);
    expect(healthyThreshold(config)).toBe(3);
    let streak = advanceStreak(undefined, false, "t0");
    streak = advanceStreak(streak, false, "t1");
    expect(streakMet(streak, false, unhealthyThreshold(config))).toBe(true);
    // Same streak is not yet enough to restore a different direction.
    expect(streakMet(streak, true, healthyThreshold(config))).toBe(false);
  });

  test("a missing streak never acts when the threshold is above 1 (fail closed)", () => {
    expect(streakMet(undefined, false, 2)).toBe(false);
    expect(streakMet(undefined, true, 3)).toBe(false);
  });

  test("an absent hysteresis block fails closed to 2-to-heal / 3-to-restore", () => {
    const config = configWith([], {});
    delete config.hysteresis;
    expect(unhealthyThreshold(config)).toBe(2);
    expect(healthyThreshold(config)).toBe(3);
  });

  test("an explicit threshold of 1 restores single-sample behavior", () => {
    const config = configWith([], {});
    config.hysteresis = { consecutiveUnhealthyToHeal: 1, consecutiveHealthyToRestore: 1 };
    expect(unhealthyThreshold(config)).toBe(1);
    expect(healthyThreshold(config)).toBe(1);
    expect(streakMet(undefined, false, 1)).toBe(true);
  });

  test("nonsensical thresholds fall back to the safe defaults", () => {
    const config = configWith([], {});
    config.hysteresis = { consecutiveUnhealthyToHeal: 0, consecutiveHealthyToRestore: -5 };
    expect(unhealthyThreshold(config)).toBe(2);
    expect(healthyThreshold(config)).toBe(3);
  });

  test("shipped example declares 2-to-heal and 3-to-restore", () => {
    const shipped = JSON.parse(readFileSync(new URL("../assets/fallback-chain.example.json", import.meta.url), "utf-8"));
    expect(shipped.hysteresis.consecutiveUnhealthyToHeal).toBe(2);
    expect(shipped.hysteresis.consecutiveHealthyToRestore).toBe(3);
  });
});
