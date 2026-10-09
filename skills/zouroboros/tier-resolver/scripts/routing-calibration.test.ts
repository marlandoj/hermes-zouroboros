import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TIER_THRESHOLDS,
  feedbackTaskText,
  MAX_FEEDBACK_TASK_CHARS,
  normalizeWeightsToTotal,
  sanitizeTaskText,
  stratifiedCalibrationSplit,
  stratifiedCalibrationSplits,
  validateTierThresholds,
  validateWeightValues,
} from "./routing-calibration.ts";
import { estimateComplexity } from "./persona-tier-resolve.ts";

const REFERENCE_WEIGHTS: Record<string, number> = {
  wordCount: 0.04,
  fileRefs: 0.02,
  multiStep: 0.10,
  toolUsage: 0.04,
  analysisDepth: 0.08,
  domainComplexity: 0.10,
  techStackDepth: 0.10,
  conceptCount: 0.20,
  taskVerbComplexity: 0.10,
  scopeBreadth: 0.12,
  featureListCount: 0.20,
  operationalRisk: 0,
};

describe("routing calibration input isolation", () => {
  test("extracts a query that precedes injected project instructions", () => {
    const input = "USER QUERY:\nFix the typo\nCURRENT PROJECT INSTRUCTIONS (freshly resolved):\nlarge context";
    expect(sanitizeTaskText(input)).toBe("Fix the typo");
  });

  test("extracts a query that follows injected project instructions", () => {
    const input = "CURRENT PROJECT INSTRUCTIONS:\nlarge context\nUSER QUERY:\nInvestigate the routing failure";
    expect(sanitizeTaskText(input)).toBe("Investigate the routing failure");
  });

  test("leaves an ordinary task unchanged", () => {
    expect(sanitizeTaskText("  Review the API changes  ")).toBe("Review the API changes");
  });

  test("caps telemetry without changing classification input", () => {
    const input = `USER QUERY:\n${"x".repeat(MAX_FEEDBACK_TASK_CHARS + 50)}`;
    const result = feedbackTaskText(input);
    expect(result.taskText).toHaveLength(MAX_FEEDBACK_TASK_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.sanitized).toBe(true);
  });

  test("the production classifier ignores injected context", async () => {
    const task = "Fix the typo in README.md";
    const wrapped = `CURRENT PROJECT INSTRUCTIONS:\n${"distributed architecture security pipeline ".repeat(100)}\nUSER QUERY:\n${task}`;
    const plainResult = await estimateComplexity(task);
    const wrappedResult = await estimateComplexity(wrapped);
    expect(wrappedResult.tier).toBe(plainResult.tier);
    expect(wrappedResult.score).toBe(plainResult.score);
    expect(wrappedResult.inferredTaskType).toBe(plainResult.inferredTaskType);
  });
});

describe("routing weight invariants", () => {
  test("accepts the calibrated reference mass", () => {
    expect(validateWeightValues(REFERENCE_WEIGHTS, REFERENCE_WEIGHTS).ok).toBe(true);
  });

  test("accepts a zero weight when total mass is preserved", () => {
    const candidate = { ...REFERENCE_WEIGHTS, fileRefs: 0, conceptCount: 0.22 };
    expect(validateWeightValues(candidate, REFERENCE_WEIGHTS).ok).toBe(true);
  });

  test("rejects missing, unknown, negative, and mass-drifted weights", () => {
    const candidate: Record<string, number> = { ...REFERENCE_WEIGHTS, wordCount: -0.1, unknownSignal: 0.1 };
    delete candidate.fileRefs;
    const result = validateWeightValues(candidate, REFERENCE_WEIGHTS);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing weights");
    expect(result.errors.join(" ")).toContain("unknown weights");
    expect(result.errors.join(" ")).toContain("non-negative");
  });

  test("normalization preserves the configured 1.1 weight mass", () => {
    const candidate = normalizeWeightsToTotal({ ...REFERENCE_WEIGHTS, fileRefs: 0.04 }, 1.1);
    const total = Object.values(candidate).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1.1, 12);
  });

  test("accepts ordered thresholds and rejects crossings", () => {
    expect(validateTierThresholds(DEFAULT_TIER_THRESHOLDS).ok).toBe(true);
    expect(validateTierThresholds({ ...DEFAULT_TIER_THRESHOLDS, simple: 0.03 }).ok).toBe(false);
    expect(validateTierThresholds({ ...DEFAULT_TIER_THRESHOLDS, apex: 1.1 }).ok).toBe(false);
  });
});

describe("held-out calibration split", () => {
  test("is deterministic, disjoint, and stratified", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      id: `entry-${index}`,
      correctedTier: index < 20 ? "simple" : "complex",
    }));
    const first = stratifiedCalibrationSplit(entries);
    const second = stratifiedCalibrationSplit(entries);
    expect(first).toEqual(second);
    expect(first.holdout).toHaveLength(10);
    const holdoutIds = new Set(first.holdout.map((entry) => entry.id));
    expect(first.training.filter((entry) => holdoutIds.has(entry.id))).toHaveLength(0);
    expect(new Set(first.holdout.map((entry) => entry.correctedTier))).toEqual(new Set(["simple", "complex"]));
  });

  test("produces deterministic repeated splits with varying holdouts", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      id: `entry-${index}`,
      correctedTier: index < 20 ? "simple" : "complex",
    }));
    const first = stratifiedCalibrationSplits(entries, 5);
    const second = stratifiedCalibrationSplits(entries, 5);
    expect(first).toEqual(second);
    expect(new Set(first.map((split) => split.holdout.map((entry) => entry.id).sort().join(","))).size).toBeGreaterThan(1);
  });
});

describe("operational routing evidence", () => {
  test("records operational risk without changing incumbent behavior", async () => {
    const result = await estimateComplexity("Commit the verified changes, push the branch, and open a pull request");
    const signal = result.signals.find((candidate) => candidate.name === "operationalRisk");
    expect(signal?.rawValue).toBeGreaterThanOrEqual(3);
    expect(signal?.weight).toBe(0);
  });
});
