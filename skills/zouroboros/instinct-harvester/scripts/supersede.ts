// Item 9 — supersession producer.
//
// Until now the ONLY downward-confidence path required a `supersedes:` marker
// that nothing in the system ever wrote. `merge.ts` ratchets confidence UP,
// so the corpus was monotonic: rows could leave only by eviction. This module
// is the missing producer.
//
// Design constraints (this is a governance surface):
//   - DETERMINISTIC. No LLM, no embeddings, no network. Same store in, same
//     proposals out, every time.
//   - PROPOSAL-ONLY. Nothing here writes. Applying a supersession is an
//     explicit `observer.ts supersede --id OLD --by NEW`, so a human (or a
//     governed pipeline) confirms the contradiction is real. A wrong demotion
//     silently weakens a learned pattern, which is worse than a stale one.
//   - CONSERVATIVE. Only near-certain shapes are proposed. Recall is
//     deliberately sacrificed for precision: a missed suggestion costs a
//     re-run, a false one corrupts a pattern.

import type { Instinct } from "./merge";

export interface SupersessionCandidate {
  /** The instinct believed to be outdated — the one that would be demoted. */
  superseded: string;
  /** The instinct believed to replace it. */
  superseder: string;
  domain: string;
  reason: string;
  detail: string;
}

export interface CandidateOptions {
  domain?: string;
  limit?: number;
  /** Confidence gap required before we will call the newer row a correction. */
  minConfidenceGap?: number;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "when", "if", "in", "on", "at", "to", "for", "of", "and",
  "or", "then", "that", "this", "with", "from", "by", "as", "is", "are", "be",
  "do", "does", "did", "you", "your", "we", "our", "it", "its", "prefer",
  "always", "never", "should", "must", "can", "will", "may",
]);

/**
 * Canonical trigger shape with stop-words removed and tokens sorted, so that
 * "when deploying to prod" and "prod, when deploying" collapse to one stem
 * while "deploying to prod" and "deploying to staging" do not.
 */
export function triggerStem(trigger: string): string {
  return trigger
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .sort()
    .join(" ");
}

/**
 * A DENSE stem built from the stem's RARE tokens, so "run the full test suite
 * before every deploy" and "skip the test suite to ship faster" share a stem
 * even though the two mentions differ in length and include a negation.
 *
 * Why a stem is not enough: an exact token-set match never fires on real prose
 * because a single added or dropped token changes the whole string, and real
 * contradictions are phrased as "skip X" versus "run X". A Jaccard threshold
 * over the rare (non-generic) tokens of the stem gives similarity while
 * tolerating exactly that kind of rephrasing.
 *
 * Generic verbs/nouns that appear in nearly every trigger are dropped from the
 * comparison set so that two instincts which merely share "when deploying" are
 * not treated as near-duplicates of each other.
 */
const GENERIC_TOKENS = new Set([
  "run", "runs", "running", "make", "make", "use", "using", "used", "check",
  "checks", "checking", "add", "adds", "adding", "new", "one", "two", "any",
  "all", "up", "out", "via", "per", "into", "onto", "over", "after", "before",
  "use", "first", "last", "next", "other", "same", "different", "every",
  "each", "just", "only", "also", "more", "most", "less", "least",
]);

function contentTokens(trigger: string): Set<string> {
  return new Set(
    triggerStem(trigger)
      .split(/\s+/)
      .filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity threshold for "these two triggers describe the same situation". */
export const TRIGGER_SIMILARITY = 0.34;

function normalizeAction(action: string): string {
  return action.toLowerCase().replace(/\s+/g, " ").trim();
}

/** `anti-foo` contradicts `foo`; a bare `foo` never contradicts itself. */
function isAntonymDomain(a: string, b: string): boolean {
  const strip = (d: string) => d.replace(/^(anti-|not-|never-)/, "");
  const flagged = (d: string) => /^(anti-|not-|never-)/.test(d);
  return strip(a) === strip(b) && flagged(a) !== flagged(b);
}

/**
 * Tokens that pin an instinct to ONE specific situation: ticket ids, file
 * paths, command names, numbers. Two rows that name different tickets are
 * describing different situations no matter how similar the prose around them
 * reads, and must never be proposed as superseding each other.
 */
export function identifierTokens(text: string): string[] {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9._/-]+/)) {
    if (!t) continue;
    // Any token carrying a digit, or a dotted/path-like token, is a pin.
    if (/\d/.test(t) || t.includes(".") || t.includes("/")) out.add(t);
  }
  return [...out].sort();
}

