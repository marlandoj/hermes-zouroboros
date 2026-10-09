#!/usr/bin/env bun
/**
 * agent-doctor — audits the Hermes profile's scheduled agents (cron jobs) for:
 *   1. cost-fitness:        model tier vs task complexity (model-tiers.json)
 *   2. banned-model:        models the operator banned for scheduled agents
 *   3. frequency-waste:     high-frequency jobs that should prove an output delta
 *   4. zombie-agents:       enabled jobs that will never fire again
 *   5. duplicates:          materially identical instructions (fleet boilerplate ignored)
 *   6. run-errors:          failing runs and failed deliveries
 *   7. instruction-hygiene: missing scripts, workdirs or referenced absolute paths
 *   8. schedule-collision:  many jobs on the same cron expression
 *   9. delivery-method:     internal maintenance jobs that message a chat platform
 *  10. instruction-length:  long instructions on budget models
 *  11. output-delta:        consecutive saved outputs that are identical
 *
 * hermes-zouroboros: replaces the source workspace's Zo automation audit. Jobs are read from the
 * profile's $HERMES_HOME/cron/jobs.json; `apply` changes them only through `hermes cron pause|edit`.
 *
 * Usage:
 *   bun doctor.ts [diagnose|summary|apply [--dry-run]|<check>] [--json]
 * Exit codes: 0 clean, 2 findings present (or changes applied), 1 error.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../../../../integration/profile.ts";
import {
  hermesCron, isActive, jobsFile, loadJobs, profileDefaultModel, recentOutputs, scriptPath, type HermesJob,
} from "./hermes-cron.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  title: string;
  /** Prompt plus attached skills: what the job asks the agent to do. */
  instruction: string;
  /** False when only a preview of the instruction is available (never for jobs.json). */
  instructionComplete: boolean;
  /** Effective model id; the profile default when the job sets none. */
  model: string;
  /** True when the job pins its own model (only those can be edited per job). */
  modelPinned: boolean;
  active: boolean;
  /** Cron expression or "every Nm" display. */
  schedule: string;
  runsPerDay: number;
  nextRun: string | null;
  deliver: string | null;
  script: string | null;
  noAgent: boolean;
  workdir: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDeliveryError: string | null;
  failureStreak: number;
}

export interface Finding {
  check: string;
  severity: "critical" | "warning" | "info";
  agentId: string;
  agentTitle: string;
  message: string;
  recommendation: string;
}

/** A model reference: an id, or an id plus a Hermes provider. */
export type ModelRef = string | { model: string; provider?: string };

export interface ModelTiers {
  tiers: Record<string, { maxCostPer1kInput: number; models: string[]; labels: string[] }>;
  taskComplexity: Record<string, { description: string; recommendedTier: string; signals: string[] }>;
  downgradeDefaults: { bannedModelFallback: ModelRef; byTier: Record<string, ModelRef> };
  bannedAgentModels?: Record<string, string>;
  /** Job ids the doctor must never mutate, in addition to its own and the healer's jobs. */
  safetyExcludeIds?: string[];
}

// ── Config ──────────────────────────────────────────────────────────

const EXAMPLE_TIERS = join(import.meta.dir, "../assets/model-tiers.example.json");

/** Operator catalog: $ZOUROBOROS_CONFIG_DIR/agent-doctor/model-tiers.json, else the shipped example. */
export function tiersPath(): string {
  const configDir = process.env.ZOUROBOROS_CONFIG_DIR || join(paths().data, "config");
  const operator = process.env.AGENT_DOCTOR_TIERS || join(configDir, "agent-doctor", "model-tiers.json");
  return existsSync(operator) ? operator : EXAMPLE_TIERS;
}

