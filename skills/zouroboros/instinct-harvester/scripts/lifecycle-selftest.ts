// ZOU-556 instinct-harvester lifecycle selftest — deterministic, no LLM, no I/O.
//   bun lifecycle-selftest.ts   (exit 0 = all pass)
//
// Pure-logic only: planLifecycle et al. never touch the live store, so unlike
// the main selftest there is no temp-path / ESM-hoisting hazard here.
//
// 2026-09-30: rewritten after the lifecycle-policy remediation (audit items
// 1-10). The prior suite encoded the DEFECTIVE policy — it asserted that
// confidence alone protects an instinct, and that the decay watch excludes
// protected rows. Both assertions are now inverted on purpose: a test suite
// that pins an identity function as correct is how the store sat frozen at 200
// for weeks while every daily report read green.

import type { Instinct } from "./merge";
import {
  findSupersessionCandidates,
  triggerStem,
} from "./supersede";
import {
  ageInDays,
  liveness,
  isProtected,
  blendedScore,
  buildProtectedSet,
  keepScore,
  planLifecycle,
  admitCandidate,
  assessReadiness,
  renderReport,
  safeNum,
  DEFAULT_LIFECYCLE,
  type LifecycleConfig,
  type LifecycleInstinct,
} from "./lifecycle";

