#!/usr/bin/env bun
/**
 * agent-model-healer — self-healing model fallback for the Hermes profile's scheduled agents.
 *
 * hermes-zouroboros: replaces the source workspace's Zo/VPS healer. Models are probed through the
 * Hermes provider/model layer (integration/ask.ts: the profile's executor registry, default
 * hermes-vps), patients are the profile's cron jobs that pin a model, and heal/restore go through
 * `hermes cron edit <id> --model … [--provider …]`. All orchestration is deterministic code; the
 * only model cost is the tiny probe prompt per chain model.
 *
 * Preserved from the source:
 *   - probe timing semantics: healthy-response threshold strictly below the request timeout;
 *     a timeout records latencyMs=null (it does not establish completion time)
 *   - failure categories on every unhealthy probe
 *   - operator exclusions (never a fallback target, never auto-healed away)
 *   - chain validation (terminal rung must be open-weight; proprietary chains need an open-weight rung)
 *   - hysteresis (default 2 unhealthy samples to heal, 3 healthy to restore; fails closed)
 *   - healingEnabled=false by default: auto is a dry run until the operator enables it
 *   - alert-on-exhaustion, never cascade
 *
 * hermes-zouroboros additions:
 *   - unfunded providers (HTTP 402, insufficient balance) are an informational "unfunded (skipped)"
 *     status: not healthy, not an alarm, never retried, never an automatic fallback target, and
 *     jobs pinned to them are listed, not moved
 *   - healthy-response default of 20 s, because every `hermes -z` probe pays ~8 s of CLI startup
 *     (override: probeConfig.healthyResponseMs or AGENT_MODEL_HEALER_HEALTHY_RESPONSE_MS)
 *
 * Commands: probe | diagnose | status | validate | auto
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ask, type AskOutcome, type AskRequest } from "../../../../integration/ask.ts";
import { paths } from "../../../../integration/profile.ts";
import { hermesCron, isActive, loadJobs, type HermesJob } from "../../agent-doctor/scripts/hermes-cron.ts";

/**
 * Default healthy-response threshold. A `hermes -z` probe pays roughly 8 s of CLI startup before
 * the provider sees the request, and live healthy probes took 9.9–11 s end to end, so the source's
 * 10 s marked healthy models degraded. 20 s keeps about 2x headroom over an observed healthy probe
 * while staying well below the example 30 s timeout, so the degraded band (20–30 s) still means
 * "slow but completed".
 */
export const DEFAULT_HEALTHY_RESPONSE_MS = 20_000;
export const HEALTHY_RESPONSE_ENV = "AGENT_MODEL_HEALER_HEALTHY_RESPONSE_MS";

type ProbeHealth = "healthy" | "degraded" | "unhealthy" | "unfunded";

export type ProbeFailureCategory = "timeout" | "provider_error" | "empty_response" | "unfunded";

export type RungType = "proprietary" | "open-weight" | "unknown";

const OPEN_WEIGHT_LABEL_HINTS = ["gpt-oss", "kimi", "moonshot", " k2", "k2.", "qwen", "deepseek", "llama", "minimax", "glm", "mistral", "gemma"];
const PROPRIETARY_LABEL_HINTS = ["claude", "sonnet", "haiku", "opus", "gpt-", "codex", "gemini"];

export function classifyRung(model: string, label?: string): RungType {
  const hay = (label || model).toLowerCase();
  // Open-weight hints take precedence over proprietary hints so that labels like
  // "GPT-OSS-120B" or "Kimi K2 (via a proxy)" classify correctly.
  if (OPEN_WEIGHT_LABEL_HINTS.some((h) => hay.includes(h))) return "open-weight";
  if (PROPRIETARY_LABEL_HINTS.some((h) => hay.includes(h))) return "proprietary";
  return "unknown";
}

export interface ChainEntry { label: string; provider?: string; fallbacks: string[] }