export function loadTiers(path = tiersPath()): ModelTiers {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const SELF_PATTERN = /agent-doctor|agent-model-healer/i;
const DEPRECATED_PATTERNS = [
  { pattern: /zo\.computer|\/zo\/ask/i, label: "Zo Computer API (not available to Hermes jobs)" },
  { pattern: /omniroute/i, label: "OmniRoute (removed)" },
];

// ── Helpers ─────────────────────────────────────────────────────────

/** Rough runs/day for a Hermes schedule (cron minute and hour fields; day fields treated as daily). */
export function runsPerDay(schedule: HermesJob["schedule"]): number {
  if (!schedule) return 0;
  if (schedule.kind === "interval" && schedule.minutes) return 1440 / schedule.minutes;
  if (schedule.kind !== "cron" || !schedule.expr) return 0;
  const [minute = "*", hour = "*"] = schedule.expr.trim().split(/\s+/);
  const count = (field: string, size: number): number => {
    let total = 0;
    for (const part of field.split(",")) {
      const [range, step] = part.split("/");
      const stride = Math.max(1, Number(step) || 1);
      if (range === "*") { total += Math.ceil(size / stride); continue; }
      const [lo, hi] = range!.split("-").map(Number);
      if (!Number.isFinite(lo)) return 1;
      total += hi === undefined || !Number.isFinite(hi) ? 1 : Math.floor((hi - lo!) / stride) + 1;
    }
    return total;
  };
  return count(minute, 60) * count(hour, 24);
}

export function toAgent(job: HermesJob, defaultModel: string): AgentInfo {
  const skills = job.skills?.length ? job.skills : job.skill ? [job.skill] : [];
  return {
    id: job.id,
    title: job.name || job.id,
    instruction: [job.prompt ?? "", skills.length ? `Skills: ${skills.join(", ")}` : ""].filter(Boolean).join("\n"),
    instructionComplete: true,
    model: job.model || defaultModel || "(profile default)",
    modelPinned: Boolean(job.model),
    active: isActive(job),
    schedule: job.schedule?.expr ?? job.schedule?.display ?? "",
    runsPerDay: runsPerDay(job.schedule),
    nextRun: job.next_run_at ?? null,
    deliver: job.deliver ?? null,
    script: job.script ?? null,
    noAgent: Boolean(job.no_agent),
    workdir: job.workdir ?? null,
    lastStatus: job.last_status ?? null,
    lastError: job.last_error ?? null,
    lastDeliveryError: job.last_delivery_error ?? null,
    failureStreak: Number(job.failure_streak ?? 0),
  };
}

function getModelTier(model: string, tiers: ModelTiers): string {
  for (const [tierName, tier] of Object.entries(tiers.tiers)) {
    if (tier.models.includes(model)) return tierName;
  }
  return "unknown";
}

function getModelLabel(model: string, tiers: ModelTiers): string {
  for (const tier of Object.values(tiers.tiers)) {
    const idx = tier.models.indexOf(model);
    if (idx >= 0) return tier.labels[idx] || model;
  }
  return model;
}

const TIER_RANK: Record<string, number> = { budget: 0, standard: 1, premium: 2, expensive: 3 };

function classifyTask(instruction: string, tiers: ModelTiers): { type: string; recommendedTier: string } {
  const lower = instruction.toLowerCase();
  let bestMatch = { type: "unknown", recommendedTier: "standard", score: 0 };

  for (const [taskType, config] of Object.entries(tiers.taskComplexity)) {
    let score = 0;
    for (const signal of config.signals) {
      const regex = new RegExp(signal, "i");
      if (regex.test(lower)) score++;
    }
    if (score > bestMatch.score) {
      bestMatch = { type: taskType, recommendedTier: config.recommendedTier, score };
    }
  }
  return bestMatch;
}

function instructionTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
}

// Jaccard similarity over content tokens. Symmetric, so a short instruction fully contained in a
// long one does not score 100% the way an intersection/min overlap coefficient does.
export function instructionSimilarity(a: string, b: string, ignore: Set<string> = new Set()): number {
  const wordsA = new Set([...instructionTokens(a)].filter((w) => !ignore.has(w)));
  const wordsB = new Set([...instructionTokens(b)].filter((w) => !ignore.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / (wordsA.size + wordsB.size - intersection);
}

// Tokens present in at least half the fleet are shared boilerplate (preambles, standing
// directives, preflight wording) and carry no signal about what an agent does.
const FLEET_COMMON_MIN_AGENTS = 5;
const FLEET_COMMON_RATIO = 0.5;

function fleetCommonTokens(agents: AgentInfo[]): Set<string> {
  if (agents.length < FLEET_COMMON_MIN_AGENTS) return new Set();
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const token of instructionTokens(agent.instruction)) counts.set(token, (counts.get(token) || 0) + 1);
  }
  const threshold = Math.ceil(agents.length * FLEET_COMMON_RATIO);
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([token]) => token));
}

