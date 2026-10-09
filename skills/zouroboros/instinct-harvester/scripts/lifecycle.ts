// ZOU-556 instinct-harvester — confidence lifecycle (pure logic + CLI).
//
//   bun lifecycle.ts [--apply] [--report PATH] [--half-life 30]
//                   [--protect-reinforced 8] [--protect-top 0.10]
//                   [--protect-conf 0] [--cap 200] [--per-domain-cap N]
//                   [--supersede-factor 0.5] [--today YYYY-MM-DD]
//
// Four stages: liveness (recency, never mutates confidence), protection,
// supersession (the only downward confidence path), prune (blended-score cap).
//
// ── 2026-09-30 remediation ─────────────────────────────────────────────────────
// The audit found this module governed nothing, because a second, older pruner
// in prune.ts ran on every add while this one ran advisory-only. Three of the
// four stages were structurally incapable of firing:
//
//   1. Protection was an IDENTITY FUNCTION. `protectConfidence` defaulted to
//      0.9 — the corpus floor — so 200/200 rows passed. It could not
//      discriminate, so it could never be wrong, so the daily report read
//      green forever. Worse, confidence is self-asserted at write time.
//      Now DISABLED by default; protection is backed by observed reuse
//      (reinforced_count) and relative rank (protectTopFraction).
//   2. `protected == total` rendered as a clean green line. Now a RED FLAG in
//      `warnings` — a corpus with no eviction policy is not healthy.
//   3. decayWatch filtered `!protected`, so under blanket protection it could
//      never print a row — "(none)" was a tautology, not a measurement. It now
//      falls back to lowest-liveness-overall and says so in the report.
//   4. Supersession had no producer, so confidence was monotonic — UP only.
//
// Also added: admitCandidate() (items 1-2, the live P0), perDomainCap (10),
// and assessReadiness() (7) which gates --apply on evidence.

import * as fs from "node:fs";
import * as path from "node:path";
import { load as parseYaml, dump as stringifyYaml } from "./yaml-compat";
import { defaultStorePath, instinctsDir } from "./paths";


export interface LifecycleInstinct {
  id: string;
  trigger: string;
  action: string;
  domain: string;
  confidence: number;
  source?: string;
  reinforced_count?: number;
  /** Measure-link counter: turns in which the pattern was actually injected.
   *  Written only by use-flush.ts from the gate's use-journal. Distinct from
   *  reinforced_count, which stays evidence-gated. */
  times_injected?: number;
  /** Distinct prompt fingerprints behind times_injected. An agent loop that
   *  re-sends one message many times inflates turns but not distinct prompts, so
   *  this is the honest reach signal for a reuse-protection rule. */
  distinct_prompts?: number;
  last_seen: string;
  critical?: boolean;
  supersedes?: string;
  superseded_by?: string;
}

export interface LifecycleConfig {
  halfLifeDays: number;
  protectReinforced: number;
  protectTopFraction: number;
  protectConfidence: number; // extra floor; 0 = disabled
  protectInjected: number; // observed-reuse floor; 0 = disabled
  cap: number;
  perDomainCap: number; // 0 = off
  supersedeFactor: number;
  today: string;
}

export const DEFAULT_LIFECYCLE: Omit<LifecycleConfig, "today"> = {
  halfLifeDays: 30,
  protectReinforced: 8,
  protectTopFraction: 0.1,
  protectConfidence: 0, // DISABLED — was 0.9, the corpus floor
  protectInjected: 0, // DISABLED — observed reuse, promoted by the operator
  cap: 200,
  perDomainCap: 0,
  supersedeFactor: 0.5,
};

export interface Supersession {
  superseded: string;
  superseder: string;
  from: number;
  to: number;
}
export interface DecayRow {
  id: string;
  domain: string;
  age: number;
  liveness: number;
  blended: number;
  protected: boolean;
}
export interface DomainRow {
  domain: string;
  count: number;
  share: number;
  overCap: boolean;
}
/** A pattern with a measured injection history. This is the measure link made
 *  visible: reuse that was observed at the gate rather than asserted. */
