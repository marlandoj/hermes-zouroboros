// ZOU-451 instinct-harvester — dedup + conflict resolution (pure, no I/O).
// Conflict rule (SPEC): same-key candidate is a reinforcement; the
// higher-confidence entry's fields win; if equal, the existing entry's fields
// are kept; reinforced_count is merged (summed) either way.

export interface Instinct {
  id: string;
  trigger: string;
  action: string;
  domain: string;
  confidence: number;
  source: string;
  reinforced_count: number;
  last_seen: string;
  /** Hard-protect marker. Read by the lifecycle admission gate (item 2). */
  critical?: boolean;
  /** Set by `observer.ts supersede`; applied by the lifecycle. Item 9. */
  supersedes?: string;
  /** Audit stamp written by the lifecycle when a demotion is applied. */
  superseded_by?: string;
  /**
   * Why the last reinforcement counted as real reuse. `reinforce` refuses to
   * increment without it (item 8): reinforced_count is the signal protection
   * is built on, so a blind counter makes that protection meaningless.
   */
  reinforce_evidence?: string;
}

export interface InstinctCandidate {
  trigger: string;
  action: string;
  domain: string;
  confidence?: number;
  source?: string;
  reinforced_count?: number;
  critical?: boolean;
}
export type MergeOutcome =
  | { kind: "added"; instinct: Instinct }
  | { kind: "reinforced"; instinct: Instinct }
  | { kind: "rejected"; reasons: string[] };

export const DEFAULT_CONFIDENCE = 0.7;

export function normalizeKey(trigger: string, domain: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(trigger)}::${norm(domain)}`;
}

export function validateCandidate(c: Partial<InstinctCandidate>): string[] {
  const errors: string[] = [];
  if (!c.trigger || !c.trigger.trim()) errors.push("trigger is required");
  if (!c.action || !c.action.trim()) errors.push("action is required");
  if (!c.domain || !/^[a-z0-9][a-z0-9-]*$/.test(c.domain.trim()))
    errors.push("domain is required and must be a lowercase slug (e.g. software-factory)");
  if (c.confidence !== undefined && !(c.confidence > 0 && c.confidence <= 1))
    errors.push("confidence must be in (0, 1]");
  if ((c.trigger?.length ?? 0) > 500 || (c.action?.length ?? 0) > 500)
    errors.push("trigger/action must be <= 500 chars");
  return errors;
}

export function nextId(instincts: Instinct[]): string {
  const max = instincts.reduce((m, i) => {
    const n = Number(/^inst_(\d+)$/.exec(i.id)?.[1] ?? 0);
    return n > m ? n : m;
  }, 0);
  return `inst_${String(max + 1).padStart(3, "0")}`;
}

export function mergeCandidate(
  instincts: Instinct[],
  cand: InstinctCandidate,
  today: string,
): { instincts: Instinct[]; outcome: MergeOutcome } {
  const errors = validateCandidate(cand);
  if (errors.length > 0) return { instincts, outcome: { kind: "rejected", reasons: errors } };

  const candidate: Instinct = {
    id: "", // assigned below if new
    trigger: cand.trigger.trim(),
    action: cand.action.trim(),
    domain: cand.domain.trim(),
    confidence: cand.confidence ?? DEFAULT_CONFIDENCE,
    source: cand.source?.trim() || "session-observation",
    reinforced_count: cand.reinforced_count ?? 1,
    last_seen: today,
    ...(cand.critical ? { critical: true } : {}),
  };

  const key = normalizeKey(candidate.trigger, candidate.domain);
  const idx = instincts.findIndex((i) => normalizeKey(i.trigger, i.domain) === key);

  if (idx === -1) {
    candidate.id = nextId(instincts);
    return {
      instincts: [...instincts, candidate],
      outcome: { kind: "added", instinct: candidate },
    };
  }

  const existing = instincts[idx];
  const winner = candidate.confidence > existing.confidence ? candidate : existing;
  const merged: Instinct = {
    ...winner,
    id: existing.id,
    confidence: Math.max(existing.confidence, candidate.confidence),
    reinforced_count: existing.reinforced_count + candidate.reinforced_count,
    last_seen: today,
    // critical is sticky: a later plain reinforcement must not un-mark it.
    ...(existing.critical || candidate.critical ? { critical: true } : {}),
  };
  const out = [...instincts];
  out[idx] = merged;
  return { instincts: out, outcome: { kind: "reinforced", instinct: merged } };
}
