export const MAX_FEEDBACK_TASK_CHARS = 4_000;
export const MIN_CALIBRATION_CORRECTIONS = 40;
export const MIN_CALIBRATION_HOLDOUT = 10;
export const CALIBRATION_HOLDOUT_FRACTION = 0.25;
export const CALIBRATION_VALIDATION_SPLITS = 5;

export interface TierThresholds {
  trivial: number;
  simple: number;
  moderate: number;
  apex: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  trivial: 0.04,
  simple: 0.15,
  moderate: 0.45,
  apex: 0.85,
};

const USER_QUERY_MARKER = "USER QUERY:";
const CONTEXT_BOUNDARY = /\n(?:CURRENT PROJECT INSTRUCTIONS|MENTIONED FILE CONTEXT|<system-reminder>)/;

export function sanitizeTaskText(input: string): string {
  const trimmed = input.trim();
  const markerIndex = trimmed.lastIndexOf(USER_QUERY_MARKER);
  if (markerIndex < 0) return trimmed;

  const tail = trimmed.slice(markerIndex + USER_QUERY_MARKER.length);
  const boundaryIndex = tail.search(CONTEXT_BOUNDARY);
  const extracted = (boundaryIndex >= 0 ? tail.slice(0, boundaryIndex) : tail).trim();
  return extracted || trimmed;
}

export function feedbackTaskText(input: string): {
  taskText: string;
  inputLength: number;
  truncated: boolean;
  sanitized: boolean;
} {
  const sanitizedText = sanitizeTaskText(input);
  return {
    taskText: sanitizedText.slice(0, MAX_FEEDBACK_TASK_CHARS),
    inputLength: input.length,
    truncated: sanitizedText.length > MAX_FEEDBACK_TASK_CHARS,
    sanitized: sanitizedText !== input.trim(),
  };
}

export interface WeightValidation {
  ok: boolean;
  errors: string[];
  total: number;
}

export function validateTierThresholds(thresholds: TierThresholds): WeightValidation {
  const errors: string[] = [];
  const expectedKeys = Object.keys(DEFAULT_TIER_THRESHOLDS).sort();
  const actualKeys = Object.keys(thresholds).sort();
  const missing = expectedKeys.filter((key) => !(key in thresholds));
  const extra = actualKeys.filter((key) => !(key in DEFAULT_TIER_THRESHOLDS));
  if (missing.length) errors.push(`missing thresholds: ${missing.join(", ")}`);
  if (extra.length) errors.push(`unknown thresholds: ${extra.join(", ")}`);

  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value)) errors.push(`${key} threshold must be finite`);
    else if (value < 0 || value > 1) errors.push(`${key} threshold must be between 0 and 1`);
  }
  if (!(thresholds.trivial < thresholds.simple
    && thresholds.simple < thresholds.moderate
    && thresholds.moderate < thresholds.apex)) {
    errors.push("thresholds must be strictly increasing");
  }
  return {
    ok: errors.length === 0,
    errors,
    total: Object.values(thresholds).reduce((sum, value) => sum + value, 0),
  };
}

export function validateWeightValues(
  weights: Record<string, number>,
  reference: Record<string, number>,
  tolerance = 1e-9,
): WeightValidation {
  const errors: string[] = [];
  const expectedKeys = Object.keys(reference).sort();
  const actualKeys = Object.keys(weights).sort();

  const missing = expectedKeys.filter((key) => !(key in weights));
  const extra = actualKeys.filter((key) => !(key in reference));
  if (missing.length) errors.push(`missing weights: ${missing.join(", ")}`);
  if (extra.length) errors.push(`unknown weights: ${extra.join(", ")}`);

  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value)) errors.push(`${key} must be finite`);
    else if (value < 0) errors.push(`${key} must be non-negative`);
  }

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const expectedTotal = Object.values(reference).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || Math.abs(total - expectedTotal) > tolerance) {
    errors.push(`weight total ${total} must equal calibrated total ${expectedTotal}`);
  }

  return { ok: errors.length === 0, errors, total };
}

export function normalizeWeightsToTotal(
  weights: Record<string, number>,
  targetTotal: number,
): Record<string, number> {
  const nonNegative = Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [key, Math.max(0, value)]),
  );
  const total = Object.values(nonNegative).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(targetTotal) || targetTotal <= 0) {
    throw new Error("Cannot normalize invalid weight totals");
  }
  return Object.fromEntries(
    Object.entries(nonNegative).map(([key, value]) => [key, value * targetTotal / total]),
  );
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stratifiedCalibrationSplit<T extends { id: string; correctedTier?: string }>(
  entries: T[],
  holdoutFraction = CALIBRATION_HOLDOUT_FRACTION,
  seed = 0,
): { training: T[]; holdout: T[] } {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const tier = entry.correctedTier ?? "unknown";
    const group = groups.get(tier) ?? [];
    group.push(entry);
    groups.set(tier, group);
  }

  const training: T[] = [];
  const holdout: T[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => stableHash(`${seed}:${a.id}`) - stableHash(`${seed}:${b.id}`) || a.id.localeCompare(b.id));
    const holdoutCount = sorted.length >= 2
      ? Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * holdoutFraction)))
      : 0;
    holdout.push(...sorted.slice(0, holdoutCount));
    training.push(...sorted.slice(holdoutCount));
  }

  return { training, holdout };
}

export function stratifiedCalibrationSplits<T extends { id: string; correctedTier?: string }>(
  entries: T[],
  count = CALIBRATION_VALIDATION_SPLITS,
  holdoutFraction = CALIBRATION_HOLDOUT_FRACTION,
): Array<{ training: T[]; holdout: T[] }> {
  if (!Number.isInteger(count) || count < 1) throw new Error("Calibration split count must be a positive integer");
  return Array.from({ length: count }, (_, seed) => stratifiedCalibrationSplit(entries, holdoutFraction, seed + 1));
}