/**
 * Hard veto: if both rows pin themselves with identifiers, those identifier
 * sets must be identical. This is what stops "GLW-04 / ZOU-1036" from being
 * proposed as superseded by "GLW-07 / ZOU-1069" — two distinct tickets that
 * share a house style, not a contradiction.
 */
export function identifierConflict(a: string, b: string): boolean {
  const ia = identifierTokens(a);
  const ib = identifierTokens(b);
  if (ia.length === 0 || ib.length === 0) return false;
  if (ia.length !== ib.length) return true;
  return ia.some((t, n) => t !== ib[n]);
}

/** Polarity words. Two actions that assert opposite polarity on the same
 * subject are contradictory by construction, not by similarity. */
const POLARITY: Array<[RegExp, 1 | -1]> = [
  // Negatives are tested FIRST: "must not" and "do not" must not be claimed by
  // the positive "must"/"do" pattern below. (The previous table grouped
  // "always" with "never", so both mapped to -1 and no pair of opposite
  // assertions could ever register — the producer was structurally blind.)
  [/\b(must not|should not|do not|dont|don't|never|avoid|stop|disable|refuse|reject|without|instead of|rather than|no longer)\b/i, -1],
  [/^(always|allow|permit|enable|prefer|keep|use|run|create|write|publish|do|must|should|proceed|continue)\b/i, 1],
];

function polarity(action: string): 1 | -1 | 0 {
  const a = action.trim();
  for (const [re, sign] of POLARITY) {
    if (re.test(a)) return sign;
  }
  return 0;
}

/** True when the two ACTIONS take opposite positions on the same subject.
 *  Deliberately narrow: requires an explicit negation on one side, because
 *  "always approve" vs "check for secrets" is a *refinement*, not a
 *  contradiction, and a refinement must not demote the row it refines. */
export function actionsContradict(a: Instinct, b: Instinct): boolean {
  const pa = polarity(a.action);
  const pb = polarity(b.action);
  if (pa === 0 || pb === 0 || pa === pb) return false;
  const neg = (s: string) => /\b(never|not|avoid|stop|disable|refuse|reject|without|instead of|rather than)\b/i.test(s);
  return neg(a.action) !== neg(b.action);
}

/** Content words shared by two triggers, ignoring stop-words and identifiers.
 *  Threshold is a Jaccard overlap so long and short triggers compare fairly. */
export function contentOverlap(a: Instinct, b: Instinct, min = 0.34): boolean {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/\d/.test(t)),
    );
  const ta = toks(a.trigger);
  const tb = toks(b.trigger);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= min;
}

