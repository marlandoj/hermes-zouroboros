/**
 * Endogenous curiosity explorer (ZOU-283, #6 of the Intelligence-Harness roadmap).
 *
 * Every other layer of the loop optimizes metrics that are ALREADY instrumented — the
 * scorecard is both the map and the territory. Nothing looks for weaknesses the scorecard
 * does not yet measure. That is the blind spot a static optimizer can never escape: it
 * improves what it can see and is silent about what it cannot. Curiosity is the bounded
 * drive to surface those un-instrumented gaps as explicit hypotheses.
 *
 * This is the most dangerous capability in the system to wire — an explorer that could spawn
 * its own prescribe/evolve cycles is an unbounded self-modification loop — so the seed
 * constraint is "wire last, governor-hard". Three invariants enforce that here:
 *
 *   1. PROPOSAL-ONLY. The explorer NEVER spawns prescribe or evolve. It emits CuriosityProposals
 *      and stops. `spawnable` is an eligibility *label*, not an action; turning a proposal into
 *      a real cycle is always a separate, out-of-band decision. There is no spawn path in this
 *      module by construction.
 *   2. GOVERNOR-HARD. Every proposal is run through the REAL prescribe governor
 *      (evaluatePrescription, injected) by projecting it onto a synthetic playbook+metric. A
 *      proposal is `spawnable` only when the governor approves AND does not require a human —
 *      otherwise it is held for human review. Novel probes default to requiresApproval, so the
 *      governor escalates anything that touches a risky surface.
 *   3. HARD RATE / BUDGET LIMITS. A persistent ledger caps proposals per rolling window
 *      (maxPerWindow) and total open proposals (maxOpen). The explorer refuses to emit beyond
 *      budget — curiosity cannot flood the loop.
 *
 * tsc note: type-checked (src/curiosity/). The governor is injected as a function so this stays
 * free of the governor's sqlite/RAG side-channel; the standalone runner passes the live one.
 */

import type { Playbook, MetricResult, GovernorReport } from '../types.js';

/** Default cap on proposals emitted per rolling window. */
export const DEFAULT_MAX_PER_WINDOW = 3;
/** Default rolling window length (ms) for the rate cap. 24h. */
export const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
/** Default cap on simultaneously-open (un-resolved) proposals. */
export const DEFAULT_MAX_OPEN = 10;

export type CuriosityRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface CuriosityConfig {
  maxPerWindow: number;
  windowMs: number;
  maxOpen: number;
}

export const DEFAULT_CURIOSITY_CONFIG: CuriosityConfig = {
  maxPerWindow: DEFAULT_MAX_PER_WINDOW,
  windowMs: DEFAULT_WINDOW_MS,
  maxOpen: DEFAULT_MAX_OPEN,
};

/**
 * A raw signal that some capability may be un-instrumented. Source examples: a Wiring
 * Sentinel finding (an export/store/path with no metric pointing at it), a module with no
 * scorecard coverage, an area with no recent intervention. `weight` ranks proposals.
 */
export interface Observation {
  /** Stable identifier of the thing observed — drives dedupe (e.g. 'unreachable:fooExport'). */
  key: string;
  kind: 'wiring_gap' | 'coverage_gap' | 'stale_area' | 'variance' | 'other';
  /** Human-readable description of the suspected weakness. */
  detail: string;
  /** Salience 0..1; higher = more worth probing. */
  weight: number;
  /** The risk surface a probe of this would touch — projected onto the governor. */
  surface?: {
    targetFile?: string;
    maxFiles?: number;
    touchesSchema?: boolean;
  };
}

export interface CuriosityProbe {
  /** The metric a probe would instrument (a name the scorecard does not yet have). */
  proposedMetric: string;
  /** What the probe would measure / how. */
  approach: string;
  targetFile: string | null;
  maxFiles: number;
  touchesSchema: boolean;
}

export interface CuriosityProposal {
  /** Stable proposal id derived from the observation key. */
  id: string;
  observationKey: string;
  hypothesis: string;
  probe: CuriosityProbe;
  risk: CuriosityRisk;
  weight: number;
  /** Always 'proposed' on creation — the explorer never advances this itself. */
  status: 'proposed';
  proposedAt: number;
}

/** A proposal after the mandatory governor gate. */
export interface GatedProposal {
  proposal: CuriosityProposal;
  governor: GovernorReport;
  /**
   * Eligible to be turned into a prescribe/evolve cycle by a SEPARATE decision. This is a
   * label only — the explorer never acts on it. spawnable === governor.approved && not human.
   */
  spawnable: boolean;
}

export interface LedgerEntry {
  key: string;
  proposedAt: number;
  status: 'open' | 'resolved' | 'dismissed';
}