let pass = 0;
let fail = 0;
function ck(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const TODAY = "2026-07-10";
const cfg = (over: Partial<LifecycleConfig> = {}): LifecycleConfig => ({
  today: TODAY,
  ...DEFAULT_LIFECYCLE,
  ...over,
});

const base = (over: Partial<LifecycleInstinct> = {}): LifecycleInstinct => ({
  id: "inst_001",
  trigger: "when X",
  action: "do Z",
  domain: "evaluation",
  confidence: 0.7,
  source: "session-observation",
  reinforced_count: 1,
  last_seen: TODAY,
  ...over,
});

// --- ageInDays ---
ck("age same day", ageInDays(TODAY, TODAY), 0);
ck("age 30d", ageInDays("2026-06-10", TODAY), 30);
ck("age future clamps to 0", ageInDays("2026-08-01", TODAY), 0);
ck("age invalid → 0", ageInDays("not-a-date", TODAY), 0);

// --- safeNum (CLI boundary numeric guard against fat-finger data loss) ---
ck("safeNum passes finite string", safeNum("30", 99), 30);
ck("safeNum passes number", safeNum(30, 99), 30);
ck("safeNum NaN → fallback", safeNum("abc", 99), 99);
ck("safeNum undefined → fallback", safeNum(undefined, 99), 99);
ck("safeNum null → fallback", safeNum(null, 99), 99);
ck("safeNum empty string → fallback", safeNum("", 200, 1), 200);
ck("safeNum below min → fallback", safeNum("-1", 200, 1), 200);
ck("safeNum zero cap below min1 → fallback", safeNum("0", 200, 1), 200);
ck("safeNum in range passes", safeNum("0.5", 0.5, 0, 1), 0.5);
ck("safeNum above max → fallback (supersede >1 can't invert)", safeNum("1.5", 0.5, 0, 1), 0.5);

// --- liveness (half-life curve) ---
ck("liveness age0 = 1", liveness(base({ last_seen: TODAY }), TODAY, 30), 1);
ck("liveness one half-life = 0.5", liveness(base({ last_seen: "2026-06-10" }), TODAY, 30), 0.5);
ck("liveness two half-lives = 0.25", liveness(base({ last_seen: "2026-05-11" }), TODAY, 30), 0.25);
ck("liveness never touches confidence", base({ confidence: 0.7 }).confidence, 0.7);

// --- blendedScore is protection-free (so rank protection isn't circular) ---
ck(
  "blendedScore = conf · liveness",
  blendedScore(base({ confidence: 0.6, last_seen: "2026-06-10" }), cfg()),
  0.3,
);

// =============================================================================
// ITEM 3 — protection is RELATIVE, not absolute.
// Confidence is a self-asserted birth-time tag; on its own it must not protect.
// =============================================================================
ck("ITEM3: high conf alone does NOT protect", isProtected(base({ confidence: 0.95 }), cfg()), false);
ck("ITEM3: the 0.9 floor that protected 200/200 is now off", isProtected(base({ confidence: 0.9 }), cfg()), false);
ck("ITEM3: explicit conf floor re-enables it (opt-in)", isProtected(base({ confidence: 0.95 }), cfg({ protectConfidence: 0.9 })), true);
ck("protected by critical flag", isProtected(base({ confidence: 0.3, critical: true }), cfg()), true);
ck("protected by reinforced count", isProtected(base({ confidence: 0.5, reinforced_count: 8 }), cfg()), true);
ck("not protected (weak/quiet)", isProtected(base({ confidence: 0.6, reinforced_count: 2 }), cfg()), false);

// --- ITEM 3 (rank half): top-N by blended score is protected ---
const rankSet = [
  base({ id: "inst_hi", confidence: 0.95, last_seen: TODAY }),
  base({ id: "inst_lo", confidence: 0.5, last_seen: "2026-01-01" }),
];
ck(
  "ITEM3: top 10% (min 1) protected by rank",
  [...buildProtectedSet(rankSet, cfg({ protectTopFraction: 0.1 }))],
  ["inst_hi"],
);
ck(
  "ITEM3: top 50% protects half",
  [
    ...buildProtectedSet(
      [
        base({ id: "a", confidence: 0.9, last_seen: TODAY }),
        base({ id: "b", confidence: 0.8, last_seen: TODAY }),
        base({ id: "c", confidence: 0.7, last_seen: TODAY }),
        base({ id: "d", confidence: 0.6, last_seen: TODAY }),
      ],
      cfg({ protectTopFraction: 0.5, today: TODAY }),
    ),
  ].length,
  2,
);
ck(
  "ITEM3: rank protection off when fraction is 0",
  [...buildProtectedSet(rankSet, cfg({ protectTopFraction: 0 }))],
  [],
);

// --- keepScore: protected rows get a floor at their own confidence ---
ck(
  "keepScore unprotected = blended",
  keepScore(base({ confidence: 0.6, last_seen: "2026-06-10" }), cfg()),
  0.3,
);
ck(
  "keepScore protected floored at confidence",
  keepScore(base({ confidence: 0.95, last_seen: "2026-05-11", critical: true }), cfg()) >= 0.95,
  true,
);
ck(
  "keepScore strong-but-quiet WITHOUT protection now decays",
  keepScore(base({ confidence: 0.95, last_seen: "2026-01-01" }), cfg()) < 0.95,
  true,
);
ck(
  "keepScore honours an explicit effective protected set",
  keepScore(
    base({ id: "z", confidence: 0.95, last_seen: "2026-01-01" }),
    cfg(),
    new Set(["z"]),
  ) >= 0.95,
  true,
);

// =============================================================================
// planLifecycle — supersession (unchanged, must not regress)
// =============================================================================
const clean = [
  base({ id: "inst_001", confidence: 0.8 }),
  base({ id: "inst_002", confidence: 0.6, domain: "infra" }),
];
const p1 = planLifecycle(clean, cfg());
ck("clean: nothing superseded", p1.supersessions.length, 0);
ck("clean: nothing pruned", p1.pruned.length, 0);
ck("clean: all kept", p1.kept.length, 2);
ck("clean: input not mutated", clean[0].confidence, 0.8);

const withMarker = [
  base({ id: "inst_010", confidence: 0.8, action: "old wrong action" }),
  base({ id: "inst_011", confidence: 0.85, action: "new correct action", supersedes: "inst_010" }),
];
const p2 = planLifecycle(withMarker, cfg());
ck("supersede recorded", p2.supersessions.map((s) => [s.superseded, s.from, s.to]), [["inst_010", 0.8, 0.4]]);
const demoted = p2.kept.find((i) => i.id === "inst_010");
ck("supersede: target demoted", demoted?.confidence, 0.4);
ck("supersede: target stamped", demoted?.superseded_by, "inst_011");
ck("supersede: input untouched", withMarker[0].confidence, 0.8);

const p2b = planLifecycle(p2.kept, cfg());
ck("supersede idempotent (no re-demote)", p2b.supersessions.length, 0);
ck("supersede idempotent: confidence stable", p2b.kept.find((i) => i.id === "inst_010")?.confidence, 0.4);

const doubleSup = [
  base({ id: "inst_030", confidence: 0.8 }),
  base({ id: "inst_031", confidence: 0.85, supersedes: "inst_030" }),
  base({ id: "inst_032", confidence: 0.88, supersedes: "inst_030" }),
];
const p5 = planLifecycle(doubleSup, cfg());
ck("double-supersede: demoted once only", p5.supersessions.length, 1);
ck("double-supersede: first superseder wins pointer", p5.kept.find((i) => i.id === "inst_030")?.superseded_by, "inst_031");
ck("double-supersede: confidence demoted once (0.8→0.4)", p5.kept.find((i) => i.id === "inst_030")?.confidence, 0.4);

const dangling = [base({ id: "inst_020", supersedes: "inst_999" })];
ck("dangling supersedes → no-op", planLifecycle(dangling, cfg()).supersessions.length, 0);

// --- prune over cap keeps highest keep-score, protects strong ---
const many: LifecycleInstinct[] = [
  // protected via critical, ancient — MUST survive
  base({ id: "inst_100", confidence: 0.95, last_seen: "2026-01-01", critical: true }),
  ...Array.from({ length: 5 }, (_, i) =>
    base({ id: `inst_2${i}`, confidence: 0.5 + i * 0.02, last_seen: TODAY, domain: "infra" }),
  ),
];
const p3 = planLifecycle(many, cfg({ cap: 3 }));
ck("prune: kept capped (protected may exceed)", p3.kept.length >= 3, true);
ck("prune: ancient-but-critical survived", p3.kept.some((i) => i.id === "inst_100"), true);
ck("prune: something evicted over cap", p3.pruned.length, 3);
const prunedIds = new Set(p3.pruned.map((p) => p.id));
ck("prune: protected never pruned", prunedIds.has("inst_100"), false);

// =============================================================================
// ITEM 5 — decay watch falls back to lowest-overall under blanket protection.
// The old filter (exclude protected) had a provably empty domain on the live
// store, so "(none)" was a tautology rather than a measurement.
// =============================================================================
const mix = [
  base({ id: "inst_a", confidence: 0.6, last_seen: "2026-04-11" }), // oldest, low liveness
  base({ id: "inst_b", confidence: 0.6, last_seen: TODAY }), // fresh
  base({ id: "inst_c", confidence: 0.95, last_seen: "2026-01-01", critical: true }), // protected
];
const p4 = planLifecycle(mix, cfg());
ck("ITEM5: watch excludes protected when unprotected rows exist", p4.decayWatch.some((d) => d.id === "inst_c"), false);
ck("ITEM5: watch is lowest liveness first", p4.decayWatch[0]?.id, "inst_a");
ck("ITEM5: scope = unprotected", p4.decayScope, "unprotected");

// Blanket protection: every row critical → old code printed "(none)".
const blanket = [
  base({ id: "inst_x", confidence: 0.9, last_seen: "2026-01-01", critical: true }),
  base({ id: "inst_y", confidence: 0.9, last_seen: TODAY, critical: true }),
];
const pBlank = planLifecycle(blanket, cfg());
ck("ITEM5: fallback scope recorded", pBlank.decayScope, "overall-fallback");
ck("ITEM5: fallback yields a real ranking, not (none)", pBlank.decayWatch.length, 2);
ck("ITEM5: fallback puts the most-dead row first", pBlank.decayWatch[0]?.id, "inst_x");
ck(
  "ITEM5: fallback warns about itself",
  pBlank.warnings.some((w) => w.includes("fell back to lowest-overall")),
  true,
);

// =============================================================================
// ITEM 4 — protected == total is a RED FLAG, not a clean line.
// =============================================================================
const allProtected = [
  base({ id: "i1", critical: true }),
  base({ id: "i2", critical: true }),
  base({ id: "i3", critical: true }),
];
const pAllProt = planLifecycle(allProtected, cfg());
ck(
  "ITEM4: 100% protection raises the identity-function red flag",
  pAllProt.warnings.some((w) => w.includes("RED FLAG") && w.includes("identity function")),
  true,
);
const halfProt = planLifecycle(
  [
    base({ id: "h1", critical: true }),
    base({ id: "h2", critical: true }),
    base({ id: "h3" }),
    base({ id: "h4" }),
  ],
  cfg(),
);
ck(
  "ITEM4: >50% protection raises a red flag",
  halfProt.warnings.some((w) => w.includes("RED FLAG") && w.includes(">50%")),
  true,
);
ck(
  "ITEM4: healthy corpus raises no protection red flag",
  planLifecycle(clean, cfg({ protectTopFraction: 0 })).warnings.some((w) => w.includes("RED FLAG")),
  false,
);

// Other diagnostics the old report never emitted
ck(
  "warns when reuse is unmeasured (reinforce not wired)",
  planLifecycle(
    Array.from({ length: 30 }, (_, i) => base({ id: `u${i}` })),
    cfg({ protectTopFraction: 0 }),
  ).warnings.some((w) => w.includes("reinforced_count <= 1")),
  true,
);
ck(
  "warns when the corpus is stale",
  planLifecycle(
    Array.from({ length: 5 }, (_, i) => base({ id: `s${i}`, last_seen: "2026-01-01" })),
    cfg({ protectTopFraction: 0 }),
  ).warnings.some((w) => w.includes("60d+ stale")),
  true,
);

// =============================================================================
// ITEM 10 — per-domain cap: a flat global cap is a budget with no allocation.
// =============================================================================
const crowded = [
  base({ id: "z1", domain: "zsf", confidence: 0.9, last_seen: TODAY }),
  base({ id: "z2", domain: "zsf", confidence: 0.8, last_seen: TODAY }),
  base({ id: "z3", domain: "zsf", confidence: 0.7, last_seen: TODAY }),
  base({ id: "g1", domain: "governance", confidence: 0.6, last_seen: TODAY }),
];
const pNoDomainCap = planLifecycle(crowded, cfg({ cap: 200, protectTopFraction: 0 }));
ck("ITEM10: per-domain cap off by default (no silent policy change)", pNoDomainCap.pruned.length, 0);
ck(
  "ITEM10: domain crowding is reported even when off",
  pNoDomainCap.warnings.some((w) => w.includes("Domain crowding")),
  false, // under the 20-row threshold
);
const pDomainCap = planLifecycle(crowded, cfg({ cap: 200, perDomainCap: 2, protectTopFraction: 0 }));
ck("ITEM10: per-domain cap evicts past the ceiling", pDomainCap.pruned.length, 1);
ck("ITEM10: evicts the weakest in the crowded domain", pDomainCap.pruned[0]?.id, "z3");
ck("ITEM10: sparse domain untouched", pDomainCap.kept.some((i) => i.id === "g1"), true);
ck("ITEM10: domain rows expose share", pDomainCap.domainRows[0]?.share, 0.75);
ck("ITEM10: overCap flag set", pDomainCap.domainRows.find((d) => d.domain === "zsf")?.overCap, true);

// =============================================================================
// ITEMS 1 + 2 — admission: never evict on add; critical beats weakest non-critical.
// The P0: add created a row, printed "added", and the pruner deleted it in the
// same invocation, exiting 0. Store frozen at 200; harvester learned nothing.
// =============================================================================
const store200 = Array.from({ length: 200 }, (_, i) =>
  base({ id: `inst_${i}`, confidence: 0.9, last_seen: "2026-06-01", domain: "infra" }),
);

// ITEM 1 — non-critical newcomer at cap is REJECTED, not silently dropped.
const reject = admitCandidate(store200, base({ id: "newbie", confidence: 0.7 }), cfg());
ck("ITEM1: non-critical add at cap is REJECTED", reject.admitted, false);
ck("ITEM1: nothing evicted on reject", reject.evicted.length, 0);
ck("ITEM1: reason names the cap", reject.reason.includes("at cap"), true);
ck("ITEM1: reason is actionable (tells the operator what to run)", reject.reason.includes("lifecycle.ts"), true);
ck("ITEM1: rejected candidate is absent from the plan", reject.plan.kept.some((i) => i.id === "newbie"), false);

// A rejected add must leave the store byte-identical in size.
ck("ITEM1: rejected plan holds the store alone (total unchanged)", reject.plan.total, 200);
ck("ITEM1: kept count stays at cap", reject.plan.kept.length, 200);

// Under cap, an ordinary add is admitted.
const admit = admitCandidate(store200.slice(0, 199), base({ id: "fresh", confidence: 0.7 }), cfg());
ck("ITEM1: add under cap is admitted", admit.admitted, true);
ck("ITEM1: under-cap admit evicts nothing", admit.evicted.length, 0);

// ITEM 2 — critical fast path evicts the weakest NON-critical row.
const withWeak = [
  ...Array.from({ length: 10 }, (_, i) =>
    base({ id: `s${i}`, confidence: 0.9, last_seen: "2026-06-01", domain: "infra" }),
  ),
  base({ id: "weakest", confidence: 0.4, last_seen: "2026-01-01", domain: "legacy" }),
];
const crit = admitCandidate(withWeak, base({ id: "crit_new", confidence: 0.5, critical: true }), cfg({ cap: 11 }));
ck("ITEM2: critical add at cap is ADMITTED", crit.admitted, true);
ck("ITEM2: critical add evicts exactly one", crit.evicted.length, 1);
ck("ITEM2: critical add evicts the weakest non-critical row", crit.evicted[0]?.id, "weakest");
ck("ITEM2: the critical instinct survives its own admission", crit.plan.kept.some((i) => i.id === "crit_new"), true);
ck("ITEM2: store size held at cap", crit.plan.kept.length, 11);

// Critical cannot evict when every row is protected → fail closed.
const allCrit = Array.from({ length: 5 }, (_, i) =>
  base({ id: `c${i}`, critical: true, confidence: 0.9 }),
);
const critBlocked = admitCandidate(allCrit, base({ id: "crit2", critical: true }), cfg({ cap: 5 }));
ck("ITEM2: critical add BLOCKED when no non-critical victim exists", critBlocked.admitted, false);
ck("ITEM2: block reason is explicit", critBlocked.reason.includes("no non-critical row"), true);

// =============================================================================
// ITEM 7 — readiness gate: --apply must refuse until it can see signal.
// =============================================================================
// A plan that is genuinely ready: a live (non-empty) decay watch, protection
// well under the 50% suppression line, and a real supersession in flight.
const pReady = planLifecycle(
  [
    base({ id: "r_a", confidence: 0.6, last_seen: "2026-04-11" }),
    base({ id: "r_b", confidence: 0.6, last_seen: TODAY }),
    base({ id: "r_c", confidence: 0.9, last_seen: TODAY, critical: true }),
    base({ id: "r_d", confidence: 0.8, supersedes: "r_e" }),
    base({ id: "r_e", confidence: 0.7, last_seen: "2026-05-01" }),
  ],
  cfg(),
);
const notReady = assessReadiness(pAllProt, cfg(), 0);
ck("ITEM7: blanket protection is NOT ready", notReady.ready, false);
ck("ITEM7: blockers name the degenerate protection", notReady.blockers.some((b) => b.includes("eviction pressure suppressed")), true);
ck("ITEM7: blockers name the empty prior watch history", notReady.blockers.some((b) => b.includes("only 0 consecutive")), true);
const stillNotReady = assessReadiness(pReady, cfg(), 1);
ck("ITEM7: 1 prior cycle is still not enough", stillNotReady.ready, false);
const ready = assessReadiness(pReady, cfg(), 5);
ck("ITEM7: non-degenerate + history → ready", ready.ready, true);
ck("ITEM7: ready has no blockers", ready.blockers.length, 0);
ck("ITEM7: empty store blocks readiness", assessReadiness(planLifecycle([], cfg()), cfg(), 9).ready, false);

// =============================================================================
// renderReport — diagnostics, domain table, readiness verdict must be visible.
// The old report said "mechanism is in place" and nothing else.
// =============================================================================
const rep = renderReport(p1, cfg(), false);
ck("report shows advisory mode", rep.includes("ADVISORY"), true);
ck("report shows summary", rep.includes("2 instincts"), true);
ck("report no longer claims the no-op line is health", rep.includes("not "), true);
ck("report drops the 'mechanism is in place' self-congratulation", rep.includes("mechanism is in place"), false);
ck("report shows the confidence floor is off", rep.includes("conf floor off"), true);

const repBlank = renderReport(pBlank, cfg(), false, notReady);
ck("report surfaces Diagnostics section", repBlank.includes("## Diagnostics"), true);
ck("report surfaces the fallback in the watch heading", repBlank.includes("fallback"), true);
ck("report surfaces Readiness verdict", repBlank.includes("NOT READY"), true);
ck("report lists blockers", repBlank.includes("blocker:"), true);
ck("report shows domain allocation table", repBlank.includes("## Domain allocation"), true);
ck("report applied mode label", renderReport(p2, cfg(), true).includes("APPLIED"), true);
ck(
  "report shows per-domain cap as off by default",
  renderReport(p1, cfg(), false).includes("per-domain cap off"),
  true,
);

console.log(`instinct-harvester lifecycle selftest: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
