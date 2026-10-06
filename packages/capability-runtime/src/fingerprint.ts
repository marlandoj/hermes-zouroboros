import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over a deterministically key-sorted JSON encoding. Stable across process restarts and field-order changes. */
export function canonicalPayloadDigest(payload: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

export function digestsMatch(a: string, b: string): boolean {
  return a === b;
}