export interface CuriosityLedger {
  version: number;
  entries: LedgerEntry[];
}

export const CURIOSITY_LEDGER_VERSION = 1;

export function emptyLedger(): CuriosityLedger {
  return { version: CURIOSITY_LEDGER_VERSION, entries: [] };
}

function riskFromSurface(surface: Observation['surface']): CuriosityRisk {
  if (!surface) return 'LOW';
  if (surface.touchesSchema) return 'HIGH';
  if ((surface.maxFiles ?? 1) > 3) return 'MEDIUM';
  if (surface.targetFile && /bridge|executor|migration/.test(surface.targetFile)) return 'HIGH';
  return 'LOW';
}

/**
 * Project a curiosity proposal onto a synthetic Playbook + MetricResult so the REAL prescribe
 * governor can judge it. Novel probes are marked requiresApproval by default — curiosity is
 * unvalidated by definition, so the governor must escalate it rather than wave it through.
 */
export function proposalToPlaybook(p: CuriosityProposal): { playbook: Playbook; metric: MetricResult } {
  const playbook: Playbook = {
    id: `curiosity-${p.id}`,
    name: `Probe: ${p.probe.proposedMetric}`,
    description: p.hypothesis,
    targetFile: p.probe.targetFile,
    metricCommand: '',
    metricDirection: 'higher_is_better',
    constraints: [],
    maxFiles: p.probe.maxFiles,
    requiresApproval: true,
    approvalReason: 'Endogenous curiosity proposal — novel un-instrumented probe, human review required',
  };
  const metric: MetricResult = {
    name: p.probe.proposedMetric,
    value: 0,
    target: 1,
    critical: 0,
    weight: 0,
    score: 0,
    status: 'WARNING',
    trend: '—',
    detail: p.hypothesis,
    recommendation: p.probe.approach,
  };
  return { playbook, metric };
}

/**
 * Turn observations into ranked, deduplicated, proposal-only CuriosityProposals. Pure. The
 * hard per-window cap is applied by enforceBudget, not here, but the highest-weight
 * observations come first so budget trimming keeps the most salient.
 */
export function proposeFromObservations(
  observations: Observation[],
  now: number = Date.now()
): CuriosityProposal[] {
  const seen = new Set<string>();
  const proposals: CuriosityProposal[] = [];
  const ranked = [...observations].sort((a, b) => b.weight - a.weight);

  for (const obs of ranked) {
    if (seen.has(obs.key)) continue;
    seen.add(obs.key);
    const risk = riskFromSurface(obs.surface);
    proposals.push({
      id: obs.key.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60),
      observationKey: obs.key,
      hypothesis: `Possible un-instrumented weakness: ${obs.detail}`,
      probe: {
        proposedMetric: `probe:${obs.key}`,
        approach: `Instrument ${obs.kind} '${obs.key}' and measure it before optimizing.`,
        targetFile: obs.surface?.targetFile ?? null,
        maxFiles: obs.surface?.maxFiles ?? 1,
        touchesSchema: obs.surface?.touchesSchema ?? false,
      },
      risk,
      weight: obs.weight,
      status: 'proposed',
      proposedAt: now,
    });
  }
  return proposals;
}

export interface BudgetState {
  /** Proposals in the rolling window already used. */
  windowUsed: number;
  /** Currently open proposals. */
  openCount: number;
  /** Remaining emit budget = min(window remaining, open remaining), never negative. */
  remaining: number;
}

/** Compute the remaining emit budget from the ledger against both hard caps. */
export function budgetState(
  ledger: CuriosityLedger,
  config: CuriosityConfig = DEFAULT_CURIOSITY_CONFIG,
  now: number = Date.now()
): BudgetState {
  const windowUsed = ledger.entries.filter((e) => now - e.proposedAt <= config.windowMs).length;
  const openCount = ledger.entries.filter((e) => e.status === 'open').length;
  const windowRemaining = Math.max(0, config.maxPerWindow - windowUsed);
  const openRemaining = Math.max(0, config.maxOpen - openCount);
  return {
    windowUsed,
    openCount,
    remaining: Math.min(windowRemaining, openRemaining),
  };
}

export interface BudgetEnforcement {
  emitted: CuriosityProposal[];
  /** Proposals dropped because the hard budget was exhausted. */
  refused: CuriosityProposal[];
  budget: BudgetState;
}

/**
 * Apply the hard rate / open caps: emit at most `remaining` proposals, refuse the rest.
 * New proposals already present in the ledger (same key, still open) are skipped so the
 * explorer does not re-propose an open item or spend budget on duplicates.
 */
