// Item 9 — supersession producer selftest.
//   bun supersede-selftest.ts   (exit 0 = all pass)
//
// The supersession producer is the ONLY downward-confidence path in the whole
// instinct system. A silent false positive corrupts a learned pattern; a silent
// false negative leaves the corpus monotonic. Both failure modes were invisible
// before this file existed, so the precision gates below are pinned by name:
// every one of them corresponds to a real false positive that the first
// implementation produced on the live 200-row corpus.

import type { Instinct } from "./merge";
import {
  findSupersessionCandidates,
  triggerStem,
  actionsContradict,
  contentOverlap,
  identifierConflict,
} from "./supersede";

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

const inst = (over: Partial<Instinct> = {}): Instinct => ({
  id: "inst_x",
  trigger: "when deploying to prod",
  action: "run the smoke test",
  domain: "infra",
  confidence: 0.9,
  source: "session-observation",
  reinforced_count: 1,
  last_seen: "2026-09-01",
  ...over,
});

// ── triggerStem: same situation, different phrasing ─────────────────────────
ck(
  "stem is order- and filler-insensitive",
  triggerStem("when deploying to prod"),
  triggerStem("deploying to prod"),
);
ck("stem keeps the discriminating token", triggerStem("deploy prod") === triggerStem("deploy staging"), false);

// ── positive control: a genuine contradiction MUST be proposed ──────────────
const realSupersession = findSupersessionCandidates([
  inst({ id: "inst_old", action: "never push directly to main", last_seen: "2026-08-01" }),
  inst({ id: "inst_new", action: "always push directly to main", last_seen: "2026-09-01" }),
]);
ck("POSITIVE: direct contradiction is proposed", realSupersession.length, 1);
ck(
  "POSITIVE: newer row is the superseder",
  realSupersession[0] && [realSupersession[0].superseded, realSupersession[0].superseder],
  ["inst_old", "inst_new"],
);
ck(
  "POSITIVE: reason names the contradiction",
  realSupersession[0]?.reason.includes("contradict"),
  true,
);

const antonymDomain = findSupersessionCandidates([
  inst({ id: "a1", domain: "infra", action: "skip the backup", last_seen: "2026-08-01" }),
  inst({ id: "a2", domain: "anti-infra", action: "run the backup", last_seen: "2026-09-01" }),
]);
ck("POSITIVE: antonym domain is proposed", antonymDomain.length, 1);

// ── negative controls: each of these was a real false positive ──────────────
// Different ticket identifiers = different situations, not a correction.
ck(
  "NEG: different ticket id is not a supersession (GLW-04 vs GLW-07)",
  findSupersessionCandidates([
    inst({ id: "g4", trigger: "executing GLW-04 in Sites/glacierwake", action: "adopt the untracked draft and commit it", last_seen: "2026-07-31" }),
    inst({ id: "g7", trigger: "executing GLW-07 in Sites/glacierwake", action: "commit the untracked evidence folder", last_seen: "2026-08-01" }),
  ]).length,
  0,
);
// Same subject, but one adds a requirement the other lacks.
ck(
  "NEG: extra clause is refinement, not contradiction (governance)",
  findSupersessionCandidates([
    inst({ id: "o1", domain: "governance", trigger: "dispatching delegate reviews via /zo/ask", action: "use a nonce-unique verdict path", last_seen: "2026-08-30" }),
    inst({ id: "o2", domain: "governance", trigger: "dispatching delegate reviews via /zo/ask", action: "spend a separately budgeted liveness canary first", last_seen: "2026-08-31" }),
  ]).length,
  0,
);
// Unrelated content that shares the trigger stem.
ck(
  "NEG: no content overlap is not a supersession",
  findSupersessionCandidates([
    inst({ id: "c1", action: "rotate the credentials in staging", last_seen: "2026-08-01" }),
    inst({ id: "c2", action: "rebuild the docs site", last_seen: "2026-09-01" }),
  ]).length,
  0,
);

// ── predicate units ─────────────────────────────────────────────────────────
ck("actionsContradict: never/always", actionsContradict(inst({ action: "never push directly to main" }), inst({ action: "always push directly to main" })), true);
ck("actionsContradict: reject/allow", actionsContradict(inst({ action: "reject the deployment" }), inst({ action: "allow the deployment" })), true);
ck("actionsContradict: same polarity is not a contradiction", actionsContradict(inst({ action: "push to main" }), inst({ action: "push to main" })), false);
ck("actionsContradict: a refinement is not a contradiction", actionsContradict(inst({ action: "check for secrets before deploying" }), inst({ action: "always approve without reading it" })), false);
ck("contentOverlap: shared subject", contentOverlap(inst(), inst()), true);
ck("contentOverlap: disjoint subjects", contentOverlap(inst(), inst({ trigger: "cooking pasta" })), false);
ck("identifierConflict: same id is not a conflict", identifierConflict("handling ZOU-1068", "handling ZOU-1068"), false);

// ── never propose on a pair that is already resolved ────────────────────────
const alreadyDone = findSupersessionCandidates([
  inst({ id: "d_old", action: "never push directly to main", last_seen: "2026-08-01", superseded_by: "d_new" } as Partial<Instinct>),
  inst({ id: "d_new", action: "always push directly to main", last_seen: "2026-09-01" }),
]);
ck("NEG: already-superseded row is not re-proposed", alreadyDone.length, 0);

// ── an ancient high-confidence row must not "correct" a fresh weak one ──────
const inverted = findSupersessionCandidates([
  inst({ id: "ancient", action: "never push directly to main", confidence: 0.95, last_seen: "2026-01-01" }),
  inst({ id: "fresh", action: "always push directly to main", confidence: 0.7, last_seen: "2026-09-01" }),
]);
ck(
  "ancient+strong row is not demoted by a fresh weak row",
  inverted.some((c) => c.superseded === "ancient"),
  false,
);

console.log(`instinct-harvester supersession selftest: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