function finding(agent: AgentInfo, check: string, severity: Finding["severity"], message: string, recommendation: string): Finding {
  return { check, severity, agentId: agent.id, agentTitle: agent.title, message, recommendation };
}

// ── Checks ──────────────────────────────────────────────────────────

export function checkCostFitness(agents: AgentInfo[], tiers: ModelTiers): Finding[] {
  const findings: Finding[] = [];
  const unknownModels = new Map<string, AgentInfo[]>();

  for (const agent of agents) {
    if (!agent.active || agent.noAgent) continue;

    const modelTier = getModelTier(agent.model, tiers);
    if (modelTier === "unknown") {
      // Never rank an off-catalog model: a downgrade based on a guessed tier moves jobs off models
      // nobody classified. Group and report so the catalog gets updated.
      const group = unknownModels.get(agent.model) || [];
      group.push(agent);
      unknownModels.set(agent.model, group);
      continue;
    }
    const task = classifyTask(agent.instruction, tiers);
    const modelRank = TIER_RANK[modelTier] ?? 1;
    const taskRank = TIER_RANK[task.recommendedTier] ?? 1;
    const overshoot = modelRank - taskRank;

    if (overshoot >= 2) {
      findings.push(finding(agent, "cost-fitness", "critical",
        `Model ${getModelLabel(agent.model, tiers)} (${modelTier}) is ${overshoot} tiers above recommended for ${task.type} (${task.recommendedTier})`,
        `Downgrade to ${task.recommendedTier} tier`));
    } else if (overshoot === 1) {
      findings.push(finding(agent, "cost-fitness", "warning",
        `Model ${getModelLabel(agent.model, tiers)} (${modelTier}) is 1 tier above recommended for ${task.type} (${task.recommendedTier})`,
        `Consider downgrading to ${task.recommendedTier} tier`));
    }
  }

  for (const [model, group] of unknownModels) {
    findings.push({
      check: "model-catalog",
      severity: "warning",
      agentId: group[0]!.id,
      agentTitle: group.length === 1 ? group[0]!.title : `${group.length} agents (${group.map((a) => a.title).join(", ")})`,
      message: `Model ${model} is not in model-tiers.json; cost fitness was not evaluated for ${group.length} agent(s)`,
      recommendation: `Add ${model} to a tier in the operator model-tiers.json so cost fitness can be scored`,
    });
  }
  return findings;
}

export function checkBannedModels(agents: AgentInfo[], tiers: ModelTiers): Finding[] {
  const banned = new Map(Object.entries(tiers.bannedAgentModels ?? {}));
  return agents.filter((a) => a.active && !a.noAgent && banned.has(a.model)).map((agent) =>
    finding(agent, "banned-model", "critical", `Banned model in use: ${banned.get(agent.model)}`,
      `Switch to the catalog's bannedModelFallback model`));
}

export function checkFrequencyWaste(agents: AgentInfo[]): Finding[] {
  return agents.filter((a) => a.active && a.runsPerDay >= 12).map((agent) =>
    finding(agent, "frequency-waste", "warning",
      `Runs ~${agent.runsPerDay.toFixed(0)} times/day. High-frequency agents should have verified output deltas.`,
      `Review recent outputs. If output is static, reduce to every 4-6h.`));
}

export function checkZombieAgents(agents: AgentInfo[]): Finding[] {
  return agents.filter((a) => a.active && !a.nextRun).map((agent) =>
    finding(agent, "zombie-agents", "warning",
      `No next_run_at scheduled (repeat count exhausted or schedule ended). Job is enabled but will never fire.`,
      `Pause or remove this job.`));
}

export function checkDuplicates(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];
  // Preview text is only a shared preamble; comparing it produces fleet-wide false positives.
  // Only complete instructions are evidence.
  const active = agents.filter((a) => a.active && a.instructionComplete);
  const common = fleetCommonTokens(active);

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const sim = instructionSimilarity(active[i]!.instruction, active[j]!.instruction, common);
      if (sim > 0.6) {
        findings.push({
          check: "duplicates",
          severity: sim > 0.8 ? "critical" : "warning",
          agentId: active[i]!.id,
          agentTitle: `${active[i]!.title} ↔ ${active[j]!.title}`,
          message: `${(sim * 100).toFixed(0)}% instruction overlap. Possible consolidation candidate.`,
          recommendation: `Review both agents for merge opportunity. Keep the one with better scheduling.`,
        });
      }
    }
  }
  return findings;
}