export function enforceBudget(
  proposals: CuriosityProposal[],
  ledger: CuriosityLedger,
  config: CuriosityConfig = DEFAULT_CURIOSITY_CONFIG,
  now: number = Date.now()
): BudgetEnforcement {
  const openKeys = new Set(
    ledger.entries.filter((e) => e.status === 'open').map((e) => e.key)
  );
  const fresh = proposals.filter((p) => !openKeys.has(p.observationKey));
  const budget = budgetState(ledger, config, now);
  const emitted = fresh.slice(0, budget.remaining);
  const refused = fresh.slice(budget.remaining);
  return { emitted, refused, budget };
}

/** Append emitted proposals to the ledger as open entries (records budget spend). */
export function recordProposals(
  ledger: CuriosityLedger,
  emitted: CuriosityProposal[]
): CuriosityLedger {
  return {
    version: ledger.version ?? CURIOSITY_LEDGER_VERSION,
    entries: [
      ...ledger.entries,
      ...emitted.map((p) => ({ key: p.observationKey, proposedAt: p.proposedAt, status: 'open' as const })),
    ],
  };
}

/**
 * The mandatory governor gate. Projects the proposal onto a synthetic playbook+metric and runs
 * the injected REAL governor. spawnable requires explicit approval AND no human-review flag —
 * a held proposal is never spawnable. The explorer does NOT act on spawnable; it only labels.
 */
export function gateProposal(
  proposal: CuriosityProposal,
  governor: (playbook: Playbook, metric: MetricResult) => GovernorReport
): GatedProposal {
  const { playbook, metric } = proposalToPlaybook(proposal);
  const report = governor(playbook, metric);
  return {
    proposal,
    governor: report,
    spawnable: report.approved && !report.requiresHuman,
  };
}

export interface CuriosityRun {
  /** Governor-gated, budget-bounded proposals (proposal-only — none are spawned). */
  proposals: GatedProposal[];
  emitted: number;
  refusedByBudget: number;
  spawnableCount: number;
  budget: BudgetState;
  /** The ledger AFTER recording the emitted proposals — caller persists it. */
  ledger: CuriosityLedger;
}

/**
 * Full curiosity pass: propose → enforce hard budget → governor-gate each → record. Returns a
 * CuriosityRun and the updated ledger. NEVER spawns prescribe/evolve — by construction there is
 * no spawn call anywhere in this pipeline; `spawnableCount` is advisory for a human/loop owner.
 */
export function exploreCuriosity(
  observations: Observation[],
  ledger: CuriosityLedger,
  governor: (playbook: Playbook, metric: MetricResult) => GovernorReport,
  config: CuriosityConfig = DEFAULT_CURIOSITY_CONFIG,
  now: number = Date.now()
): CuriosityRun {
  const proposals = proposeFromObservations(observations, now);
  const { emitted, refused, budget } = enforceBudget(proposals, ledger, config, now);
  const gated = emitted.map((p) => gateProposal(p, governor));
  const nextLedger = recordProposals(ledger, emitted);
  return {
    proposals: gated,
    emitted: emitted.length,
    refusedByBudget: refused.length,
    spawnableCount: gated.filter((g) => g.spawnable).length,
    budget,
    ledger: nextLedger,
  };
}

/** One-line human summary of a curiosity run. */
export function summarizeRun(run: CuriosityRun): string {
  return (
    `curiosity: emitted ${run.emitted}, refused(budget) ${run.refusedByBudget}, ` +
    `spawnable ${run.spawnableCount}/${run.emitted}, budgetRemaining ${run.budget.remaining} ` +
    `(window ${run.budget.windowUsed}, open ${run.budget.openCount}) — PROPOSAL-ONLY, nothing spawned`
  );
}

/**
 * The on-disk shape the standalone runner persists to `curiosity-proposals.json`. A lossless
 * superset of the gated proposal's publishable fields — the single source of truth the
 * Curiosity Chronicle (publishable feed) reads. Kept here, beside the producer, so the
 * producer and consumer share ONE schema and cannot drift apart silently.
 */
export interface PersistedProposal {
  id: string;
  observationKey: string;
  hypothesis: string;
  risk: CuriosityRisk;
  weight: number;
  probe: CuriosityProbe;
  spawnable: boolean;
  governor: GovernorReport;
  proposedAt: number;
}

/** Flatten a gated proposal into the persisted, publishable shape (pure, lossless). */
export function toPersistedProposal(g: GatedProposal): PersistedProposal {
  return {
    id: g.proposal.id,
    observationKey: g.proposal.observationKey,
    hypothesis: g.proposal.hypothesis,
    risk: g.proposal.risk,
    weight: g.proposal.weight,
    probe: g.proposal.probe,
    spawnable: g.spawnable,
    governor: g.governor,
    proposedAt: g.proposal.proposedAt,
  };
}