export function findSupersessionCandidates(
  instincts: Instinct[],
  opts: CandidateOptions = {},
): SupersessionCandidate[] {
  const limit = opts.limit ?? 20;
  const minGap = opts.minConfidenceGap ?? 0.1;
  const out: SupersessionCandidate[] = [];

  const pool = opts.domain
    ? instincts.filter((i) => i.domain === opts.domain)
    : instincts;

  // Bucket by (base domain, trigger stem) so we only compare rows that
  // describe the same situation — a cross-product over 200 rows is both slow
  // and mostly false positives.
  const buckets = new Map<string, Instinct[]>();
  for (const i of pool) {
    const stem = triggerStem(i.trigger);
    if (!stem) continue;
    // Same-stem rows group together; the "anti-" domain is folded onto its
    // base domain so `foo` and `anti-foo` land in one bucket.
    const key = `${i.domain.replace(/^(anti-|not-|never-)/, "")}::${stem}`;
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  }

  // Each bucket's rows are candidates for mutual comparison, but a *near*-stem
  // pair still needs to be merged into one group: two instincts written on
  // different days rarely produce byte-identical stems, so exact bucketing
  // alone finds almost nothing on real prose. Union-find over the buckets
  // linked by content-token Jaccard keeps the comparison cheap and stable.
  const all = pool.filter((i) => triggerStem(i.trigger).length > 0);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const i of all) parent.set(i.id, i.id);
  for (const group of buckets.values()) {
    for (let n = 1; n < group.length; n++) union(group[0].id, group[n].id);
  }
  // Near-stem links, restricted to shared base domain to avoid cross-topic noise.
  const baseDomain = (d: string) => d.replace(/^(anti-|not-|never-)/, "");
  const byDomain = new Map<string, Instinct[]>();
  for (const i of all) {
    const k = baseDomain(i.domain);
    const arr = byDomain.get(k);
    if (arr) arr.push(i);
    else byDomain.set(k, [i]);
  }
  for (const rows of byDomain.values()) {
    const toks = rows.map((i) => contentTokens(i.trigger));
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        if (rows[a].id === rows[b].id) continue;
        if (jaccard(toks[a], toks[b]) >= TRIGGER_SIMILARITY) {
          union(rows[a].id, rows[b].id);
        }
      }
    }
  }
  const groups = new Map<string, Instinct[]>();
  for (const i of all) {
    const root = find(i.id);
    const arr = groups.get(root);
    if (arr) arr.push(i);
    else groups.set(root, [i]);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const domain = baseDomain(group[0].domain);

    for (const newer of group) {
      for (const older of group) {
        if (newer.id === older.id) continue;
        if (normalizeAction(newer.action) === normalizeAction(older.action)) {
          continue;
        }

        // The superseder must be at least as recent, and either meaningfully
        // more confident or strictly newer. Without this, an ancient 0.95 row
        // would "correct" a fresh 0.7 row and we would demote the fresh one.
        const newerIsNewer =
          newer.last_seen > older.last_seen ||
          newer.confidence >= older.confidence + minGap;
        if (!newerIsNewer) continue;

        // Different tickets = different situations. Veto before any other test.
        if (identifierConflict(newer.trigger, older.trigger)) continue;

        // A shared trigger stem is necessary but NOT sufficient. Two rows that
        // share only boilerplate while naming different work are not a
        // contradiction. Require the rows to share real content tokens, and
        // require a stated contradiction between the two ACTIONS — otherwise
        // we are just guessing.
        const antonym = isAntonymDomain(newer.domain, older.domain);
        // An antonym-domain pair is a contradiction BY CONSTRUCTION (the
        // domains are declared opposites for the same trigger), so it needs no
        // polarity test. A same-domain pair must state the contradiction in the
        // actions, or we are guessing.
        if (antonym) {
          if (identifierConflict(newer.trigger, older.trigger)) continue;
        } else {
          if (!contentOverlap(newer, older)) continue;
          if (!actionsContradict(newer, older)) continue;
        }

        // Already demoted / already has an audit pointer — do not re-propose.
        if (older.superseded_by || newer.supersedes) continue;

        out.push({
          superseded: older.id,
          superseder: newer.id,
          domain,
          reason: antonym
            ? "antonym domains state opposite preferences for the same trigger"
            : "same situation, opposite-polarity action — direct contradiction",
          detail:
            `old[${older.domain}] ${older.trigger} → ${older.action} ` +
            `(conf ${older.confidence}, seen ${older.last_seen})\n` +
            `   new[${newer.domain}] ${newer.trigger} → ${newer.action} ` +
            `(conf ${newer.confidence}, seen ${newer.last_seen})`,
        });
      }
    }
  }

  // Deduplicate by unordered pair, keeping the strongest evidence, then a
  // deterministic order. Union-find can otherwise surface the same (old, new)
  // pair more than once through overlapping groups.
  const byPair = new Map<string, SupersessionCandidate>();
  for (const c of out) {
    const pair = [c.superseded, c.superseder].sort().join("::");
    const prior = byPair.get(pair);
    if (!prior) {
      byPair.set(pair, c);
      continue;
    }
    const score = (x: SupersessionCandidate) =>
      (x.reason.startsWith("antonym") ? 1 : 0) + 1;
    if (score(c) > score(prior)) byPair.set(pair, c);
  }
  const uniq = [...byPair.values()];
  uniq.sort(
    (a, b) =>
      a.superseded.localeCompare(b.superseded) ||
      a.superseder.localeCompare(b.superseder),
  );
  return uniq.slice(0, limit);
}