export interface UseRow {
  id: string;
  domain: string;
  turns: number;
  /** Distinct prompt fingerprints behind `turns` in this cycle's window. */
  distinct: number;
  total: number;
  totalDistinct: number;
  lastSeen: string;
  age: number;
  liveness: number;
  protected: boolean;
}

export interface LifecyclePlan {
  today: string;
  total: number;
  working: LifecycleInstinct[];
  kept: LifecycleInstinct[];
  pruned: Array<{ id: string; domain: string; score: number }>;
  protectedIds: string[];
  supersessions: Supersession[];
  decayWatch: DecayRow[];
  decayScope: "unprotected" | "overall-fallback";
  warnings: string[];
  domainRows: DomainRow[];
  useRows: UseRow[];
  measuredTurns: number;
  measuredRows: number;
}

export interface Readiness {
  ready: boolean;
  blockers: string[];
  notes: string[];
}

export interface AdmissionResult {
  admitted: boolean;
  reason: string;
  evicted: Array<{ id: string; domain: string; score: number }>;
  plan: LifecyclePlan;
}

// ── primitives ─────────────────────────────────────────────────────────────────

export function ageInDays(lastSeen: string, today: string): number {
  const a = Date.parse(`${lastSeen}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function safeNum(
  raw: unknown,
  fallback: number,
  min = 0,
  max = 1e9,
): number {
  // undefined/null must return the fallback. Number(undefined) is NaN and
  // Number(null) is 0 — coercing before the guard would silently return 0
  // instead, which is how a fat-fingered flag becomes a real cap of zero.
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function liveness(
  i: LifecycleInstinct,
  today: string,
  halfLife: number,
): number {
  const age = ageInDays(i.last_seen, today);
  return Math.pow(0.5, age / halfLife);
}

export function blendedScore(i: LifecycleInstinct, c: LifecycleConfig): number {
  return i.confidence * liveness(i, c.today, c.halfLifeDays);
}

// ── protection ─────────────────────────────────────────────────────────────────

// A protected instinct is floored at its raw confidence, so a strong-but-quiet
// instinct never sorts below fresh noise. The floor is protection-AWARE: it
// reads the EFFECTIVE protected set when one is supplied, so a policy that
// protects nothing cannot accidentally floor everything.
export function keepScore(
  i: LifecycleInstinct,
  c: LifecycleConfig,
  protectedSet?: ReadonlySet<string>,
): number {
  const blended = blendedScore(i, c);
  const shielded =
    protectedSet !== undefined ? protectedSet.has(i.id) : isProtected(i, c);
  return shielded ? Math.max(blended, i.confidence) : blended;
}

export function isProtected(
  i: LifecycleInstinct,
  c: LifecycleConfig,
): boolean {
  if (i.critical) return true;
  if ((i.reinforced_count ?? 0) >= c.protectReinforced) return true;
  if (c.protectInjected > 0 && (i.times_injected ?? 0) >= c.protectInjected) return true;
  if (c.protectConfidence > 0 && i.confidence >= c.protectConfidence) return true;
  return false;
}

// Row-local rules PLUS the top `protectTopFraction` by blended score. The
// relative term is what makes protection relative: on a corpus of 200 it
// protects exactly 20 regardless of how anyone typed their confidence.
export function buildProtectedSet(
  instincts: LifecycleInstinct[],
  cfg: LifecycleConfig,
): Set<string> {
  const set = new Set<string>();
  for (const i of instincts) {
    if (isProtected(i, cfg)) set.add(i.id);
  }
  if (instincts.length > 0 && cfg.protectTopFraction > 0) {
    const n = Math.max(
      1,
      Math.round(instincts.length * cfg.protectTopFraction),
    );
    for (const i of [...instincts]
      .sort(
        (a, b) =>
          blendedScore(b, cfg) - blendedScore(a, cfg) ||
          b.id.localeCompare(a.id),
      )
      .slice(0, n)) {
      set.add(i.id);
    }
  }
  return set;
}

// ── the plan ───────────────────────────────────────────────────────────────────

export function planLifecycle(
  input: LifecycleInstinct[],
  cfg: LifecycleConfig,
): LifecyclePlan {
  const working: LifecycleInstinct[] = input.map((i) => ({ ...i }));
  const total = working.length;
  const protectedSet = buildProtectedSet(working, cfg);
  const supersessions: Supersession[] = [];

  // Stage 3 — supersession: the only downward confidence path. Idempotent,
  // because a stamped `superseded_by` means "already demoted".
  for (const row of working) {
    if (!row.supersedes) continue;
    const target = working.find((t) => t.id === row.supersedes);
    if (!target) continue;
    if (target.superseded_by) continue;
    const from = target.confidence;
    const to = Number((from * cfg.supersedeFactor).toFixed(4));
    target.confidence = to;
    target.superseded_by = row.id;
    supersessions.push({
      superseded: target.id,
      superseder: row.id,
      from,
      to,
    });
  }

  // Stage 4 — prune by blended score, with a floor for protected rows so a
  // strong-but-quiet instinct never sorts below fresh noise.
  const scoreOf = (i: LifecycleInstinct): number =>
    protectedSet.has(i.id) ? Math.max(i.confidence, blendedScore(i, cfg)) : blendedScore(i, cfg);

  const kept = [...working].sort(
    (a, b) => scoreOf(b) - scoreOf(a) || b.id.localeCompare(a.id),
  );
  const pruned: Array<{ id: string; domain: string; score: number }> = [];
  if (kept.length > cfg.cap) {
    for (const victim of kept.splice(cfg.cap)) {
      pruned.push({
        id: victim.id,
        domain: victim.domain,
        score: Number(blendedScore(victim, cfg).toFixed(4)),
      });
    }
  }

  // Stage 4b — per-domain allocation. A flat global cap is a budget with no
  // allocation policy: one noisy domain (31 rows on zsf) can crowd out the rest.
  if (cfg.perDomainCap > 0) {
    const byDomain = new Map<string, LifecycleInstinct[]>();
    for (const i of kept) {
      const arr = byDomain.get(i.domain) ?? [];
      arr.push(i);
      byDomain.set(i.domain, arr);
    }
    const drop = new Set<string>();
    for (const arr of byDomain.values()) {
      if (arr.length <= cfg.perDomainCap) continue;
      for (const victim of arr.slice(cfg.perDomainCap)) {
        drop.add(victim.id);
        pruned.push({
          id: victim.id,
          domain: victim.domain,
          score: Number(blendedScore(victim, cfg).toFixed(4)),
        });
      }
    }
    if (drop.size > 0) {
      for (let i = kept.length - 1; i >= 0; i--) {
        if (drop.has(kept[i].id)) kept.splice(i, 1);
      }
    }
  }

  // Stage 2b — decay watch. Falls back to lowest-overall so there is ALWAYS
  // an observable ranking, even under blanket protection.
  const rank = (i: LifecycleInstinct): DecayRow => {
    const age = ageInDays(i.last_seen, cfg.today);
    return {
      id: i.id,
      domain: i.domain,
      age,
      liveness: Number(liveness(i, cfg.today, cfg.halfLifeDays).toFixed(4)),
      blended: Number(blendedScore(i, cfg).toFixed(4)),
      protected: protectedSet.has(i.id),
    };
  };
  const all = working.map(rank).sort(
    (a, b) => a.liveness - b.liveness || a.blended - b.blended,
  );
  const unprotected = all.filter((r) => !r.protected);
  const decayScope: "unprotected" | "overall-fallback" =
    unprotected.length > 0 ? "unprotected" : "overall-fallback";
  const decayWatch = (unprotected.length > 0 ? unprotected : all).slice(0, 5);

  // Stage 5 — measured use. `times_injected` is written by use-flush.ts from the
  // gate's use-journal, so this is the only reuse figure in the plan that no one
  // can assert by hand. It never feeds confidence; it feeds visibility, and (when
  // the operator sets --protect-injected) protection.
  const measured = working.filter((i) => (i.times_injected ?? 0) > 0);
  const useRows: UseRow[] = measured
    .map((i) => {
      const age = ageInDays(i.last_seen, cfg.today);
      return {
        id: i.id,
        domain: i.domain,
        turns: i.times_injected ?? 0,
        distinct: i.distinct_prompts ?? 0,
        total: working
          .filter((o) => o.id === i.id)
          .reduce((n, o) => n + (o.times_injected ?? 0), 0),
        totalDistinct: working
          .filter((o) => o.id === i.id)
          .reduce((n, o) => n + (o.distinct_prompts ?? 0), 0),
        lastSeen: i.last_seen,
        age,
        liveness: Number(liveness(i, cfg.today, cfg.halfLifeDays).toFixed(4)),
        protected: protectedSet.has(i.id),
      };
    })
    .sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id))
    .slice(0, 10);

  // Diagnostics — the checks that would have caught this on day one.
  const warnings: string[] = [];
  if (total > 0 && measured.length === 0) {
    warnings.push(
      "Measure link is dark: 0/" + total + " instincts have an injection count. " +
        "The gate is not journaling use (or the journal has never been flushed) — " +
        "run use-flush.ts --dry-run to check the journal path.",
    );
  }
  if (total > 0 && protectedSet.size === total) {
    warnings.push(
      `RED FLAG: ${protectedSet.size}/${total} protected (100%). Protection is an ` +
        `identity function — it cannot discriminate, so the eviction policy is inert.`,
    );
  }
  if (total > 0 && protectedSet.size / total > 0.5) {
    warnings.push(
      `RED FLAG: >50% of the corpus is protected (${protectedSet.size}/${total}); ` +
        `eviction pressure is structurally suppressed.`,
    );
  }
  const domainRows: DomainRow[] = [...new Set(working.map((i) => i.domain))]
    .map((domain) => {
      const count = working.filter((i) => i.domain === domain).length;
      return {
        domain,
        count,
        share: total > 0 ? count / total : 0,
        overCap: cfg.perDomainCap > 0 && count > cfg.perDomainCap,
      };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  const topDomain = domainRows[0];
  if (topDomain && total >= 20 && topDomain.share > 0.25) {
    warnings.push(
      `Domain crowding: "${topDomain.domain}" holds ${topDomain.count}/${total} ` +
        `(${Math.round(topDomain.share * 100)}%) of the corpus.` +
        (cfg.perDomainCap > 0
          ? ""
          : ` Set --per-domain-cap to enforce an allocation policy.`),
    );
  }
  const stale = working.filter(
    (i) => ageInDays(i.last_seen, cfg.today) >= 60,
  ).length;
  if (stale > 0) {
    warnings.push(`${stale} instincts are 60d+ stale (last_seen never advanced).`);
  }
  const unmeasured = working.filter((i) => (i.reinforced_count ?? 0) <= 1).length;
  const observed = working.filter((i) => (i.times_injected ?? 0) > 0).length;
  if (total > 0 && unmeasured / total > 0.5) {
    warnings.push(
      `${unmeasured}/${total} instincts have reinforced_count <= 1 — reinforcement is ` +
        `unmeasured, so reinforce-based protection is unreachable by construction. ` +
        `Observed reuse is tracked separately and separately measured: ${observed}/${total} ` +
        `rows carry an injection history (--protect-injected, off by default).`,
    );
  }
  if (decayScope === "overall-fallback") {
    warnings.push(
      `Decay watch fell back to lowest-overall: no unprotected instincts exist.`,
    );
  }

  return {
    today: cfg.today,
    total,
    working,
    kept,
    pruned,
    protectedIds: [...protectedSet],
    supersessions,
    decayWatch,
    decayScope,
    warnings,
    domainRows,
    useRows,
    measuredTurns: measured.reduce((n, i) => n + (i.times_injected ?? 0), 0),
    measuredRows: measured.length,
  };
}

// ── admission (items 1 + 2 — the live P0) ──────────────────────────────────────

// Answers: if this candidate were appended, would it survive? The old add path
// answered "no", printed "added", and exited 0 — creating the instinct and
// destroying it in the same invocation. A candidate that cannot survive must be
// REJECTED loudly, never silently dropped.
export function admitCandidate(
  existing: LifecycleInstinct[],
  candidate: LifecycleInstinct,
  cfg: LifecycleConfig,
): AdmissionResult {
  const store = existing.map((i) => ({ ...i }));
  const combined = [...store, { ...candidate }];
  const planned = planLifecycle(combined, cfg);

  if (existing.length < cfg.cap) {
    return {
      admitted: true,
      reason: `store under cap (${existing.length}/${cfg.cap})`,
      evicted: [],
      plan: planned,
    };
  }

  // ITEM 2 — critical rows get a fast path: evict the weakest NON-critical row
  // instead of ranking the newcomer away. A `critical: true` instinct that can
  // never get in is protection that does not protect.
  if (candidate.critical === true) {
    const victim = combined
      .filter(
        (i) =>
          i.id !== candidate.id &&
          i.critical !== true &&
          !planned.protectedIds.includes(i.id),
      )
      .sort(
        (a, b) =>
          blendedScore(a, cfg) - blendedScore(b, cfg) ||
          b.id.localeCompare(a.id),
      )[0];

    if (!victim) {
      return {
        admitted: false,
        reason:
          `store at cap (${existing.length}/${cfg.cap}) and every row is protected or ` +
          `critical — no non-critical row available to evict. Run lifecycle.ts --apply ` +
          `to prune the weakest rows first, then retry.`,
        evicted: [],
        plan: planned,
      };
    }

    // Build from the ORIGINAL store minus the victim. Deriving from
    // planned.kept would double-count the candidate (kept already contains it)
    // and cause a spurious second prune.
    const nextPlan = planLifecycle(
      [...store.filter((i) => i.id !== victim.id), { ...candidate }],
      cfg,
    );
    return {
      admitted: true,
      reason:
        `store at cap; critical instinct admitted by evicting weakest non-critical ` +
        `row ${victim.id} (domain=${victim.domain})`,
      evicted: [
        {
          id: victim.id,
          domain: victim.domain,
          score: Number(blendedScore(victim, cfg).toFixed(4)),
        },
      ],
      plan: nextPlan,
    };
  }

  // ITEM 1 — refuse. Critically, the returned plan is built from the store
  // ALONE: a rejected candidate must leave the store byte-identical, so the
  // plan a caller writes can never contain the rejected row.
  return {
    admitted: false,
    reason:
      `store at cap (${existing.length}/${cfg.cap}) — refusing to admit an instinct the ` +
      `pruner would immediately evict. Run lifecycle.ts --apply to prune the weakest ` +
      `rows, then retry. Candidate was ${candidate.id} [${candidate.domain}] ` +
      `trigger="${candidate.trigger}"`,
    evicted: [],
    plan: planLifecycle(store, cfg),
  };
}

// ── item 7: --apply is gated on evidence, not on optimism ──────────────────────

export function assessReadiness(
  plan: LifecyclePlan,
  cfg: LifecycleConfig,
  cyclesWithSignal = 0,
): Readiness {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (plan.decayWatch.length === 0) {
    blockers.push("decay watch is empty — the lifecycle cannot see any signal");
  }
  if (plan.total > 0 && plan.protectedIds.length / plan.total > 0.5) {
    blockers.push(
      `eviction pressure suppressed (${plan.protectedIds.length}/${plan.total} protected)`,
    );
  }
  if (plan.supersessions.length === 0) {
    // Wording must not blame an absent producer: `supersede.ts` exists and is
    // proposal-only by design (a wrong demotion corrupts a pattern), so the
    // blocker is "no marker reviewed yet", not "nothing can write markers".
    blockers.push(
      "no supersession marker has been reviewed and applied yet — confidence " +
        "is still monotonic (UP only). Run observer.ts supersede-candidates " +
        "and apply a reviewed pair.",
    );
  }
  if (cyclesWithSignal < 3) {
    blockers.push(
      `decay watch has been non-empty for only ${cyclesWithSignal} consecutive ` +
        `cycle(s); require 3 before enforcing`,
    );
  }
  if (plan.warnings.some((w) => w.includes("reinforce-based protection"))) {
    notes.push(
      "reinforce-based protection is unreachable: reinforced_count is unmeasured. " +
        `Observed reuse IS now measured (${plan.measuredRows}/${plan.total} rows, ` +
        `${plan.measuredTurns} injections) and is available via --protect-injected; ` +
        "reinforced_count stays evidence-gated on purpose, because injection is " +
        "reach, not correctness.",
    );
  }
  return { ready: blockers.length === 0, blockers, notes };
}

// ── report ─────────────────────────────────────────────────────────────────────

export function renderReport(
  plan: LifecyclePlan,
  cfg: LifecycleConfig,
  applied: boolean,
  readiness?: Readiness,
  refused = false,
): string {
  const o: string[] = [];
  const dcap = cfg.perDomainCap > 0 ? String(cfg.perDomainCap) : "off";
  const pconf = cfg.protectConfidence > 0 ? String(cfg.protectConfidence) : "off";
  o.push(`# Instinct Lifecycle — ${cfg.today}`);
  o.push("");
  o.push(
    `**Mode:** ${refused ? "REFUSED" : applied ? "APPLIED" : "ADVISORY"} (` +
      `${refused ? "--apply requested but readiness gate blocked all writes" : applied ? "mutated" : "dry-run — no writes"})`,
  );
  o.push(
    `**Config:** half-life ${cfg.halfLifeDays}d · protect critical || reinforced ≥ ` +
      `${cfg.protectReinforced} || top ${Math.round(cfg.protectTopFraction * 100)}% by ` +
      `blended score · conf floor ${pconf} · observed-reuse floor ` +
      `${cfg.protectInjected > 0 ? `≥ ${cfg.protectInjected}` : "off"} · cap ${cfg.cap} · ` +
      `per-domain cap ${dcap} · supersede ×${cfg.supersedeFactor}`,
  );
  o.push("");
  o.push(
    `**Summary:** ${plan.total} instincts · ${plan.protectedIds.length} protected · ` +
      `${plan.supersessions.length} superseded · ${plan.pruned.length} pruned · ` +
      `${plan.kept.length} kept`,
  );
  o.push("");

  if (plan.warnings.length > 0) {
    o.push("## Diagnostics");
    for (const w of plan.warnings) o.push(`- ${w}`);
    o.push("");
  }

  if (plan.supersessions.length > 0) {
    o.push("## Supersession (confidence demotions)");
    for (const s of plan.supersessions) {
      o.push(`- ${s.superseded} ${s.from} → ${s.to} (superseded by ${s.superseder})`);
    }
    o.push("");
  }

  if (plan.pruned.length > 0) {
    o.push("## Pruned (over cap)");
    for (const p of plan.pruned) {
      o.push(`- ${p.id} [${p.domain}] keep-score ${p.score}`);
    }
    o.push("");
  }

  o.push(
    plan.decayScope === "overall-fallback"
      ? "## Decay watch (lowest liveness — fallback: every instinct is protected)"
      : `## Decay watch (lowest liveness, ${
          plan.protectedIds.length === 0
            ? "no row is protected"
            : "unprotected"
        })`,
  );
  if (plan.decayWatch.length === 0) {
    o.push("- (none)");
  } else {
    for (const r of plan.decayWatch) {
      o.push(
        `- ${r.id} [${r.domain}] age ${r.age}d · liveness ${r.liveness} · ` +
          `blended ${r.blended}${r.protected ? " · protected" : ""}`,
      );
    }
  }
  o.push("");

  o.push("## Measured use (reinforcement observed at the gate)");
  if (plan.useRows.length === 0) {
    o.push(
      "- (none) — no instinct has an injection count yet. The measure link is " +
        "installed but has seen no traffic; check the use-journal path.",
    );
  } else {
    o.push(
      `${plan.measuredRows}/${plan.total} instincts have a measured injection ` +
        `history (${plan.measuredTurns} injections recorded).`,
    );
    o.push("");
    o.push(
      "Turns are raw injection events; distinct prompts are unique message " +
        "fingerprints behind them, so a re-sent prompt cannot pass for breadth.",
    );
    o.push("");
    o.push("| instinct | domain | injections | distinct prompts | last seen | age | liveness | protected |");
    o.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const u of plan.useRows) {
      o.push(
        `| ${u.id} | ${u.domain} | ${u.turns} | ${u.distinct} | ${u.lastSeen} | ${u.age}d | ` +
          `${u.liveness} | ${u.protected ? "yes" : "no"} |`,
      );
    }
  }
  o.push("");

  if (plan.domainRows.length > 0) {
    o.push("## Domain allocation");
    o.push("| domain | count | share | over cap |");
    o.push("| --- | --- | --- | --- |");
    for (const d of plan.domainRows.slice(0, 10)) {
      o.push(
        `| ${d.domain} | ${d.count} | ${Math.round(d.share * 100)}% | ${d.overCap ? "yes" : "no"} |`,
      );
    }
    if (plan.domainRows.length > 10) {
      o.push(`| … ${plan.domainRows.length - 10} more domains | | | |`);
    }
    o.push("");
  }

  if (readiness) {
    o.push("## Readiness to enforce (--apply gate)");
    o.push(
      readiness.ready
        ? "**READY** — the lifecycle can see signal; --apply is permitted."
        : "**NOT READY** — --apply will refuse to mutate until these clear:",
    );
    for (const b of readiness.blockers) o.push(`- blocker: ${b}`);
    for (const n of readiness.notes) o.push(`- note: ${n}`);
    o.push("");
  }

  if (plan.supersessions.length === 0 && plan.pruned.length === 0) {
    o.push(
      refused
        ? "_Enforcement was requested and REFUSED: no mutation was written. Clear the blockers above before trusting this store._"
        : applied
          ? "_Applied, but no supersession or prune was required this cycle._"
        : "_No mutations required this cycle. This line is a no-op report, not " +
            "evidence of health — read Diagnostics and Readiness above._",
    );
  } else if (!applied) {
    o.push("_Advisory only — pass --apply to mutate._");
  }

  return o.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────────

export function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

/**
 * js-yaml resolves an UNQUOTED `2026-06-21` to a Date, and every consumer of
 * `last_seen` treats it as a string. A Date therefore reads as age 0, which is
 * maximum liveness: a single unquoted row would outrank the whole corpus and
 * could be framed as the healthiest pattern in the store. Coerce at the boundary.
 */
export function normalizeYmd(v: unknown): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const m = v.match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : "";
  }
  return "";
}