export interface FallbackConfig {
  probeConfig: {
    prompt: string;
    expectedSubstring: string;
    timeoutMs: number;
    retries: number;
    /** Healthy-response threshold in ms (default 20000; AGENT_MODEL_HEALER_HEALTHY_RESPONSE_MS
     * overrides). A completed response at or above it is degraded, not unhealthy. Must be strictly
     * below timeoutMs. */
    healthyResponseMs?: number;
    /** @deprecated legacy thresholds; healthyResponseMs wins when both exist */
    latencyThresholds?: { degradedMs: number; slowMs: number };
  };
  /** Registry executor used for probes (default hermes-vps). */
  probeExecutor?: string;
  /** Models never selected as automatic fallback targets and never auto-healed away.
   * Exact or case-insensitive substring match. */
  excludedFromAutoFallback?: string[];
  /** Master switch for heal/restore. false (default) = auto reports what it would do. */
  healingEnabled?: boolean;
  hysteresis?: { consecutiveUnhealthyToHeal?: number; consecutiveHealthyToRestore?: number };
  fallbackChains: Record<string, ChainEntry>;
  modelLabels: Record<string, string>;
}

export interface ChainValidationResult { ok: boolean; errors: string[]; warnings: string[] }

export function validateChain(config: FallbackConfig): ChainValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chains = config.fallbackChains;
  const knownPrimaries = new Set(Object.keys(chains));

  for (const [primary, chain] of Object.entries(chains)) {
    const primaryRung = classifyRung(primary, chain.label);

    // Empty fallbacks: only allowed if the primary itself is an acceptable terminal floor
    // (open-weight). Exhaustion then triggers an alert rather than a cascade.
    if (chain.fallbacks.length === 0) {
      if (primaryRung !== "open-weight") {
        errors.push(`Chain '${chain.label || primary}' has empty fallbacks but primary rung is '${primaryRung}' (expected open-weight)`);
      }
    } else {
      const last = chain.fallbacks[chain.fallbacks.length - 1]!;
      const lastRung = classifyRung(last, config.modelLabels[last] || chains[last]?.label);
      if (lastRung !== "open-weight") {
        errors.push(`Chain '${primary}' terminal rung is '${last}' (rung:${lastRung}); expected open-weight`);
      }
      for (const fb of chain.fallbacks) {
        if (!knownPrimaries.has(fb)) errors.push(`Chain '${primary}' fallback '${fb}' is not a registered chain model`);
      }
      // Proprietary chains must include at least one open-weight rung before exhaustion.
      if (primaryRung === "proprietary") {
        const hasOpenWeight = chain.fallbacks.some((m) => classifyRung(m, config.modelLabels[m] || chains[m]?.label) === "open-weight");
        if (!hasOpenWeight) errors.push(`Proprietary chain '${chain.label || primary}' lacks an open-weight rung before terminal exhaustion`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export interface ProbeResult {
  model: string;
  healthy: boolean;
  health: ProbeHealth;
  /** Actual elapsed time for COMPLETED responses only. null on timeout. */
  latencyMs: number | null;
  error?: string;
  warning?: string;
  failureCategory?: ProbeFailureCategory;
  checkedAt: string;
}

interface SwitchRecord {
  agentId: string;
  agentTitle: string;
  originalModel: string;
  originalProvider?: string;
  currentModel: string;
  switchedAt: string;
  reason: string;
}

export interface ModelStreak {
  consecutiveUnhealthy: number;
  consecutiveHealthy: number;
  updatedAt: string;
}

interface HealerState {
  switches: SwitchRecord[];
  lastProbe: Record<string, ProbeResult>;
  lastRunAt: string;
  healCount: number;
  restoreCount: number;
  streaks?: Record<string, ModelStreak>;
}

interface AgentInfo { id: string; title: string; model: string; provider?: string; active: boolean; self: boolean }

// ── Locations (portable state root) ─────────────────────────────────

function dataDir(kind: "STATE" | "CONFIG" | "LOG", fallback: string): string {
  return process.env[`ZOUROBOROS_${kind}_DIR`] || join(paths().data, fallback);
}
export function configPath(): string {
  return process.env.AGENT_MODEL_HEALER_CONFIG || join(dataDir("CONFIG", "config"), "agent-model-healer", "fallback-chain.json");
}
function statePath(): string { return join(dataDir("STATE", "state"), "agent-model-healer", "state.json"); }
function logPath(): string { return join(dataDir("LOG", "logs"), "agent-model-healer.log"); }
const EXAMPLE_CONFIG = join(import.meta.dir, "../assets/fallback-chain.example.json");

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try {
    mkdirSync(dirname(logPath()), { recursive: true, mode: 0o700 });
    appendFileSync(logPath(), `${line}\n`, { mode: 0o600 });
  } catch {}
}

function loadConfig(): FallbackConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No fallback chain at ${path}. Copy ${EXAMPLE_CONFIG} there, replace the example models with your own, then run validate.`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadState(): HealerState {
  if (!existsSync(statePath())) return { switches: [], lastProbe: {}, lastRunAt: "", healCount: 0, restoreCount: 0 };
  return JSON.parse(readFileSync(statePath(), "utf-8"));
}

function saveState(state: HealerState) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function getModelLabel(model: string, config: FallbackConfig): string {
  return config.modelLabels[model] || config.fallbackChains[model]?.label || model;
}

// ── Hysteresis ──────────────────────────────────────────────────────

/** Consecutive unhealthy samples required before a job is moved off a model. Absent or
 * nonsensical values fail closed to 2. Set an explicit 1 for single-sample behavior. */
export function unhealthyThreshold(config: Pick<FallbackConfig, "hysteresis">): number {
  const n = config.hysteresis?.consecutiveUnhealthyToHeal;
  return typeof n === "number" && n >= 1 ? Math.floor(n) : 2;
}

/** Consecutive healthy samples required before a switched job is moved back. Fails closed to 3,
 * so recovery is more conservative than failure and a flapping model settles on the fallback. */
export function healthyThreshold(config: Pick<FallbackConfig, "hysteresis">): number {
  const n = config.hysteresis?.consecutiveHealthyToRestore;
  return typeof n === "number" && n >= 1 ? Math.floor(n) : 3;
}

/** Advance the streak for one probe result. Any healthy sample clears the unhealthy run, and vice versa. */
export function advanceStreak(prev: ModelStreak | undefined, healthy: boolean, now: string = new Date().toISOString()): ModelStreak {
  return {
    consecutiveUnhealthy: healthy ? 0 : (prev?.consecutiveUnhealthy ?? 0) + 1,
    consecutiveHealthy: healthy ? (prev?.consecutiveHealthy ?? 0) + 1 : 0,
    updatedAt: now,
  };
}

/** True when the streak has met the threshold. A missing streak never satisfies a threshold above 1. */
export function streakMet(streak: ModelStreak | undefined, healthy: boolean, threshold: number): boolean {
  if (threshold <= 1) return true;
  if (!streak) return false;
  return healthy ? streak.consecutiveHealthy >= threshold : streak.consecutiveUnhealthy >= threshold;
}

// ── Probe semantics ─────────────────────────────────────────────────

/** Env override (positive integer ms) > probeConfig.healthyResponseMs > legacy degradedMs > 20 s default. */
export function healthyResponseThresholdMs(config: Pick<FallbackConfig, "probeConfig">, env: NodeJS.ProcessEnv = process.env): number {
  const override = env[HEALTHY_RESPONSE_ENV];
  if (override !== undefined && override !== "") {
    if (!/^[1-9]\d*$/.test(override)) throw new Error(`${HEALTHY_RESPONSE_ENV} must be a positive integer number of milliseconds`);
    return Number(override);
  }
  return config.probeConfig.healthyResponseMs ?? config.probeConfig.latencyThresholds?.degradedMs ?? DEFAULT_HEALTHY_RESPONSE_MS;
}

export function probeTimeoutMs(config: Pick<FallbackConfig, "probeConfig">): number {
  return config.probeConfig.timeoutMs;
}

/** The request timeout must be strictly above the healthy-response threshold, otherwise a
 * slow-but-complete response is indistinguishable from a timeout. */
export function validateProbeSemantics(config: Pick<FallbackConfig, "probeConfig">): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const healthy = healthyResponseThresholdMs(config);
  const timeout = probeTimeoutMs(config);
  if (!(timeout > healthy)) {
    errors.push(`probeConfig.timeoutMs (${timeout}ms) must be strictly greater than the healthy-response threshold (${healthy}ms) so completed-but-slow responses are distinguishable from timeouts`);
  }
  if (timeout % 1000 !== 0) errors.push(`probeConfig.timeoutMs (${timeout}ms) must be whole seconds (the Hermes bridge timeout unit)`);
  return { ok: errors.length === 0, errors };
}

/** Classify a COMPLETED response's latency. Never call this for a timeout. */
export function classifyLatency(ms: number, config: Pick<FallbackConfig, "probeConfig">): { health: ProbeHealth; warning?: string } {
  const threshold = healthyResponseThresholdMs(config);
  if (ms >= threshold) {
    return { health: "degraded", warning: `Slow but completed response: ${ms}ms (healthy threshold: ${threshold}ms; timeout: ${probeTimeoutMs(config)}ms)` };
  }
  return { health: "healthy" };
}

export function isExcludedModel(model: string, config: Pick<FallbackConfig, "excludedFromAutoFallback">): boolean {
  const hay = model.toLowerCase();
  return (config.excludedFromAutoFallback ?? []).some((entry) => {
    const needle = entry.toLowerCase();
    return hay === needle || hay.includes(needle);
  });
}

export function validateExclusions(config: FallbackConfig): { ok: boolean; errors: string[]; warnings: string[] } {
  const warnings: string[] = [];
  for (const [primary, chain] of Object.entries(config.fallbackChains)) {
    if (isExcludedModel(primary, config)) {
      warnings.push(`Chain primary '${chain.label || primary}' matches excludedFromAutoFallback — jobs on it will not be auto-healed (operator exclusion)`);
    }
  }
  return { ok: true, errors: [], warnings };
}

/** Raised when the probe path itself (Hermes CLI, profile, registry) is unavailable: no model
 * health can be inferred, so the run aborts instead of declaring every model unhealthy. */
export class ProbeInfrastructureError extends Error {}

/** Turn one ask outcome into a probe result. */
export function classifyProbe(model: string, outcome: AskOutcome, config: FallbackConfig, now = new Date().toISOString()): ProbeResult {
  if (outcome.ok) {
    const latency = classifyLatency(outcome.ms, config);
    const valid = outcome.output.includes(config.probeConfig.expectedSubstring);
    return {
      model, healthy: true, health: valid ? latency.health : "degraded", latencyMs: outcome.ms, checkedAt: now,
      warning: valid ? latency.warning : `Completed response lacked "${config.probeConfig.expectedSubstring}"`,
    };
  }
  if (outcome.failure === "usage" || outcome.failure === "unavailable" || outcome.failure === "interrupted") {
    throw new ProbeInfrastructureError(`probe path unavailable (${outcome.failure}${outcome.detail ? `: ${outcome.detail}` : ""})`);
  }
  if (outcome.failure === "unfunded") {
    // Informational, not an alarm: the account has no balance by operator choice.
    return { model, healthy: false, health: "unfunded", latencyMs: null, failureCategory: "unfunded", warning: "unfunded (skipped)", checkedAt: now };
  }
  if (outcome.failure === "timeout") {
    return { model, healthy: false, health: "unhealthy", latencyMs: null, failureCategory: "timeout", error: `No completion within ${probeTimeoutMs(config)}ms`, checkedAt: now };
  }
  const empty = outcome.detail === "empty output";
  return {
    model, healthy: false, health: "unhealthy", latencyMs: null, checkedAt: now,
    failureCategory: empty ? "empty_response" : "provider_error",
    error: empty ? "Empty response" : `Hermes failed (exit ${outcome.exitCode}); see the private Hermes session logs`,
  };
}

export type AskImpl = (request: AskRequest) => Promise<AskOutcome>;

export async function probeModel(model: string, config: FallbackConfig, askImpl: AskImpl = ask): Promise<ProbeResult> {
  const attempts = Math.max(1, (config.probeConfig.retries ?? 0) + 1);
  let result: ProbeResult | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const outcome = await askImpl({
      prompt: config.probeConfig.prompt, model, provider: config.fallbackChains[model]?.provider,
      timeoutSec: Math.ceil(probeTimeoutMs(config) / 1000), executor: config.probeExecutor,
    });
    result = classifyProbe(model, outcome, config);
    // Unfunded is deterministic: retrying would only repeat the 402.
    if (result.healthy || result.health === "unfunded") return result;
  }
  return result!;
}

// ── Patients: the profile's cron jobs ───────────────────────────────

const SELF_PATTERN = /agent-model-healer|model healer/i;

function toAgent(job: HermesJob): AgentInfo {
  const text = `${job.name ?? ""} ${job.prompt ?? ""} ${job.script ?? ""} ${(job.skills ?? []).join(" ")} ${job.skill ?? ""}`;
  return { id: job.id, title: job.name || job.id, model: job.model ?? "", provider: job.provider ?? undefined, active: isActive(job), self: SELF_PATTERN.test(text) };
}

function editArgs(id: string, model: string, provider?: string): string[] {
  return ["edit", id, "--model", model, ...(provider ? ["--provider", provider] : [])];
}

// ── Commands ────────────────────────────────────────────────────────

function preflight(config: FallbackConfig): string[] {
  return [...validateProbeSemantics(config).errors, ...validateChain(config).errors];
}

async function cmdValidate() {
  const config = loadConfig();
  const errors = preflight(config);
  const warnings = [...validateChain(config).warnings, ...validateExclusions(config).warnings];
  const healerJobs = loadJobs().filter((job) => toAgent(job).self && isActive(job));
  for (const job of healerJobs) {
    if (!job.no_agent) warnings.push(`Healer job '${job.name || job.id}' runs through a model; schedule it as a no_agent script job (watchmen independence)`);
  }
  console.log(JSON.stringify({ command: "validate", config: configPath(), ok: errors.length === 0, errors, warnings, healingEnabled: config.healingEnabled === true }, null, 2));
  process.exit(errors.length ? 2 : 0);
}

async function cmdProbe() {
  const config = loadConfig();
  const results: ProbeResult[] = [];
  for (const model of Object.keys(config.fallbackChains)) results.push(await probeModel(model, config));
  console.log(JSON.stringify({ command: "probe", results }, null, 2));
}

async function cmdDiagnose() {
  const config = loadConfig();
  const state = loadState();
  const agents = loadJobs().map(toAgent).filter((a) => a.active && a.model);
  const byModel: Record<string, { label: string; chain: boolean; lastProbe?: ProbeHealth; agents: string[] }> = {};
  for (const agent of agents) {
    byModel[agent.model] ??= { label: getModelLabel(agent.model, config), chain: Boolean(config.fallbackChains[agent.model]), lastProbe: state.lastProbe[agent.model]?.health, agents: [] };
    byModel[agent.model]!.agents.push(agent.title);
  }
  console.log(JSON.stringify({ command: "diagnose", pinnedJobs: agents.length, byModel, unchained: Object.entries(byModel).filter(([, v]) => !v.chain).map(([m]) => m) }, null, 2));
}

async function cmdStatus() {
  const state = loadState();
  console.log(JSON.stringify({ command: "status", statePath: statePath(), lastRunAt: state.lastRunAt || null, healCount: state.healCount, restoreCount: state.restoreCount, switches: state.switches, lastProbe: state.lastProbe }, null, 2));
}

export interface AutoDeps { askImpl?: AskImpl; cron?: (args: string[]) => { ok: boolean } }

export async function runAuto(deps: AutoDeps = {}) {
  const askImpl = deps.askImpl ?? ask;
  const cron = deps.cron ?? hermesCron;
  const config = loadConfig();
  const healingEnabled = config.healingEnabled === true;
  const errors = preflight(config);
  if (errors.length) return { phase: "validation_failed", errors };
  for (const warning of validateExclusions(config).warnings) log(`Exclusion note: ${warning}`);
  if (!healingEnabled) log("healingEnabled=false — DRY RUN mode: heal/restore actions are reported, not applied.");

  const state = loadState();
  const agents = loadJobs().map(toAgent);

  // Reconcile: a job whose model no longer matches our record was reassigned by hand (or removed).
  state.switches = state.switches.filter((sw) => {
    const live = agents.find((a) => a.id === sw.agentId);
    if (!live) { log(`Reconcile: drop — job ${sw.agentTitle} no longer exists`); return false; }
    if (live.model !== sw.currentModel) { log(`Reconcile: drop — job ${sw.agentTitle} manually reassigned ${sw.currentModel} → ${live.model}`); return false; }
    return true;
  });

  // Prune probe and streak records for models no longer in a chain or switch.
  const validModels = new Set<string>(Object.keys(config.fallbackChains));
  for (const sw of state.switches) { validModels.add(sw.originalModel); validModels.add(sw.currentModel); }
  for (const m of Object.keys(state.lastProbe)) if (!validModels.has(m)) delete state.lastProbe[m];
  for (const m of Object.keys(state.streaks ?? {})) if (!validModels.has(m)) delete state.streaks![m];

  // Step 1: probe every chain model and every switched-away original.
  const models = new Set<string>(Object.keys(config.fallbackChains));
  for (const sw of state.switches) models.add(sw.originalModel);
  state.streaks ??= {};
  try {
    for (const model of models) {
      const result = await probeModel(model, config, askImpl);
      state.lastProbe[model] = result;
      if (result.health === "unfunded") {
        // Not a health sample: clear the streak so an unfunded model never accrues heal or restore credit.
        delete state.streaks[model];
        log(`  ℹ️ ${getModelLabel(model, config)} — unfunded (skipped)`);
        continue;
      }
      state.streaks[model] = advanceStreak(state.streaks[model], result.healthy, result.checkedAt);
      log(`  ${result.health === "healthy" ? "✅" : result.health === "degraded" ? "⚠️" : "❌"} ${getModelLabel(model, config)} (${result.latencyMs === null ? "no completion" : `${result.latencyMs}ms`})${result.error || result.warning ? ` — ${result.error || result.warning}` : ""}`);
    }
  } catch (error) {
    if (error instanceof ProbeInfrastructureError) {
      saveState(state);
      return { phase: "probe_unavailable", error: error.message };
    }
    throw error;
  }
  state.lastRunAt = new Date().toISOString();

  // Unfunded models are neither healthy (never a fallback target) nor unhealthy (no alarm, no heal).
  const unfunded = new Set(Object.entries(state.lastProbe).filter(([, p]) => p.health === "unfunded").map(([m]) => m));
  const unhealthy = new Set(Object.entries(state.lastProbe).filter(([m, p]) => !p.healthy && !unfunded.has(m)).map(([m]) => m));
  const unfundedJobs = agents.filter((a) => a.active && a.model && !a.self && unfunded.has(a.model)).map((a) => ({ agentId: a.id, agentTitle: a.title, model: a.model, status: "unfunded (skipped)" as const }));
  const healActions: { agentId: string; agentTitle: string; from: string; to: string; reason: string; applied: boolean }[] = [];
  const restoreActions: { agentId: string; agentTitle: string; from: string; to: string; applied: boolean }[] = [];
  const exhaustedAlerts: { agentId: string; agentTitle: string; model: string; chain: string[]; reason: string }[] = [];

  // Step 2: heal jobs pinned to an unhealthy model.
  for (const agent of agents) {
    if (!agent.active || !agent.model || agent.self) continue;
    if (state.switches.some((s) => s.agentId === agent.id)) continue;
    if (!unhealthy.has(agent.model)) continue;
    const uThreshold = unhealthyThreshold(config);
    if (!streakMet(state.streaks[agent.model], false, uThreshold)) {
      log(`HOLD (hysteresis): ${agent.title} on ${getModelLabel(agent.model, config)} at ${state.streaks[agent.model]?.consecutiveUnhealthy ?? 1}/${uThreshold} consecutive unhealthy`);
      continue;
    }
    if (isExcludedModel(agent.model, config)) { log(`SKIP (operator exclusion): ${agent.title} on ${getModelLabel(agent.model, config)}`); continue; }
    const chain = config.fallbackChains[agent.model];
    if (!chain) { log(`No fallback chain for ${agent.model} — skipping ${agent.title}`); continue; }

    let target: string | null = null;
    for (const fb of chain.fallbacks) {
      if (isExcludedModel(fb, config)) continue;
      if (state.lastProbe[fb]?.healthy) { target = fb; break; }
    }
    const reason = state.lastProbe[agent.model]?.failureCategory ?? "unhealthy";
    if (!target) {
      exhaustedAlerts.push({ agentId: agent.id, agentTitle: agent.title, model: agent.model, chain: chain.fallbacks, reason });
      log(`EXHAUSTED: no healthy fallback for ${agent.title} (${getModelLabel(agent.model, config)}) — alert only`);
      continue;
    }
    const tagged = `[rung:${classifyRung(target, getModelLabel(target, config))}] ${reason}`;
    if (!healingEnabled) {
      healActions.push({ agentId: agent.id, agentTitle: agent.title, from: agent.model, to: target, reason: `${tagged} [dry-run]`, applied: false });
      continue;
    }
    const applied = cron(editArgs(agent.id, target, config.fallbackChains[target]?.provider)).ok;
    healActions.push({ agentId: agent.id, agentTitle: agent.title, from: agent.model, to: target, reason: tagged, applied });
    if (applied) {
      state.switches.push({ agentId: agent.id, agentTitle: agent.title, originalModel: agent.model, originalProvider: agent.provider, currentModel: target, switchedAt: new Date().toISOString(), reason: tagged });
      state.healCount++;
      log(`HEALED: ${agent.title} → ${getModelLabel(target, config)}`);
    } else log(`Failed to switch ${agent.title}`);
  }

  // Step 3: restore switched jobs whose original model has recovered.
  const remaining: SwitchRecord[] = [];
  for (const sw of state.switches) {
    if (healActions.some((a) => a.agentId === sw.agentId) || !state.lastProbe[sw.originalModel]?.healthy) { remaining.push(sw); continue; }
    const hThreshold = healthyThreshold(config);
    if (!streakMet(state.streaks[sw.originalModel], true, hThreshold)) { remaining.push(sw); continue; }
    if (!healingEnabled) {
      restoreActions.push({ agentId: sw.agentId, agentTitle: sw.agentTitle, from: sw.currentModel, to: sw.originalModel, applied: false });
      remaining.push(sw);
      continue;
    }
    const applied = cron(editArgs(sw.agentId, sw.originalModel, sw.originalProvider)).ok;
    restoreActions.push({ agentId: sw.agentId, agentTitle: sw.agentTitle, from: sw.currentModel, to: sw.originalModel, applied });
    if (applied) { state.restoreCount++; log(`RESTORED: ${sw.agentTitle} → ${getModelLabel(sw.originalModel, config)}`); }
    else remaining.push(sw);
  }
  state.switches = remaining;
  saveState(state);

  const summary = `${healActions.length} switch(es), ${restoreActions.length} restore(s), ${exhaustedAlerts.length} exhausted, ${unhealthy.size} unhealthy model(s), ${unfunded.size} unfunded (skipped). ${remaining.length} job(s) on fallback.${healingEnabled ? "" : " Dry run."}`;
  log(`Run complete: ${summary}`);
  return { phase: "complete", dryRun: !healingEnabled, healActions, restoreActions, exhaustedAlerts, unhealthy: [...unhealthy], unfunded: [...unfunded], unfundedJobs, summary };
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "validate") return cmdValidate();
  if (command === "probe") return cmdProbe();
  if (command === "diagnose") return cmdDiagnose();
  if (command === "status") return cmdStatus();
  if (command === "auto") {
    const result = await runAuto();
    console.log(JSON.stringify({ command: "auto", ...result }, null, 2));
    // Exit 2 on validation/probe-path failure; 3 when an operator must act (exhausted chain or failed change).
    if (result.phase !== "complete") process.exit(2);
    const failedChange = [...(result.healActions ?? []), ...(result.restoreActions ?? [])].some((a) => !a.applied && !result.dryRun);
    process.exit(result.exhaustedAlerts?.length || failedChange ? 3 : 0);
  }
  console.log(`agent-model-healer
  validate   check chain shape, probe timing, exclusions and the healer's own job
  probe      probe every chain model through the Hermes profile
  diagnose   pinned-model cron jobs grouped by model
  status     healer state (switches, last probes)
  auto       probe → heal/restore (dry run unless healingEnabled) — for a no_agent cron job`);
  if (!["help", "--help", "-h"].includes(command)) process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error) => { console.error(`agent-model-healer: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