export function checkRunErrors(agents: AgentInfo[]): Finding[] {
  const findings: Finding[] = [];
  for (const agent of agents) {
    if (!agent.active) continue;
    if (agent.lastStatus === "error") {
      findings.push(finding(agent, "run-errors", agent.failureStreak >= 3 ? "critical" : "warning",
        `Last run failed${agent.failureStreak > 1 ? ` (${agent.failureStreak} in a row)` : ""}: ${(agent.lastError ?? "no error text").slice(0, 160)}`,
        `Inspect \`hermes cron runs ${agent.id}\`; if the model is failing, see agent-model-healer.`));
    }
    if (agent.lastDeliveryError) {
      findings.push(finding(agent, "run-errors", "warning",
        `Last delivery failed: ${agent.lastDeliveryError.slice(0, 160)}`,
        `Check the delivery target (${agent.deliver ?? "default"}) or set delivery to local.`));
    }
  }
  return findings;
}

export function checkInstructionHygiene(agents: AgentInfo[], home?: string): Finding[] {
  const findings: Finding[] = [];
  for (const agent of agents) {
    if (!agent.active) continue;
    const missing: string[] = [];
    if (agent.script && !existsSync(scriptPath(agent.script, home))) missing.push(`script ${agent.script}`);
    if (agent.workdir && !existsSync(agent.workdir)) missing.push(`workdir ${agent.workdir}`);
    for (const raw of agent.instruction.match(/(?<![\w.~])\/(?:[\w.-]+\/)+[\w.-]+/g) ?? []) {
      // Trailing sentence punctuation is not part of a path; drop it one character at a time.
      let candidate = raw;
      while (/[.,;:!?]$/.test(candidate) && !existsSync(candidate)) candidate = candidate.slice(0, -1);
      if (/[*?{$]/.test(candidate)) continue;
      if (!existsSync(candidate) && !existsSync(dirname(candidate))) missing.push(candidate);
    }
    if (missing.length > 0) {
      findings.push(finding(agent, "instruction-hygiene", missing.length > 2 ? "critical" : "warning",
        `References ${missing.length} missing path(s): ${missing.slice(0, 3).join(", ")}`,
        `Update the job with correct paths or remove stale references.`));
    }
    for (const { pattern, label } of DEPRECATED_PATTERNS) {
      if (pattern.test(agent.instruction)) {
        findings.push(finding(agent, "instruction-hygiene", "warning", `References deprecated component: ${label}`,
          `Remove or update the stale reference.`));
      }
    }
  }
  return findings;
}

export function checkScheduleCollisions(agents: AgentInfo[]): Finding[] {
  const bySchedule = new Map<string, AgentInfo[]>();
  for (const a of agents.filter((agent) => agent.active && agent.schedule)) {
    bySchedule.set(a.schedule, [...(bySchedule.get(a.schedule) ?? []), a]);
  }
  return [...bySchedule].filter(([, group]) => group.length >= 4).map(([schedule, group]) => ({
    check: "schedule-collision",
    severity: "info" as const,
    agentId: group.map((a) => a.id).join(","),
    agentTitle: `${group.length} jobs on "${schedule}"`,
    message: `${group.length} jobs fire together: ${group.map((a) => a.title.substring(0, 30)).join(", ")}`,
    recommendation: `Stagger schedules to reduce concurrent load.`,
  }));
}

const INTERNAL_KEYWORDS = ["index", "embed", "decay", "sync", "capture", "vault", "pipeline", "ingestion", "backfill", "healer", "doctor"];
const LOCAL_DELIVERY = new Set(["local", "none", ""]);

export function checkDeliveryMethod(agents: AgentInfo[]): Finding[] {
  return agents.filter((agent) => {
    if (!agent.active) return false;
    const target = (agent.deliver ?? "").toLowerCase();
    const lower = `${agent.title} ${agent.instruction}`.toLowerCase();
    return !LOCAL_DELIVERY.has(target) && target !== "origin" && INTERNAL_KEYWORDS.some((k) => lower.includes(k));
  }).map((agent) => finding(agent, "delivery-method", "info",
    `Internal maintenance job delivers to ${agent.deliver}. Adds chat noise for routine ops.`,
    `Set delivery to local and only escalate on failure.`));
}

export function checkInstructionLength(agents: AgentInfo[], tiers: ModelTiers): Finding[] {
  const findings: Finding[] = [];
  for (const agent of agents) {
    if (!agent.active || agent.noAgent) continue;
    const modelTier = getModelTier(agent.model, tiers);
    const instrTokenEstimate = Math.ceil(agent.instruction.length / 4); // rough token estimate
    if (modelTier === "budget" && instrTokenEstimate > 500) {
      findings.push(finding(agent, "instruction-length", instrTokenEstimate > 1000 ? "critical" : "warning",
        `~${instrTokenEstimate} instruction tokens on budget model. Budget models degrade with complex instructions.`,
        `Simplify instruction to <500 tokens or upgrade model to standard tier.`));
    } else if (modelTier === "standard" && instrTokenEstimate > 1500) {
      findings.push(finding(agent, "instruction-length", "info",
        `~${instrTokenEstimate} instruction tokens. Consider whether all detail is necessary.`,
        `Review instruction for redundancy. Move static reference data to files.`));
    }
  }
  return findings;
}

export function checkOutputDelta(agents: AgentInfo[], home?: string): Finding[] {
  const findings: Finding[] = [];
  for (const agent of agents) {
    if (!agent.active) continue;
    // Saved outputs carry a "**Run Time:**" header line; compare everything else.
    const bodies = recentOutputs(agent.id, 3, home).map((text) => text.replace(/^\*\*Run Time:\*\*.*$/gm, "").trim());
    if (bodies.length < 3) continue;
    const hashes = new Set(bodies.map((body) => createHash("sha256").update(body).digest("hex")));
    if (hashes.size === 1) {
      findings.push(finding(agent, "output-delta", "warning",
        `Last ${bodies.length} saved outputs are identical. The job may be running without producing value.`,
        `Reduce frequency, or make the job deliver only on change.`));
    }
  }
  return findings;
}

// ── Orchestration ───────────────────────────────────────────────────

const CHECKS: Record<string, (agents: AgentInfo[], tiers: ModelTiers, home?: string) => Finding[]> = {
  cost: checkCostFitness,
  banned: checkBannedModels,
  frequency: (a) => checkFrequencyWaste(a),
  zombies: (a) => checkZombieAgents(a),
  duplicates: (a) => checkDuplicates(a),
  errors: (a) => checkRunErrors(a),
  hygiene: (a, _t, home) => checkInstructionHygiene(a, home),
  collisions: (a) => checkScheduleCollisions(a),
  delivery: (a) => checkDeliveryMethod(a),
  length: checkInstructionLength,
  delta: (a, _t, home) => checkOutputDelta(a, home),
};

export function diagnose(agents: AgentInfo[], tiers: ModelTiers, only?: string, home?: string): Finding[] {
  const names = only ? [only] : Object.keys(CHECKS);
  return names.flatMap((name) => CHECKS[name]!(agents, tiers, home));
}

function modelArgs(ref: ModelRef | undefined): string[] | null {
  if (!ref) return null;
  const model = typeof ref === "string" ? ref : ref.model;
  if (!model) return null;
  const provider = typeof ref === "string" ? undefined : ref.provider;
  return ["--model", model, ...(provider ? ["--provider", provider] : [])];
}

export interface PlannedChange { agentId: string; agentTitle: string; reason: string; args: string[] }

/** Safe, automatic fixes: pause zombies, move banned or 2+-tier-overshoot pinned models, silence internal delivery. */
export function planCorrections(agents: AgentInfo[], findings: Finding[], tiers: ModelTiers, jobs: HermesJob[]): PlannedChange[] {
  const excluded = new Set(tiers.safetyExcludeIds ?? []);
  for (const job of jobs) {
    if (SELF_PATTERN.test(`${job.name ?? ""} ${job.prompt ?? ""} ${job.script ?? ""} ${(job.skills ?? []).join(" ")} ${job.skill ?? ""}`)) excluded.add(job.id);
  }
  const byId = new Map(agents.map((a) => [a.id, a]));
  const planned = new Map<string, PlannedChange>();
  for (const f of findings) {
    const agent = byId.get(f.agentId);
    if (!agent || excluded.has(agent.id) || planned.has(`${agent.id}:${f.check}`)) continue;
    let args: string[] | null = null;
    if (f.check === "zombie-agents") args = ["pause", agent.id];
    else if (f.check === "banned-model" && agent.modelPinned) {
      const fix = modelArgs(tiers.downgradeDefaults.bannedModelFallback);
      args = fix && ["edit", agent.id, ...fix];
    } else if (f.check === "cost-fitness" && f.severity === "critical" && agent.modelPinned) {
      const tier = classifyTask(agent.instruction, tiers).recommendedTier;
      const fix = modelArgs(tiers.downgradeDefaults.byTier[tier]);
      args = fix && ["edit", agent.id, ...fix];
    } else if (f.check === "delivery-method") args = ["edit", agent.id, "--deliver", "local"];
    if (args) planned.set(`${agent.id}:${f.check}`, { agentId: agent.id, agentTitle: agent.title, reason: `${f.check}: ${f.message}`, args });
  }
  return [...planned.values()];
}

function formatReport(findings: Finding[], agents: AgentInfo[], source: string): string {
  const lines = [`Agent Doctor — ${agents.length} scheduled job(s) (${agents.filter((a) => a.active).length} active) from ${source}`, ""];
  if (!findings.length) return [...lines, "No findings. Fleet is healthy."].join("\n");
  const icon = { critical: "🔴", warning: "🟡", info: "🔵" } as const;
  for (const severity of ["critical", "warning", "info"] as const) {
    for (const f of findings.filter((x) => x.severity === severity)) {
      lines.push(`${icon[severity]} [${f.check}] ${f.agentTitle}`, `   ${f.message}`, `   → ${f.recommendation}`);
    }
  }
  lines.push("", formatSummary(findings));
  return lines.join("\n");
}

function formatSummary(findings: Finding[]): string {
  const count = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  return `agent-doctor: ${findings.length} finding(s) — ${count("critical")} critical, ${count("warning")} warning, ${count("info")} info`;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const command = args.find((a) => !a.startsWith("--")) ?? "diagnose";
  const source = jobsFile();
  const tiers = loadTiers();
  const jobs = loadJobs(source);
  const defaultModel = profileDefaultModel();
  const agents = jobs.map((job) => toAgent(job, defaultModel));
  const home = dirname(dirname(source));

  if (command !== "diagnose" && command !== "summary" && command !== "apply" && !CHECKS[command]) {
    console.error(`Unknown command ${command}. Use diagnose, summary, apply or one of: ${Object.keys(CHECKS).join(", ")}`);
    process.exit(1);
  }
  const findings = diagnose(agents, tiers, CHECKS[command] ? command : undefined, home);

  if (command === "apply") {
    const changes = planCorrections(agents, findings, tiers, jobs);
    const results = changes.map((change) => dryRun ? { ...change, applied: false } : { ...change, applied: hermesCron(change.args).ok });
    const failed = results.filter((r) => !dryRun && !r.applied);
    if (json) console.log(JSON.stringify({ dryRun, changes: results, findings }, null, 2));
    else {
      console.log(formatReport(findings, agents, source));
      console.log(`\n${dryRun ? "Would apply" : "Applied"} ${results.length} change(s):`);
      for (const r of results) console.log(`  ${dryRun ? "•" : r.applied ? "✅" : "❌"} hermes cron ${r.args.join(" ")}  (${r.reason})`);
    }
    process.exit(failed.length ? 1 : results.length || findings.length ? 2 : 0);
  }
  if (json) console.log(JSON.stringify({ source, tiers: tiersPath() === EXAMPLE_TIERS ? "example" : "operator", agents: agents.length, findings }, null, 2));
  else console.log(command === "summary" ? formatSummary(findings) : formatReport(findings, agents, source));
  process.exit(findings.length ? 2 : 0);
}

if (import.meta.main) {
  main().catch((error) => { console.error(`agent-doctor: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