export function loadStore(p: string): LifecycleInstinct[] {
  if (!fs.existsSync(p)) return [];
  const doc = parseYaml(fs.readFileSync(p, "utf8")) as {
    instincts?: LifecycleInstinct[];
  };
  if (!Array.isArray(doc?.instincts)) return [];
  return doc.instincts.map((i) => ({
    ...i,
    last_seen: normalizeYmd((i as { last_seen?: unknown }).last_seen),
  }));
}

export function saveStore(p: string, rows: LifecycleInstinct[]): void {
  const doc = { instincts: rows, updated: new Date().toISOString() };
  fs.writeFileSync(p, stringifyYaml(doc), "utf8");
}

// Counts consecutive recent reports whose decay watch was non-empty, so the
// --apply gate can require that the lifecycle has been seeing real signal.
export function countCyclesWithSignal(reportsDir: string, today: string): number {
  if (!fs.existsSync(reportsDir)) return 0;
  const days: string[] = [];
  const start = Date.parse(`${today}T00:00:00Z`);
  for (let i = 0; i < 30; i++) {
    days.push(new Date(start - i * 86_400_000).toISOString().slice(0, 10));
  }
  let n = 0;
  for (const d of days) {
    const f = path.join(reportsDir, `${d}.md`);
    if (!fs.existsSync(f)) break;
    const txt = fs.readFileSync(f, "utf8");
    if (/## Decay watch[\s\S]*?\n- \(none\)/.test(txt)) break;
    n++;
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: lifecycle.ts [--apply] [--report PATH] [--store PATH] [--half-life 30] [--protect-reinforced 8] [--protect-top 0.10] [--protect-conf 0] [--cap 200] [--per-domain-cap N] [--today YYYY-MM-DD] [--protect-injected 0] [--no-use-flush]");
    process.exit(0);
  }
  const apply = args.includes("--apply") || process.env.INSTINCT_LIFECYCLE_ENFORCE === "1";
  const cfg: LifecycleConfig = {
    today: argVal(args, "--today") ?? new Date().toISOString().slice(0, 10),
    ...DEFAULT_LIFECYCLE,
    halfLifeDays: safeNum(argVal(args, "--half-life"), DEFAULT_LIFECYCLE.halfLifeDays, 1),
    protectReinforced: safeNum(
      argVal(args, "--protect-reinforced"),
      DEFAULT_LIFECYCLE.protectReinforced,
      0,
    ),
    protectTopFraction: safeNum(
      argVal(args, "--protect-top"),
      DEFAULT_LIFECYCLE.protectTopFraction,
      0,
      1,
    ),
    protectConfidence: safeNum(argVal(args, "--protect-conf"), 0, 0, 1),
    protectInjected: safeNum(argVal(args, "--protect-injected"), 0, 0),
    cap: Math.floor(safeNum(argVal(args, "--cap"), DEFAULT_LIFECYCLE.cap, 1)),
    perDomainCap: Math.floor(safeNum(argVal(args, "--per-domain-cap"), 0, 0)),
    supersedeFactor: safeNum(argVal(args, "--supersede-factor"), 0.5, 0, 1),
  };

  const storePath =
    argVal(args, "--store") ??
    process.env.INSTINCT_STORE_PATH ??
    defaultStorePath();
  const reportPath =
    argVal(args, "--report") ??
    path.join(instinctsDir(), "lifecycle-reports", `${cfg.today}.md`);

  // ── measure link ───────────────────────────────────────────────────────────
  // Drain the gate's use-journal into the store BEFORE planning, so the liveness
  // this report reasons about reflects patterns that were actually injected. The
  // flush is measurement, not enforcement: it moves `last_seen` forward and adds
  // `times_injected`, and touches neither confidence nor any row's membership.
  if (!args.includes("--no-use-flush")) {
    const { flushUseJournal } = await import("./use-flush.ts");
    const fr = flushUseJournal({
      storePath,
      dryRun: args.includes("--dry-run-use"),
    });
    if (fr.linesRead > 0) {
      console.log(
        `[lifecycle] measure link: ${fr.turns} turns, ${fr.updated.length} rows ` +
          `updated, ${fr.unknown.length} unknown ids${fr.dryRun ? " (dry-run)" : ""}`,
      );
    }
  }

  const plan = planLifecycle(loadStore(storePath), cfg);
  const readiness = assessReadiness(
    plan,
    cfg,
    countCyclesWithSignal(path.dirname(reportPath), cfg.today),
  );
  // ITEM 7 — enforcement is gated on evidence, not on a flag. `applied` must
  // describe what ACTUALLY happened: a refused run is neither "applied" nor a
  // clean "advisory" pass, and reporting it as applied is a false success
  // claim (the bug this whole remediation exists to remove).
  const refused = apply && !readiness.ready;
  const didApply = apply && readiness.ready;
  const md = renderReport(plan, cfg, didApply, readiness, refused);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, md, "utf8");

  if (didApply) {
    saveStore(storePath, plan.kept);
    console.log(
      `[lifecycle] applied: ${plan.kept.length} kept, ${plan.pruned.length} pruned, ` +
        `${plan.supersessions.length} superseded`,
    );
  } else if (refused) {
    // Fail closed: an unready lifecycle must not mutate the store, and the
    // non-zero exit makes the daily job notice rather than read the report.
    console.error("[lifecycle] REFUSING to apply — readiness gate not met:");
    for (const b of readiness.blockers) console.error(`  - ${b}`);
    console.error("[lifecycle] advisory report still written for review");
    console.log(md);
    process.exit(1);
  }
  console.log(md);
}
