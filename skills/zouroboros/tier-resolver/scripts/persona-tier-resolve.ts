#!/usr/bin/env bun

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";
import { appendFile, rename } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import {
  CALIBRATION_VALIDATION_SPLITS,
  DEFAULT_TIER_THRESHOLDS,
  feedbackTaskText,
  MAX_FEEDBACK_TASK_CHARS,
  MIN_CALIBRATION_CORRECTIONS,
  MIN_CALIBRATION_HOLDOUT,
  normalizeWeightsToTotal,
  sanitizeTaskText,
  stratifiedCalibrationSplit,
  stratifiedCalibrationSplits,
  type TierThresholds,
  validateTierThresholds,
  validateWeightValues,
} from "./routing-calibration.ts";

export { sanitizeTaskText } from "./routing-calibration.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type ComplexityTier = "trivial" | "simple" | "moderate" | "complex" | "apex";
export type TaskType = "coding" | "review" | "planning" | "analysis" | "debugging" | "documentation" | "general" | "data_science" | "devops" | "security" | "content";
export type ConstraintType = "budget" | "latency" | "quality" | "speed";
export type ConstraintValue = "low" | "medium" | "high";
export type ConstraintSource = "explicit" | "inferred" | "default";
export type ScopeModifier = "quick" | "thorough" | "experimental" | "production";

export interface ComplexitySignal {
  name: string;
  rawValue: number;
  normalizedScore: number;
  weight: number;
}

export interface ConstraintSpec {
  type: ConstraintType;
  value: ConstraintValue;
  source: ConstraintSource;
  priority: number;
}

export interface DomainPattern {
  domain: string;
  subdomain: string | null;
  techStack: string[];
  complexityModifier: number;
}

export interface SemanticMatch {
  taskType: TaskType;
  confidence: number;
  matchMethod: "keyword" | "synonym" | "contextual";
  evidenceTokens: string[];
}

export interface ComplexityEstimate {
  tier: ComplexityTier;
  score: number;
  signals: ComplexitySignal[];
  inferredTaskType: TaskType;
  semanticMatch: SemanticMatch;
  domainPattern: DomainPattern | null;
  constraints: ConstraintSpec[];
  scopeModifier: ScopeModifier | null;
  _legacy?: {
    wordCount: number;
    fileCount: number;
    hasMultiStep: boolean;
    hasTool: boolean;
    hasAnalysis: boolean;
  };
}

export interface FeedbackEntry {
  id: string;
  timestamp: number;
  taskText: string;
  recommendedTier: ComplexityTier;
  recommendedModel: string;
  actualTier?: ComplexityTier;
  correctedTier?: ComplexityTier;
  signals: ComplexitySignal[];
  outcome?: "success" | "failure" | "unknown";
  persona?: string;
  inputLength?: number;
  taskTextTruncated?: boolean;
  taskTextSanitized?: boolean;
}

export interface WeightConfig {
  version: number;
  lastUpdated: number;
  feedbackCount: number;
  weights: Record<string, number>;
  thresholds: TierThresholds;
  performance: {
    precision: Record<ComplexityTier, number>;
    recall: Record<ComplexityTier, number>;
    f1: Record<ComplexityTier, number>;
  };
  calibration?: {
    promotedAt: number;
    trainingCount: number;
    holdoutCount: number;
    baselineTrainingAccuracy: number;
    candidateTrainingAccuracy: number;
    baselineHoldoutAccuracy: number;
    candidateHoldoutAccuracy: number;
    datasetFingerprint: string;
    weightTotal: number;
    validationSplits: number;
    baselineValidationAccuracy: number;
    candidateValidationAccuracy: number;
    thresholds: TierThresholds;
  };
}

export interface ModelEntry {
  id: string;
  provider: string;
  label: string;
  costTier: "low" | "medium" | "high";
  traits: string[];
  agentSafe?: boolean;
  structuredOutputSafe?: boolean;
}

export interface ExternalRoutingConfig {
  enabled: boolean;
  /** Set when the operator has disabled the capability deliberately. Recorded so a
   *  future edit cannot mistake an operator hold for a by-design default. */
  deprecated?: boolean;
  deprecatedAt?: string;
  deprecatedReason?: string;
  reactivationRequires?: string;
  tiers: ComplexityTier[];
  interactiveOnly: boolean;
  minContextLength: number;
  allowFreeTier: boolean;
  byokMap: Record<string, string>;
}

export interface ModelsConfig {
  version: number;
  defaultFallback?: string;
  agentFallback?: string;
  structuredOutputFallback?: string;
  models: Record<string, ModelEntry>;
  tierDefaults: Record<ComplexityTier, string>;
  taskOverrides: Record<string, Partial<Record<ComplexityTier, string>>>;
  personaOverrides: Record<string, Partial<Record<ComplexityTier, string>>>;
  constraintModifiers: Record<string, Partial<Record<ComplexityTier, string>>>;
  externalRouting?: ExternalRoutingConfig;
}

export interface ExternalCandidate {
  id: string;
  provider: string;
  family: string;
  tier: string;
  costTier: string;
  contextLength: number;
  promptCost: number;
  completionCost: number;
}

export interface ModelRecommendation {
  modelKey: string;
  modelId: string;
  provider: string;
  label: string;
  costTier: string;
  reason: string;
  alternatives: { modelKey: string; modelId: string; reason: string }[];
  externalRouted?: boolean;
  externalCandidate?: ExternalCandidate | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Portable layout: the skill tree is read-only and ships only reviewed defaults.
// Operator catalogs live in the config dir; feedback and tuned weights are runtime state.
const ASSETS_DIR = resolve(__dirname, "../assets");
const CONFIG_DIR = process.env.TIER_RESOLVER_CONFIG_DIR
  || (process.env.ZOUROBOROS_CONFIG_DIR ? resolve(process.env.ZOUROBOROS_CONFIG_DIR, "tier-resolver") : "");
const STATE_DIR = process.env.TIER_RESOLVER_STATE_DIR
  || (process.env.ZOUROBOROS_STATE_DIR ? resolve(process.env.ZOUROBOROS_STATE_DIR, "tier-resolver") : "");
const FEEDBACK_FILE = STATE_DIR ? resolve(STATE_DIR, "feedback.jsonl") : "";
const WEIGHTS_FILE = STATE_DIR ? resolve(STATE_DIR, "weights.json") : "";
const MODELS_FILE = CONFIG_DIR && existsSync(resolve(CONFIG_DIR, "models.json"))
  ? resolve(CONFIG_DIR, "models.json")
  : resolve(ASSETS_DIR, "models.default.json");
const EXTERNAL_POOL_FILE = CONFIG_DIR ? resolve(CONFIG_DIR, "external-models.json") : "";

function requireStateDir(): void {
  if (!STATE_DIR) throw new Error("Feedback needs ZOUROBOROS_STATE_DIR or TIER_RESOLVER_STATE_DIR (the skill tree is never written).");
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

// Cheap resolver tiers map onto the external pool's "fast" bucket. flagship/coder
// are intentionally excluded — Option B only substitutes the low-stakes tiers.
const EXTERNAL_TIER_MAP: Partial<Record<ComplexityTier, string>> = {
  trivial: "fast",
  simple: "fast",
};

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  debugging: ["debug", "bug", "error", "crash", "broken", "stacktrace", "exception", "failure", "troubleshoot", "diagnose", "memory leak", "race condition", "deadlock"],
  analysis: ["analyze", "analyse", "assess", "evaluate", "audit", "investigate", "research", "compare", "examine", "inspect", "study", "explore", "benchmark", "measure", "profile"],
  review: ["review", "pr", "pull request", "code review", "diff", "feedback", "critique", "assess code", "examine code", "compare"],
  planning: ["plan", "design", "architect", "roadmap", "strategy", "outline", "proposal", "rfc", "spec", "blueprint", "scheme"],
  documentation: ["document", "readme", "docs", "write up", "explain", "tutorial", "guide", "manual", "howto", "walkthrough"],
  coding: ["implement", "build", "create", "write", "code", "develop", "add", "refactor", "migrate", "deploy", "construct", "program"],
  data_science: ["model", "train", "dataset", "ml", "machine learning", "ai", "neural", "pandas", "numpy", "scikit", "tensorflow", "pytorch", "data analysis", "predict", "classification", "regression"],
  devops: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "k8s", "terraform", "ansible", "jenkins", "github actions", "infrastructure", "provision", "orchestrate"],
  security: ["security", "vulnerability", "cve", "exploit", "penetration", "compliance", "gdpr", "hipaa", "pci", "sox", "encryption", "owasp", "xss", "sql injection", "gdpr compliance", "security audit", "penetration testing"],
  content: ["write", "blog", "article", "post", "copy", "content", "marketing", "seo", "draft", "compose"],
  general: [],
};

const TECH_STACK_PATTERNS: Record<string, RegExp> = {
  react: /\b(react|jsx|tsx|next\.?js)\b/i,
  vue: /\b(vue|vuex|nuxt)\b/i,
  angular: /\b(angular|ng)\b/i,
  node: /\b(node\.?js|express|fastify|koa)\b/i,
  python: /\b(python|django|flask|fastapi)\b/i,
  docker: /\b(docker|container|dockerfile)\b/i,
  kubernetes: /\b(k8s|kubernetes|kubectl|helm)\b/i,
  terraform: /\b(terraform|tf|hcl)\b/i,
  aws: /\b(aws|ec2|s3|lambda|cloudfront)\b/i,
  gcp: /\b(gcp|google cloud|bigquery)\b/i,
  azure: /\b(azure|azuread)\b/i,
  postgres: /\b(postgres|postgresql|pg)\b/i,
  mongodb: /\b(mongo|mongodb)\b/i,
  redis: /\b(redis|cache)\b/i,
  graphql: /\b(graphql|gql)\b/i,
  grpc: /\b(grpc|protobuf)\b/i,
  oauth: /\b(oauth|oauth2|openid|oidc)\b/i,
  jwt: /\b(jwt|json web token)\b/i,
  auth: /\b(authentication|authorization|mfa|2fa|totp|saml|sso)\b/i,
  security: /\b(security|encrypt|decrypt|vulnerability|penetration|xss|csrf|injection)\b/i,
};

const SCOPE_MODIFIER_PATTERNS: Record<ScopeModifier, RegExp> = {
  quick: /(?<![a-z])quick|faster|rapidly|asap|urgently|immediately|briefly/gi,
  thorough: /(?<![a-z])thorough|comprehensive|complete(?:\s|$)|detailed|exhaustive|in-depth|careful(?:\s|$)/gi,
  experimental: /(?<![a-z])experiment|prototype|poc|proof\s+of\s+concept|spike|explore(?:\s|$)|try\s+(?:this|it|and\s+see)/gi,
  production: /(?<![a-z])production(?:\s|$)|(?<![a-z])prod(?:\s|$)|(?<![a-z])live(?:\s|$)|(?<![a-z])deploy(?:\s|$)|(?<![a-z])release(?:\s|$)|(?<![a-z])ship(?:\s|$)/gi,
};

const CONSTRAINT_PATTERNS: Record<ConstraintType, Record<ConstraintValue, RegExp>> = {
  budget: {
    low: /\b(cheap|free|low cost|budget|economical|inexpensive|minimal cost)\b/i,
    medium: /\b(reasonable cost|moderate budget|standard pricing)\b/i,
    high: /\b(premium|expensive|high cost|no budget limit|unlimited budget)\b/i,
  },
  latency: {
    low: /\b(fast|quick|immediate|instant|low latency|responsive)\b/i,
    medium: /\b(normal speed|moderate latency|reasonable time)\b/i,
    high: /\b(slow|batch|background|can wait|high latency ok)\b/i,
  },
  quality: {
    low: /\b(draft|rough|quick pass|good enough|acceptable)\b/i,
    medium: /\b(standard quality|production ready|professional)\b/i,
    high: /\b(perfect|flawless|highest quality|thorough|comprehensive)\b/i,
  },
  speed: {
    low: /\b(slow|careful|methodical|deliberate)\b/i,
    medium: /\b(normal pace|standard speed)\b/i,
    high: /\b(fast|quick|rapid|urgent|asap|immediate)\b/i,
  },
};

const DEFAULT_WEIGHTS: WeightConfig = {
  version: 1,
  lastUpdated: Date.now(),
  feedbackCount: 0,
  weights: {
    wordCount: 0.04,
    fileRefs: 0.02,
    multiStep: 0.10,
    toolUsage: 0.04,
    analysisDepth: 0.08,
    domainComplexity: 0.10,
    techStackDepth: 0.10,
    conceptCount: 0.20,
    taskVerbComplexity: 0.10,
    scopeBreadth: 0.12,
    featureListCount: 0.20,
    operationalRisk: 0,
  },
  thresholds: { ...DEFAULT_TIER_THRESHOLDS },
  performance: {
    precision: { trivial: 0, simple: 0, moderate: 0, complex: 0, apex: 0 },
    recall: { trivial: 0, simple: 0, moderate: 0, complex: 0, apex: 0 },
    f1: { trivial: 0, simple: 0, moderate: 0, complex: 0, apex: 0 },
  },
};

// ============================================================================
// WEIGHT MANAGEMENT
// ============================================================================

let cachedWeights: WeightConfig | null = null;

function cloneDefaultWeights(): WeightConfig {
  return structuredClone(DEFAULT_WEIGHTS);
}

function assertValidWeightConfig(candidate: unknown): asserts candidate is WeightConfig {
  if (!candidate || typeof candidate !== "object") throw new Error("weight config must be an object");
  const config = candidate as Partial<WeightConfig>;
  if (config.version !== 1) throw new Error(`unsupported weight config version: ${config.version}`);
  if (!config.weights || typeof config.weights !== "object") throw new Error("weight config is missing weights");
  const validation = validateWeightValues(config.weights, DEFAULT_WEIGHTS.weights);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  if (!config.thresholds || typeof config.thresholds !== "object") throw new Error("weight config is missing thresholds");
  const thresholdValidation = validateTierThresholds(config.thresholds as TierThresholds);
  if (!thresholdValidation.ok) throw new Error(thresholdValidation.errors.join("; "));
  if (!config.performance || typeof config.performance !== "object") throw new Error("weight config is missing performance metrics");
}

async function loadWeights(): Promise<WeightConfig> {
  if (cachedWeights) return cachedWeights;
  try {
    if (!WEIGHTS_FILE) throw new Error("no state dir");
    const file = Bun.file(WEIGHTS_FILE);
    if (await file.exists()) {
      const parsed: unknown = await file.json();
      assertValidWeightConfig(parsed);
      cachedWeights = parsed;
      return cachedWeights!;
    }
  } catch (error) {
    if (!WEIGHTS_FILE) { cachedWeights = cloneDefaultWeights(); return cachedWeights; }
    console.error(`[tier-resolver] rejected invalid weights; using known-good defaults: ${error instanceof Error ? error.message : String(error)}`);
  }
  cachedWeights = cloneDefaultWeights();
  return cachedWeights;
}

async function saveWeights(weights: WeightConfig): Promise<void> {
  assertValidWeightConfig(weights);
  requireStateDir();
  const temporaryPath = `${WEIGHTS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await Bun.write(temporaryPath, `${JSON.stringify(weights, null, 2)}\n`);
  await rename(temporaryPath, WEIGHTS_FILE);
  cachedWeights = structuredClone(weights);
}

// ============================================================================
// MODEL CONFIG
// ============================================================================

let cachedModels: ModelsConfig | null = null;

export async function loadModels(): Promise<ModelsConfig> {
  if (cachedModels) return cachedModels;
  try {
    const file = Bun.file(MODELS_FILE);
    if (await file.exists()) {
      cachedModels = await file.json();
      return cachedModels!;
    }
  } catch {}
  throw new Error(`Models config not found at ${MODELS_FILE}. Copy assets/models.default.json to $ZOUROBOROS_CONFIG_DIR/tier-resolver/models.json`);
}

// ============================================================================
// EXTERNAL POOL (Option B — advisory pool from daily catalog refresh)
// ============================================================================

let cachedPool: { byTier: Record<string, ExternalCandidate[]> } | null = null;
let cachedPoolLoaded = false;

async function loadExternalPool(): Promise<{ byTier: Record<string, ExternalCandidate[]> } | null> {
  if (cachedPoolLoaded) return cachedPool;
  cachedPoolLoaded = true;
  try {
    if (!EXTERNAL_POOL_FILE) return null;
    const file = Bun.file(EXTERNAL_POOL_FILE);
    if (await file.exists()) {
      const raw = await file.json();
      cachedPool = { byTier: raw.byTier ?? {} };
      return cachedPool;
    }
  } catch {}
  cachedPool = null;
  return null;
}

// A candidate is eligible if it clears the price-sentinel, context, and free-tier
// guards. byTier lists are pre-sorted cheapest-first by the catalog sync.
function isEligible(c: ExternalCandidate, ext: ExternalRoutingConfig): boolean {
  if (c.promptCost < 0 || c.completionCost < 0) return false; // price sentinel (-1 = unknown/variable)
  if (!ext.allowFreeTier && c.completionCost === 0) return false;
  if ((c.contextLength ?? 0) < ext.minContextLength) return false;
  return true;
}

// Returns the cheapest eligible candidate for the tier (advisory), and the
// cheapest eligible candidate that is also switchable via byokMap (substitution).
export function selectExternalCandidates(
  tier: ComplexityTier,
  ext: ExternalRoutingConfig,
  pool: { byTier: Record<string, ExternalCandidate[]> },
): { advisory: ExternalCandidate | null; switchable: { candidate: ExternalCandidate; byokId: string } | null } {
  const extTier = EXTERNAL_TIER_MAP[tier];
  if (!extTier) return { advisory: null, switchable: null };
  const list = (pool.byTier[extTier] ?? []).filter(c => isEligible(c, ext));
  if (!list.length) return { advisory: null, switchable: null };
  const advisory = list[0]!;
  let switchable: { candidate: ExternalCandidate; byokId: string } | null = null;
  for (const c of list) {
    const byokId = ext.byokMap[c.id];
    if (byokId) { switchable = { candidate: c, byokId }; break; }
  }
  return { advisory, switchable };
}

export function resolveModel(
  tier: ComplexityTier,
  taskType: TaskType,
  constraints: ConstraintSpec[],
  persona: string | null,
  config: ModelsConfig,
  opts?: { interactive?: boolean; pool?: { byTier: Record<string, ExternalCandidate[]> } | null },
): ModelRecommendation {
  let modelKey = config.tierDefaults[tier];
  let reason = `tier default (${tier})`;

  const taskOv = config.taskOverrides[taskType];
  if (taskOv && taskOv[tier]) {
    modelKey = taskOv[tier]!;
    reason = `task override (${taskType}/${tier})`;
  }

  if (persona) {
    const slug = persona.toLowerCase().replace(/\s+/g, "-");
    const personaOv = config.personaOverrides[slug];
    if (personaOv && personaOv[tier]) {
      modelKey = personaOv[tier]!;
      reason = `persona override (${slug}/${tier})`;
    }
  }

  for (const c of constraints.filter(c => c.source === "explicit" || c.source === "inferred")) {
    const modKey = `${c.type}-${c.value}`;
    const mod = config.constraintModifiers[modKey];
    if (mod && mod[tier]) {
      modelKey = mod[tier]!;
      reason = `constraint (${modKey}/${tier})`;
    }
  }

  const model = config.models[modelKey];
  if (!model) {
    const fallback = config.models[config.tierDefaults[tier]];
    const lastResort = config.models[config.defaultFallback ?? ""] || Object.values(config.models)[0];
    return {
      modelKey: config.tierDefaults[tier],
      modelId: fallback?.id || lastResort?.id || "",
      provider: fallback?.provider || lastResort?.provider || "hermes",
      label: fallback?.label || "fallback",
      costTier: fallback?.costTier || "medium",
      reason: `fallback (unknown key: ${modelKey})`,
      alternatives: [],
    };
  }

  const alternatives: { modelKey: string; modelId: string; reason: string }[] = [];
  const costOrder = ["low", "medium", "high"];
  const modelCostIdx = costOrder.indexOf(model.costTier);
  for (const [key, entry] of Object.entries(config.models)) {
    if (key === modelKey) continue;
    const entryCostIdx = costOrder.indexOf(entry.costTier);
    if (entryCostIdx < modelCostIdx) {
      alternatives.push({ modelKey: key, modelId: entry.id, reason: `cheaper (${entry.costTier})` });
    } else if (entryCostIdx > modelCostIdx) {
      alternatives.push({ modelKey: key, modelId: entry.id, reason: `more capable (${entry.costTier})` });
    }
  }
  alternatives.sort((a, b) => {
    const aIdx = costOrder.indexOf(config.models[a.modelKey]?.costTier || "medium");
    const bIdx = costOrder.indexOf(config.models[b.modelKey]?.costTier || "medium");
    return Math.abs(aIdx - modelCostIdx) - Math.abs(bIdx - modelCostIdx);
  });

  const rec: ModelRecommendation = {
    modelKey,
    modelId: model.id,
    provider: model.provider,
    label: model.label,
    costTier: model.costTier,
    reason,
    alternatives: alternatives.slice(0, 3),
  };

  // Option B — external routing pass (cheap tiers only). Gated by config,
  // interactive context, and byokMap switchability. See models.json.
  const ext = config.externalRouting;
  const pool = opts?.pool;
  if (ext && pool && ext.tiers.includes(tier)) {
    const { advisory, switchable } = selectExternalCandidates(tier, ext, pool);
    const interactiveOK = !ext.interactiveOnly || !!opts?.interactive;
    if (ext.enabled && interactiveOK && switchable) {
      const c = switchable.candidate;
      return {
        modelKey: `external:${c.id}`,
        modelId: switchable.byokId,
        provider: c.provider,
        label: c.id,
        costTier: c.costTier,
        reason: `external routing (${tier} → ${c.provider}, $${c.completionCost}/tok out)`,
        alternatives: [
          { modelKey, modelId: model.id, reason: `claude baseline (${model.costTier})` },
          ...rec.alternatives.slice(0, 2),
        ],
        externalRouted: true,
        externalCandidate: c,
      };
    }
    // Not substituting — surface the cheapest eligible candidate as advisory.
    if (advisory) {
      rec.externalRouted = false;
      rec.externalCandidate = advisory;
      const why = !ext.enabled
        ? (ext.deprecated
            ? `externalRouting deprecated${ext.deprecatedAt ? ` (${ext.deprecatedAt})` : ""}`
            : "externalRouting disabled")
        : !interactiveOK
          ? "interactive-only"
          : "no byokMap entry";
      rec.alternatives = [
        { modelKey: `external:${advisory.id}`, modelId: advisory.id, reason: `external candidate ($${advisory.completionCost}/tok out) — not routed: ${why}` },
        ...rec.alternatives.slice(0, 2),
      ];
    }
  }

  return rec;
}

// ============================================================================
// SIGNAL COMPUTATION (sync — no network dependency)
// ============================================================================

function normalizeLinear(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function normalizeLog(value: number, base: number = 10): number {
  if (value <= 1) return 0;
  return Math.min(1, Math.log(value) / Math.log(base));
}

function computeSignals(text: string, weights: WeightConfig): ComplexitySignal[] {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const fileRefs = (lower.match(/\/[\w\-./ ]+\.\w+/g) || []).length;
  const stepMarkers = (lower.match(/\b(then|after|next|step \d+|finally|first|second|third|fourth|fifth)\b/g) || []).length;
  const numberedSteps = (lower.match(/\d+\.\s/g) || []).length;
  const sentences = text.match(/\.\s+[A-Z]/g)?.length || 0;
  const multiStepIntensity = stepMarkers + numberedSteps + sentences;
  const tools = lower.match(/\b(git|npm|bun|pip|curl|sed|grep|awk|mkdir|chmod|docker|kubectl|terraform|ansible|webpack|vite|jest|pytest|make|cmake)\b/g) || [];
  const toolUsageDepth = tools.length;
  const analysisKeywords = lower.match(/\b(analy[zs]e|assess|evaluate|audit|investigate|research|compare|examine|inspect|suggest|optimize|recommend|improve|bottleneck|performance|diagnose|troubleshoot|review|measure)\b/g) || [];
  const analysisDepth = analysisKeywords.length;
  const conceptPatterns = lower.match(/\b(api|gateway|service|auth|authentication|oauth|jwt|token|database|cache|queue|worker|scheduler|load.?balancer|proxy|middleware|controller|model|view|schema|migration|endpoint|webhook|socket|websocket|stream|pipeline|microservice|monolith|container|cluster|node|pod|replica|deployment|ingress|certificate|ssl|tls|encryption|hashing|session|cookie|cors|csrf|rate.?limit|throttl|pagination|search|index|shard|backup|restore|monitor|alert|log|metric|trace|dashboard|chart|graph|notification|email|sms|push|cron|job|task|event|message|pub.?sub|kafka|rabbit|redis|memcache|cdn|dns|domain|route|network|firewall|vpc|subnet|security.?group|iam|role|policy|permission|mfa|2fa|totp|saml|sso|ldap|refresh|rotation|testing|unit.?test|integration.?test|e2e|ci|cd|pipeline|build|deploy|release|rollback|canary|blue.?green|feature.?flag|a.?b.?test|compliance|gdpr|hipaa|pci|workflow|codebase|real.?time|chat|presence|persistence|receipt|inventory|payment|order|admin|visualization|report|landing.?page|form|contact|navigation|prototype|poc|neural|dataset|training|inference|prometheus|grafana|typescript|javascript|react|angular|vue|fastapi|django|flask|express)\b/g) || [];
  const uniqueConcepts = new Set(conceptPatterns);
  const conceptCount = uniqueConcepts.size;
  const actionVerbs = lower.match(/\b(implement|build|create|write|develop|design|architect|plan|deploy|test|debug|fix|refactor|migrate|optimize|analyze|review|audit|configure|setup|install|integrate|automate|monitor|scale|secure|document|benchmark|profile|validate|verify)\b/g) || [];
  const uniqueVerbs = new Set(actionVerbs);
  const taskVerbComplexity = uniqueVerbs.size;
  const broadScope = (lower.match(/\b(entire|full|comprehensive|all|system|platform|architecture|infrastructure|end.?to.?end|cross.?cutting|enterprise|organization|codebase|stack|ecosystem|framework|suite|pipeline|across|every|workflow)\b/g) || []).length;
  const narrowScope = (lower.match(/\b(function|method|button|field|typo|variable|parameter|class|component|element|line|column|property|attribute|simple|single|one|quick|small|minor|tiny)\b/g) || []).length;
  const scopeScore = Math.max(0, broadScope - narrowScope);
  const phraseParts = lower.split(/\b(?:,|and\b|\bor\b)+/).filter(p => p.trim().length > 2);
  const featureListCount = Math.max(0, phraseParts.length - 1);
  const isFactualQuestion = /^(?:can|could|does|do|did|is|are|was|were|what|when|where|which|who|why|how)\b/i.test(lower.trim());
  const inspectionActions = new Set(lower.match(/\b(check|report|search|find|list|show|inspect|review|verify|estimate|assess)\b/g) || []);
  const mutationActions = new Set(lower.match(/\b(commit|push|merge|deploy|publish|release|install|integrate|implement|repair|remediate|update|configure|create|write|run|execute|restart|delete|remove|migrate|retire|replace|open)\b/g) || []);
  let operationalRisk = 0;
  if (!isFactualQuestion && inspectionActions.size > 0) operationalRisk = 1;
  if (!isFactualQuestion && mutationActions.size > 0) operationalRisk = 2;
  if (!isFactualQuestion && mutationActions.size >= 2) operationalRisk = 3;
  if (!isFactualQuestion && mutationActions.size >= 3 && /\b(production|prod|live|release|deploy|merge)\b/i.test(lower)) operationalRisk = 4;

  return [
    { name: "wordCount", rawValue: wordCount, normalizedScore: normalizeLinear(wordCount, 5, 80), weight: weights.weights.wordCount ?? 0.04 },
    { name: "fileRefs", rawValue: fileRefs, normalizedScore: normalizeLog(fileRefs, 5), weight: weights.weights.fileRefs ?? 0.02 },
    { name: "multiStep", rawValue: multiStepIntensity, normalizedScore: normalizeLinear(multiStepIntensity, 0, 6), weight: weights.weights.multiStep ?? 0.10 },
    { name: "toolUsage", rawValue: toolUsageDepth, normalizedScore: normalizeLog(toolUsageDepth, 5), weight: weights.weights.toolUsage ?? 0.04 },
    { name: "analysisDepth", rawValue: analysisDepth, normalizedScore: normalizeLinear(analysisDepth, 0, 3), weight: weights.weights.analysisDepth ?? 0.08 },
    { name: "conceptCount", rawValue: conceptCount, normalizedScore: normalizeLinear(conceptCount, 0, 6), weight: weights.weights.conceptCount ?? 0.20 },
    { name: "taskVerbComplexity", rawValue: taskVerbComplexity, normalizedScore: normalizeLinear(taskVerbComplexity, 0, 4), weight: weights.weights.taskVerbComplexity ?? 0.10 },
    { name: "scopeBreadth", rawValue: scopeScore, normalizedScore: normalizeLinear(scopeScore, 0, 3), weight: weights.weights.scopeBreadth ?? 0.12 },
    { name: "featureListCount", rawValue: featureListCount, normalizedScore: normalizeLinear(featureListCount, 0, 6), weight: weights.weights.featureListCount ?? 0.20 },
    { name: "operationalRisk", rawValue: operationalRisk, normalizedScore: operationalRisk / 4, weight: weights.weights.operationalRisk ?? 0 },
  ];
}

// ============================================================================
// DOMAIN & TECH STACK DETECTION
// ============================================================================

function detectDomainPattern(text: string, taskType: TaskType): DomainPattern | null {
  const lower = text.toLowerCase();
  const detectedTech: string[] = [];
  for (const [tech, pattern] of Object.entries(TECH_STACK_PATTERNS)) {
    if (pattern.test(lower)) detectedTech.push(tech);
  }

  let domain = taskType;
  let subdomain: string | null = null;
  let complexityModifier = 1.0;

  if (taskType === "coding") {
    if (/\b(frontend|ui|ux|component|view|client|spa)\b/i.test(lower)) { subdomain = "frontend"; complexityModifier = 1.1; }
    else if (/\b(backend|api|server|database|db|endpoint)\b/i.test(lower)) { subdomain = "backend"; complexityModifier = 1.2; }
    else if (/\b(infrastructure|infra|devops|deploy|ci|cd|pipeline)\b/i.test(lower)) { subdomain = "infrastructure"; complexityModifier = 1.3; }
    else if (/\b(auth|security|encrypt|vulnerability|login|signup)\b/i.test(lower)) { subdomain = "security"; complexityModifier = 1.4; }
  }

  if (detectedTech.includes("kubernetes") || detectedTech.includes("terraform")) complexityModifier *= 1.3;
  if (detectedTech.includes("pytorch") || detectedTech.includes("tensorflow")) complexityModifier *= 1.2;
  if (detectedTech.includes("oauth") || detectedTech.includes("jwt") || detectedTech.includes("auth")) complexityModifier *= 1.1;

  if (!subdomain && detectedTech.length === 0) {
    if (taskType === "planning" || taskType === "analysis") complexityModifier = 1.1;
    if (taskType === "security" || taskType === "devops" || taskType === "data_science") complexityModifier = 1.2;
  }

  if (detectedTech.length === 0 && !subdomain && taskType === "general") return null;

  return { domain, subdomain, techStack: detectedTech, complexityModifier };
}

// ============================================================================
// SEMANTIC TASK INFERENCE
// ============================================================================

function computeStringSimilarity(a: string, b: string): number {
  const ngrams = (s: string, n: number = 3): Set<string> => {
    const grams = new Set<string>();
    for (let i = 0; i <= s.length - n; i++) grams.add(s.slice(i, i + n));
    return grams;
  };
  const gramsA = ngrams(a.toLowerCase());
  const gramsB = ngrams(b.toLowerCase());
  const intersection = new Set([...gramsA].filter(x => gramsB.has(x)));
  const union = new Set([...gramsA, ...gramsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function inferTaskTypeSemantic(text: string): SemanticMatch {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  let bestMatch: SemanticMatch = { taskType: "general", confidence: 0, matchMethod: "keyword", evidenceTokens: [] };

  for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (taskType === "general") continue;

    const keywordMatches = keywords.filter(kw => lower.includes(kw));
    if (keywordMatches.length > 0) {
      const SPECIALIZATION_BONUS: Partial<Record<string, number>> = { security: 0.05, data_science: 0.05, devops: 0.05, analysis: 0.02, planning: 0.02 };
      const bonus = keywordMatches.length >= 2 ? (SPECIALIZATION_BONUS[taskType] || 0) : 0;
      const confidence = Math.min(1.0, keywordMatches.length * 0.3 + bonus);
      if (confidence > bestMatch.confidence) {
        bestMatch = { taskType: taskType as TaskType, confidence, matchMethod: "keyword", evidenceTokens: keywordMatches };
      }
    }

    for (const word of words) {
      for (const keyword of keywords) {
        const similarity = computeStringSimilarity(word, keyword);
        if (similarity > 0.7) {
          const confidence = Math.min(1.0, similarity * 0.5);
          if (confidence > bestMatch.confidence) {
            bestMatch = { taskType: taskType as TaskType, confidence, matchMethod: "synonym", evidenceTokens: [word, keyword] };
          }
        }
      }
    }
  }

  for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (taskType === "general") continue;
    for (const keyword of keywords) {
      if (keyword.includes(" ") && lower.includes(keyword)) {
        const confidence = 0.9;
        if (confidence > bestMatch.confidence) {
          bestMatch = { taskType: taskType as TaskType, confidence, matchMethod: "contextual", evidenceTokens: [keyword] };
        }
      }
    }
  }

  return bestMatch;
}

// ============================================================================
// CONSTRAINT DETECTION
// ============================================================================

function detectConstraints(text: string, cliConstraints?: Partial<Record<ConstraintType, ConstraintValue>>): ConstraintSpec[] {
  const constraints: ConstraintSpec[] = [];

  if (cliConstraints) {
    let priority = 100;
    for (const [type, value] of Object.entries(cliConstraints)) {
      constraints.push({ type: type as ConstraintType, value: value as ConstraintValue, source: "explicit", priority: priority-- });
    }
  }

  const lower = text.toLowerCase();
  let priority = 50;
  for (const [type, valuePatterns] of Object.entries(CONSTRAINT_PATTERNS)) {
    for (const [value, pattern] of Object.entries(valuePatterns)) {
      if (pattern.test(lower)) {
        constraints.push({ type: type as ConstraintType, value: value as ConstraintValue, source: "inferred", priority: priority-- });
        break;
      }
    }
  }

  const defaultTypes: ConstraintType[] = ["budget", "latency", "quality", "speed"];
  const existingTypes = new Set(constraints.map(c => c.type));
  priority = 10;
  for (const type of defaultTypes) {
    if (!existingTypes.has(type)) {
      constraints.push({ type, value: "medium", source: "default", priority: priority-- });
    }
  }

  return constraints.sort((a, b) => b.priority - a.priority);
}

function detectScopeModifier(text: string): ScopeModifier | null {
  for (const [modifier, pattern] of Object.entries(SCOPE_MODIFIER_PATTERNS)) {
    if (pattern.test(text)) return modifier as ScopeModifier;
  }
  return null;
}

// ============================================================================
// TIER CALCULATION
// ============================================================================

function calculateTier(
  signals: ComplexitySignal[],
  domainPattern: DomainPattern | null,
  constraints: ConstraintSpec[],
  scopeModifier: ScopeModifier | null,
  taskType: TaskType = "general",
  taskText: string = "",
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): { tier: ComplexityTier; score: number } {
  let weightedScore = 0;
  for (const signal of signals) weightedScore += signal.normalizedScore * signal.weight;

  if (domainPattern) weightedScore += (domainPattern.complexityModifier - 1.0) * 0.2;

  if (scopeModifier) {
    if (scopeModifier === "quick") weightedScore -= 0.15;
    if (scopeModifier === "thorough" && taskType !== "analysis") weightedScore += 0.15;
    if (scopeModifier === "experimental" && taskType !== "debugging") weightedScore -= 0.10;
    if (scopeModifier === "experimental" && taskType === "debugging") weightedScore += 0.10;
    if (scopeModifier === "production") weightedScore += 0.10;
  }

  for (const constraint of constraints) {
    if (constraint.type === "budget" && constraint.value === "low") weightedScore -= 0.10;
    if (constraint.type === "speed" && constraint.value === "high") weightedScore -= 0.12;
    if (constraint.type === "quality" && constraint.value === "high") weightedScore += 0.12;
  }

  weightedScore = Math.max(0, Math.min(1, weightedScore));

  // Phrase-force override — explicit intent keywords bypass score thresholds
  const FORCE_COMPLEX = /\b(deep[- ]?research|deep[- ]?dive|think (deeply|carefully|through|about|this over)|analyze thoroughly|thorough(ly)?|in[- ]depth( analysis)?|step[- ]by[- ]step|carefully consider|explore (all|every|the full)|investigate (thoroughly|fully|deeply)|exhaustive(ly)?|detailed (analysis|review|examination)|examine carefully|reason (through|about)|brainstorm|comprehensive (analysis|review|plan|overview|breakdown)|full (analysis|review|audit)|think it through|slow down and|take your time|don.?t rush)\b/i;
  const FORCE_TRIVIAL = /\b(quick (question|answer|note|check|look)|just (tell|give|show) me|one[- ]liner|tl;?dr|in a (sentence|word|nutshell)|just (asking|curious)|quick (recap|summary))\b/i;
  const FORCE_SIMPLE  = /\b(brief(ly)?|short answer|keep it (short|brief|concise)|quick summary|summarize briefly|high[- ]level only)\b/i;

  let tier: ComplexityTier;
  if (FORCE_COMPLEX.test(taskText)) {
    tier = "complex";
  } else if (FORCE_TRIVIAL.test(taskText)) {
    tier = "trivial";
  } else if (FORCE_SIMPLE.test(taskText) && weightedScore < 0.45) {
    tier = "simple";
  } else if (weightedScore < thresholds.trivial) tier = "trivial";
  else if (weightedScore < thresholds.simple) tier = "simple";
  else if (weightedScore < thresholds.moderate) tier = "moderate";
  else tier = "complex";

  if (tier !== "complex") {
    const cs = signals.find(s => s.name === "conceptCount");
    const fs = signals.find(s => s.name === "featureListCount");
    const ss = signals.find(s => s.name === "scopeBreadth");
    if ((cs?.rawValue ?? 0) >= 6 || (fs?.rawValue ?? 0) >= 5 || (ss?.rawValue ?? 0) >= 3) tier = "complex";
  }

  if (scopeModifier !== "quick" && scopeModifier !== "experimental") {
    const FLOOR: Partial<Record<TaskType, ComplexityTier>> = {
      security: "moderate", devops: "moderate", data_science: "moderate",
      debugging: "simple", planning: "moderate", analysis: "moderate",
    };
    const order: Record<ComplexityTier, number> = { trivial: 0, simple: 1, moderate: 2, complex: 3, apex: 4 };
    const f = FLOOR[taskType];
    if (f && order[tier] < order[f]) tier = f;
  }

  const sigMap: Record<string, number> = {};
  for (const s of signals) sigMap[s.name] = s.rawValue || 0;
  const scopeBreadth = sigMap["scopeBreadth"] || 0;
  const featureCount = sigMap["featureListCount"] || 0;
  if (taskType === "analysis" && tier === "simple" && scopeBreadth === 0 && featureCount === 0) tier = "moderate";

  const lower = taskText.toLowerCase();

  if (taskType === "analysis" && tier === "simple" && weightedScore >= 0.15) tier = "moderate";
  if (taskType === "review" && tier === "simple" && weightedScore >= 0.13 && /\b(compare|assess|evaluate|analyz)\b/i.test(taskText)) tier = "moderate";

  const advDebug = /\b(memory leak|race condition|concurrency|deadlock|heap|segfault|stack overflow|bottleneck)\b/i;
  const compKws = (lower.match(/\b(gdpr|hipaa|pci|sox|compliance)\b/g) || []);
  const infraKws = (lower.match(/\b(kubernetes|k8s|terraform|ansible|docker|aws|gcp|azure|microservices|service mesh|cluster|distributed|availability zone|region|failover|replication)\b/g) || []);
  const archMig = /\b(api gateway|service mesh|microservices|event-driven|message queue|event bus)\b/i;
  const langMig = /\b(typescript|python|rust|go|golang|java|c\+\+|ruby|perl|php)\b.*\b(instead of|over|rather than|rather|vs\.?|instead)\b/i.test(lower)
               || /\buse\s+(typescript|python|rust|go|golang|java|c\+\+|ruby|perl|php)\b.*\b(instead of|instead)\b/i.test(lower);
  const codebaseMig = /\bcodebase\b.*\b(instead of|use\s+\w+\s+instead|rather than)\b/i.test(lower)
                   || /\b(instead of|use\s+\w+\s+instead|rather than)\b.*\bcodebase\b/i.test(lower);

  if (taskType === "debugging" && tier === "simple" && advDebug.test(lower)) tier = "moderate";
  if (taskType === "security" && tier === "simple" && compKws.length >= 2) tier = "moderate";
  if (taskType === "planning" && tier === "simple" && infraKws.length >= 2) tier = "moderate";
  if (taskType === "coding" && tier === "simple" && (langMig || archMig.test(lower))) tier = "moderate";

  const authTerms = (lower.match(/\b(oauth|jwt|mfa|2fa|refresh|rotation|token|rate.?limit|authentication)\b/g) || []);
  if (taskType === "coding" && tier === "moderate" && authTerms.length >= 4) tier = "complex";

  if (taskType === "data_science" && tier === "moderate"
      && /\b(train|neural|model|ml|machine learning)\b/i.test(lower)
      && /\b(deploy|fastapi|flask|api|serve|production|inference)\b/i.test(lower)) tier = "complex";

  const gdprScale = /\b(gdpr|hipaa|pci|sox|compliance)\b.*\b(across|all|every|workflow|system|codebase|platform|enterprise)\b/i.test(lower)
                 || /\b(across|all|every|workflow|system|codebase|platform|enterprise)\b.*\b(gdpr|hipaa|pci|sox|compliance)\b/i.test(lower);
  if (taskType === "security" && tier === "moderate" && gdprScale) tier = "complex";

  if (tier === "moderate"
      && /\b(redis|distributed caching|distributed cache|cache layer)\b/i.test(lower)
      && /\b(invalidat|monitoring|cluster|replication)\b/i.test(lower)) tier = "complex";

  if (taskType === "coding" && tier === "moderate" && codebaseMig) tier = "complex";

  if (taskType === "debugging" && tier === "moderate"
      && /\b(race condition|concurrent|concurrency|deadlock|atomic|transaction)\b/i.test(lower)
      && /\b(flow|checkout|payment|order|process)\b/i.test(lower)) tier = "complex";

  if (taskType === "security" && tier === "moderate"
      && /\b(scan|check|audit)\b.*\b(single|one|a)\b/i.test(lower)) tier = "simple";
  if (taskType === "analysis" && tier === "moderate" && weightedScore < 0.15
      && (/\bexcel\b/i.test(lower) || /\b(spreadsheet|tableau|looker|power bi)\b/i.test(lower))) tier = "simple";

  if (taskType === "planning" && tier === "moderate" && !scopeModifier) {
    const infraKeywords = (lower.match(/\b(kubernetes|k8s|terraform|ansible|docker|aws|gcp|azure|microservices|service mesh|api gateway|event-driven|cluster|distributed|availability zone|region|failover|replication|service mesh|api gateway)\b/g) || []).length;
    if (infraKeywords >= 2) tier = "complex";
  }

  if (tier === "complex" && /\b(npm |node )?packages?( with| and| including)? security/i.test(lower) && /\b(update|patch|upgrade|fix|scan|audit)\b/i.test(lower)) tier = "moderate";

  // ── Apex tier: explicit intent signals only. Conservative by design.
  // Score alone cannot promote to apex — prevents inflation from complex tasks.
  const FORCE_APEX = /\b(use (mythos|apex model|best model|most capable model)|apex tier|need mythos|cross[- ]domain (synthesis|analysis|reasoning)|novel (approach|solution|architecture|design)|first[- ]?principles (reasoning|design|analysis)|full (synthesis|reasoning across)|unprecedented|multi[- ]domain synthesis)\b/i;
  if (FORCE_APEX.test(taskText)) {
    tier = "apex";
  } else if (tier === "complex" && weightedScore >= thresholds.apex) {
    const domainSignals = [
      /\b(security|compliance|gdpr|hipaa|pci)\b/i,
      /\b(ml|machine learning|neural|training|inference)\b/i,
      /\b(kubernetes|terraform|infrastructure|distributed)\b/i,
      /\b(architecture|microservices|event[- ]driven|service mesh)\b/i,
      /\b(real[- ]?time|streaming|websocket|pub[- ]?sub)\b/i,
    ].filter(p => p.test(taskText)).length;
    if (domainSignals >= 3) tier = "apex";
  }

  return { tier, score: weightedScore };
}

// ============================================================================
// MAIN COMPLEXITY ESTIMATION
// ============================================================================

export async function estimateComplexity(
  text: string,
  options?: { budget?: ConstraintValue; latency?: ConstraintValue; quality?: ConstraintValue; speed?: ConstraintValue; }
): Promise<ComplexityEstimate> {
  const weights = await loadWeights();
  return _estimateCore(text, weights, options);
}

export function estimateComplexitySync(text: string): ComplexityEstimate {
  return _estimateCore(text, cachedWeights || DEFAULT_WEIGHTS);
}

export function inferTaskType(text: string): TaskType {
  return inferTaskTypeSemantic(sanitizeTaskText(text).toLowerCase()).taskType;
}

interface PreparedComplexity {
  text: string;
  signals: ComplexitySignal[];
  semanticMatch: SemanticMatch;
  domainPattern: DomainPattern | null;
  constraints: ConstraintSpec[];
  scopeModifier: ScopeModifier | null;
}

function prepareComplexity(
  text: string,
  options?: { budget?: ConstraintValue; latency?: ConstraintValue; quality?: ConstraintValue; speed?: ConstraintValue; },
): PreparedComplexity {
  text = sanitizeTaskText(text);
  const signals = computeSignals(text, DEFAULT_WEIGHTS);
  const semanticMatch = inferTaskTypeSemantic(text);
  const domainPattern = detectDomainPattern(text, semanticMatch.taskType);

  const cliConstraints: Partial<Record<ConstraintType, ConstraintValue>> = {};
  if (options?.budget) cliConstraints.budget = options.budget;
  if (options?.latency) cliConstraints.latency = options.latency;
  if (options?.quality) cliConstraints.quality = options.quality;
  if (options?.speed) cliConstraints.speed = options.speed;

  const constraints = detectConstraints(text, cliConstraints);
  const scopeModifier = detectScopeModifier(text);

  if (domainPattern && domainPattern.techStack.length > 0) {
    signals.push({ name: "domainComplexity", rawValue: domainPattern.complexityModifier, normalizedScore: Math.min(1, (domainPattern.complexityModifier - 0.8) / 0.7), weight: DEFAULT_WEIGHTS.weights.domainComplexity ?? 0.10 });
    signals.push({ name: "techStackDepth", rawValue: domainPattern.techStack.length, normalizedScore: normalizeLog(domainPattern.techStack.length, 5), weight: DEFAULT_WEIGHTS.weights.techStackDepth ?? 0.10 });
  }

  const lower = text.toLowerCase();
  let heuristicBoost = 0;
  if (/(refactor|migrate|rewrite|overhaul|convert)/i.test(lower) && /(codebase|entire|all|whole|system|project|application|app)/i.test(lower)) heuristicBoost += 0.25;
  if (/(compliance|gdpr|hipaa|pci|sox|audit)/i.test(lower) && /(across|all|entire|every|system|workflow|codebase|platform)/i.test(lower)) heuristicBoost += 0.20;
  if (/production[\s-]?ready/i.test(lower)) heuristicBoost += 0.10;
  if (/(memory leak|race condition|deadlock|concurrency|heap|segfault|stack overflow|bottleneck)/i.test(lower) && /(debug|fix|investigate|diagnose|troubleshoot)/i.test(lower)) heuristicBoost += 0.15;
  if (/(train|neural|model|ml|machine learning)/i.test(lower) && /(deploy|fastapi|flask|api|serve|production|inference)/i.test(lower)) heuristicBoost += 0.15;
  if (heuristicBoost > 0) signals.push({ name: "heuristicBoost", rawValue: heuristicBoost, normalizedScore: Math.min(1, heuristicBoost), weight: 1.0 });

  return { text, signals, semanticMatch, domainPattern, constraints, scopeModifier };
}

function estimatePreparedComplexity(prepared: PreparedComplexity, weights: WeightConfig): ComplexityEstimate {
  const { text, semanticMatch, domainPattern, constraints, scopeModifier } = prepared;
  const signals = prepared.signals.map((signal) => ({
    ...signal,
    weight: signal.name === "heuristicBoost" ? 1 : (weights.weights[signal.name] ?? signal.weight),
  }));

  const { tier, score } = calculateTier(signals, domainPattern, constraints, scopeModifier, semanticMatch.taskType, text, weights.thresholds);

  return {
    tier, score, signals,
    inferredTaskType: semanticMatch.taskType,
    semanticMatch, domainPattern, constraints, scopeModifier,
    _legacy: {
      wordCount: signals.find(s => s.name === "wordCount")?.rawValue || 0,
      fileCount: signals.find(s => s.name === "fileRefs")?.rawValue || 0,
      hasMultiStep: (signals.find(s => s.name === "multiStep")?.rawValue || 0) > 0,
      hasTool: (signals.find(s => s.name === "toolUsage")?.rawValue || 0) > 0,
      hasAnalysis: (signals.find(s => s.name === "analysisDepth")?.rawValue || 0) > 0,
    },
  };
}

function _estimateCore(
  text: string,
  weights: WeightConfig,
  options?: { budget?: ConstraintValue; latency?: ConstraintValue; quality?: ConstraintValue; speed?: ConstraintValue; },
): ComplexityEstimate {
  return estimatePreparedComplexity(prepareComplexity(text, options), weights);
}

// ============================================================================
// FEEDBACK SYSTEM
// ============================================================================

async function logFeedback(entry: FeedbackEntry): Promise<void> {
  // Routing telemetry is opt-in by configuration: without a state dir nothing is recorded.
  if (!STATE_DIR) return;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  await appendFile(FEEDBACK_FILE, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function loadFeedback(): Promise<FeedbackEntry[]> {
  if (!FEEDBACK_FILE) return [];
  const file = Bun.file(FEEDBACK_FILE);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const entries: FeedbackEntry[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: FeedbackEntry;
    try {
      entry = JSON.parse(line) as FeedbackEntry;
    } catch (error) {
      throw new Error(`Malformed feedback JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entry.id || ids.has(entry.id)) throw new Error(`Invalid or duplicate feedback id at line ${index + 1}`);
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

async function writeFeedback(entries: FeedbackEntry[]): Promise<void> {
  requireStateDir();
  const temporaryPath = `${FEEDBACK_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await Bun.write(temporaryPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await rename(temporaryPath, FEEDBACK_FILE);
}

async function submitCorrection(taskId: string, correctedTier: ComplexityTier): Promise<void> {
  const feedback = await loadFeedback();
  const entry = feedback.find(f => f.id === taskId);
  if (!entry) throw new Error(`Feedback entry ${taskId} not found`);
  entry.correctedTier = correctedTier;
  entry.outcome = entry.recommendedTier === correctedTier ? "success" : "failure";
  await writeFeedback(feedback);
  console.log(`Correction recorded: ${taskId} -> ${correctedTier}`);
}

async function auditFeedback(): Promise<void> {
  const feedback = await loadFeedback();
  const lengths = feedback.map((entry) => entry.taskText.length).sort((a, b) => a - b);
  const corrected = feedback.filter((entry) => entry.correctedTier);
  const calibrationEligible = corrected.filter((entry) => !entry.taskTextTruncated && entry.taskText.length <= MAX_FEEDBACK_TASK_CHARS);
  const contaminated = feedback.filter((entry) => sanitizeTaskText(entry.taskText) !== entry.taskText.trim());
  const tiers = Object.fromEntries(
    ["trivial", "simple", "moderate", "complex", "apex"].map((tier) => [
      tier,
      feedback.filter((entry) => entry.recommendedTier === tier).length,
    ]),
  );
  console.log(JSON.stringify({
    entries: feedback.length,
    corrections: corrected.length,
    calibrationEligibleCorrections: calibrationEligible.length,
    distinctCorrectedTiers: new Set(calibrationEligible.map((entry) => entry.correctedTier)).size,
    contaminatedEntries: contaminated.length,
    overTelemetryLimit: feedback.filter((entry) => entry.taskText.length > MAX_FEEDBACK_TASK_CHARS).length,
    medianTaskChars: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
    maxTaskChars: lengths.at(-1) ?? 0,
    recommendedTiers: tiers,
    calibrationReady: calibrationEligible.length >= MIN_CALIBRATION_CORRECTIONS
      && new Set(calibrationEligible.map((entry) => entry.correctedTier)).size >= 2,
  }, null, 2));
}

type LabeledFeedback = FeedbackEntry & { correctedTier: ComplexityTier };

interface CalibrationEvaluation {
  accuracy: number;
  correct: number;
  total: number;
  byTier: Record<string, { correct: number; total: number }>;
  predictions: ComplexityTier[];
}

function evaluateCalibration(
  entries: LabeledFeedback[],
  config: WeightConfig,
  predictionCache?: Map<string, ComplexityTier>,
  preparedCache?: Map<string, PreparedComplexity>,
): CalibrationEvaluation {
  let correct = 0;
  const byTier: Record<string, { correct: number; total: number }> = {};
  const predictions: ComplexityTier[] = [];
  for (const entry of entries) {
    const cachedPrediction = predictionCache?.get(entry.id);
    let prepared = preparedCache?.get(entry.id);
    if (!prepared) {
      prepared = prepareComplexity(entry.taskText);
      preparedCache?.set(entry.id, prepared);
    }
    const prediction = cachedPrediction ?? estimatePreparedComplexity(prepared, config).tier;
    if (cachedPrediction === undefined) predictionCache?.set(entry.id, prediction);
    predictions.push(prediction);
    const bucket = byTier[entry.correctedTier] ?? { correct: 0, total: 0 };
    bucket.total++;
    if (prediction === entry.correctedTier) {
      correct++;
      bucket.correct++;
    }
    byTier[entry.correctedTier] = bucket;
  }
  return { accuracy: entries.length ? correct / entries.length : 0, correct, total: entries.length, byTier, predictions };
}

function hasPerTierRegression(baseline: CalibrationEvaluation, candidate: CalibrationEvaluation): boolean {
  return Object.keys(baseline.byTier).some((tier) => {
    const before = baseline.byTier[tier];
    const after = candidate.byTier[tier];
    if (!before || !after || before.total < 2) return false;
    return after.correct / after.total < before.correct / before.total;
  });
}

function performanceMetrics(entries: LabeledFeedback[], predictions: ComplexityTier[]): WeightConfig["performance"] {
  const tiers: ComplexityTier[] = ["trivial", "simple", "moderate", "complex", "apex"];
  const precision = {} as Record<ComplexityTier, number>;
  const recall = {} as Record<ComplexityTier, number>;
  const f1 = {} as Record<ComplexityTier, number>;
  for (const tier of tiers) {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (let index = 0; index < entries.length; index++) {
      const expected = entries[index]?.correctedTier;
      const predicted = predictions[index];
      if (expected === tier && predicted === tier) truePositive++;
      else if (expected !== tier && predicted === tier) falsePositive++;
      else if (expected === tier && predicted !== tier) falseNegative++;
    }
    precision[tier] = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
    recall[tier] = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
    f1[tier] = precision[tier] + recall[tier] ? 2 * precision[tier] * recall[tier] / (precision[tier] + recall[tier]) : 0;
  }
  return { precision, recall, f1 };
}

interface RepeatedValidationEvaluation {
  accuracy: number;
  correct: number;
  total: number;
  bySplit: CalibrationEvaluation[];
}

interface SearchCandidate {
  config: WeightConfig;
  training: CalibrationEvaluation;
  validation: RepeatedValidationEvaluation;
  distance: number;
}

function evaluateRepeatedValidation(
  splits: Array<{ training: LabeledFeedback[]; holdout: LabeledFeedback[] }>,
  config: WeightConfig,
  predictionCache?: Map<string, ComplexityTier>,
  preparedCache?: Map<string, PreparedComplexity>,
): RepeatedValidationEvaluation {
  const bySplit = splits.map((split) => evaluateCalibration(split.holdout, config, predictionCache, preparedCache));
  const correct = bySplit.reduce((sum, evaluation) => sum + evaluation.correct, 0);
  const total = bySplit.reduce((sum, evaluation) => sum + evaluation.total, 0);
  return { accuracy: total ? correct / total : 0, correct, total, bySplit };
}

function calibrationParameterDistance(candidate: WeightConfig, incumbent: WeightConfig): number {
  const weightDistance = Object.keys(incumbent.weights)
    .reduce((sum, key) => sum + Math.abs((candidate.weights[key] ?? 0) - (incumbent.weights[key] ?? 0)), 0);
  const thresholdDistance = (Object.keys(incumbent.thresholds) as Array<keyof TierThresholds>)
    .reduce((sum, key) => sum + Math.abs(candidate.thresholds[key] - incumbent.thresholds[key]), 0);
  return weightDistance + thresholdDistance;
}

function calibrationCandidateKey(config: WeightConfig): string {
  const weights = Object.keys(config.weights).sort().map((key) => [key, Number(config.weights[key]?.toFixed(6))]);
  const thresholds = (Object.keys(config.thresholds) as Array<keyof TierThresholds>)
    .sort()
    .map((key) => [key, Number(config.thresholds[key].toFixed(6))]);
  return JSON.stringify({ weights, thresholds });
}

function compareSearchCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.validation.correct - left.validation.correct
    || right.training.correct - left.training.correct
    || left.distance - right.distance
    || calibrationCandidateKey(left.config).localeCompare(calibrationCandidateKey(right.config));
}

function calibrationNeighbors(config: WeightConfig): WeightConfig[] {
  const neighbors: WeightConfig[] = [];
  const weightNames = Object.keys(config.weights).sort();
  const targetTotal = Object.values(config.weights).reduce((sum, value) => sum + value, 0);
  for (const signalName of weightNames) {
    for (const delta of [-0.04, 0.04]) {
      const candidate = structuredClone(config);
      candidate.weights[signalName] = Math.max(0, (candidate.weights[signalName] ?? 0) + delta);
      candidate.weights = normalizeWeightsToTotal(candidate.weights, targetTotal);
      const validation = validateWeightValues(candidate.weights, DEFAULT_WEIGHTS.weights);
      if (validation.ok) neighbors.push(candidate);
    }
  }

  for (const threshold of Object.keys(config.thresholds) as Array<keyof TierThresholds>) {
    for (const delta of [-0.04, -0.02, 0.02, 0.04]) {
      const candidate = structuredClone(config);
      candidate.thresholds[threshold] = Number((candidate.thresholds[threshold] + delta).toFixed(6));
      if (validateTierThresholds(candidate.thresholds).ok) neighbors.push(candidate);
    }
  }
  return neighbors;
}

function searchCalibrationCandidate(
  training: LabeledFeedback[],
  validationSplits: Array<{ training: LabeledFeedback[]; holdout: LabeledFeedback[] }>,
  incumbent: WeightConfig,
): SearchCandidate {
  const preparedCache = new Map<string, PreparedComplexity>();
  const score = (config: WeightConfig): SearchCandidate => {
    const predictionCache = new Map<string, ComplexityTier>();
    return {
      config,
      training: evaluateCalibration(training, config, predictionCache, preparedCache),
      validation: evaluateRepeatedValidation(validationSplits, config, predictionCache, preparedCache),
      distance: calibrationParameterDistance(config, incumbent),
    };
  };
  let beam = [score(structuredClone(incumbent))];
  const seen = new Set(beam.map((candidate) => calibrationCandidateKey(candidate.config)));

  for (let round = 0; round < 2; round++) {
    const candidates = [...beam];
    for (const parent of beam) {
      for (const config of calibrationNeighbors(parent.config)) {
        const key = calibrationCandidateKey(config);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(score(config));
      }
    }
    candidates.sort(compareSearchCandidates);
    beam = candidates.slice(0, 3);
  }
  return beam.sort(compareSearchCandidates)[0]!;
}

async function autoTuneWeights(promote: boolean): Promise<"promoted" | "candidate" | "rejected" | "insufficient"> {
  const feedback = await loadFeedback();
  const allCorrected = feedback.filter((entry): entry is LabeledFeedback => Boolean(entry.correctedTier));
  const corrected = allCorrected.filter((entry) => !entry.taskTextTruncated && entry.taskText.length <= MAX_FEEDBACK_TASK_CHARS);
  const tierCount = new Set(corrected.map((entry) => entry.correctedTier)).size;
  if (corrected.length < MIN_CALIBRATION_CORRECTIONS || tierCount < 2) {
    console.log(JSON.stringify({
      status: "insufficient",
      corrections: corrected.length,
      excludedCorrections: allCorrected.length - corrected.length,
      distinctTiers: tierCount,
      requiredCorrections: MIN_CALIBRATION_CORRECTIONS,
      requiredDistinctTiers: 2,
    }, null, 2));
    return "insufficient";
  }

  const { training, holdout } = stratifiedCalibrationSplit(corrected);
  if (holdout.length < MIN_CALIBRATION_HOLDOUT) {
    console.log(JSON.stringify({
      status: "insufficient",
      corrections: corrected.length,
      excludedCorrections: allCorrected.length - corrected.length,
      holdout: holdout.length,
      requiredHoldout: MIN_CALIBRATION_HOLDOUT,
    }, null, 2));
    return "insufficient";
  }

  const weights = structuredClone(await loadWeights());
  const validationSplits = stratifiedCalibrationSplits(training, CALIBRATION_VALIDATION_SPLITS);
  const baselineTraining = evaluateCalibration(training, weights);
  const baselineValidation = evaluateRepeatedValidation(validationSplits, weights);
  const baselineHoldout = evaluateCalibration(holdout, weights);
  const targetTotal = Object.values(weights.weights).reduce((sum, value) => sum + value, 0);
  const best = searchCalibrationCandidate(training, validationSplits, weights);
  const candidateConfig = best.config;
  const bestTraining = best.training;
  const candidateValidation = best.validation;
  const candidateHoldout = evaluateCalibration(holdout, candidateConfig);
  const validationSplitRegressions = baselineValidation.bySplit.filter((baseline, index) => {
    const candidate = candidateValidation.bySplit[index];
    return !candidate || candidate.correct < baseline.correct;
  }).length;
  const validationSplitImprovements = baselineValidation.bySplit.filter((baseline, index) => {
    const candidate = candidateValidation.bySplit[index];
    return Boolean(candidate && candidate.correct > baseline.correct);
  }).length;
  const parametersChanged = calibrationCandidateKey(candidateConfig) !== calibrationCandidateKey(weights);
  const candidateQualifies = bestTraining.correct > baselineTraining.correct
    && candidateValidation.correct > baselineValidation.correct
    && validationSplitRegressions === 0
    && validationSplitImprovements >= 2
    && candidateHoldout.correct > baselineHoldout.correct
    && !hasPerTierRegression(baselineHoldout, candidateHoldout)
    && parametersChanged;
  const summary = {
    status: candidateQualifies ? (promote ? "promoted" : "candidate") : "rejected",
    promoted: candidateQualifies && promote,
    corrections: corrected.length,
    excludedCorrections: allCorrected.length - corrected.length,
    trainingCount: training.length,
    holdoutCount: holdout.length,
    validationSplits: validationSplits.length,
    baselineTrainingAccuracy: baselineTraining.accuracy,
    candidateTrainingAccuracy: bestTraining.accuracy,
    baselineValidationAccuracy: baselineValidation.accuracy,
    candidateValidationAccuracy: candidateValidation.accuracy,
    validationSplitImprovements,
    validationSplitRegressions,
    baselineHoldoutAccuracy: baselineHoldout.accuracy,
    candidateHoldoutAccuracy: candidateHoldout.accuracy,
    perTierRegression: hasPerTierRegression(baselineHoldout, candidateHoldout),
    parametersChanged,
    weightTotal: targetTotal,
    candidateWeights: candidateConfig.weights,
    candidateThresholds: candidateConfig.thresholds,
  };

  if (!candidateQualifies) {
    console.log(JSON.stringify(summary, null, 2));
    return "rejected";
  }

  if (!promote) {
    console.log(JSON.stringify({ ...summary, next: "Re-run with feedback tune --promote after reviewing the held-out evidence." }, null, 2));
    return "candidate";
  }

  const fullEvaluation = evaluateCalibration(corrected, candidateConfig);
  const datasetFingerprint = createHash("sha256")
    .update(corrected.map((entry) => `${entry.id}:${entry.correctedTier}:${entry.taskText}`).sort().join("\n"))
    .digest("hex");
  weights.weights = candidateConfig.weights;
  weights.thresholds = candidateConfig.thresholds;
  weights.lastUpdated = Date.now();
  weights.feedbackCount = corrected.length;
  weights.performance = performanceMetrics(corrected, fullEvaluation.predictions);
  weights.calibration = {
    promotedAt: weights.lastUpdated,
    trainingCount: training.length,
    holdoutCount: holdout.length,
    baselineTrainingAccuracy: baselineTraining.accuracy,
    candidateTrainingAccuracy: bestTraining.accuracy,
    validationSplits: validationSplits.length,
    baselineValidationAccuracy: baselineValidation.accuracy,
    candidateValidationAccuracy: candidateValidation.accuracy,
    baselineHoldoutAccuracy: baselineHoldout.accuracy,
    candidateHoldoutAccuracy: candidateHoldout.accuracy,
    datasetFingerprint,
    weightTotal: targetTotal,
    thresholds: candidateConfig.thresholds,
  };
  await saveWeights(weights);
  console.log(JSON.stringify(summary, null, 2));
  return "promoted";
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`persona-tier-resolve — Persona-aware model selection via task complexity analysis

Usage:
  bun persona-tier-resolve.ts [options] "<task prompt>"
  bun persona-tier-resolve.ts feedback list|correct|tune

Options:
  --json              Full JSON output (complexity + model recommendation)
  --persona <name>    Persona slug for persona-specific overrides
  --budget <val>      Budget constraint: low | medium | high
  --latency <val>     Latency constraint: low | medium | high
  --quality <val>     Quality constraint: low | medium | high
  --speed <val>       Speed constraint: low | medium | high
  --interactive       Mark as interactive context (enables Option B external routing for cheap tiers)
  --no-feedback       Do not append a routing telemetry record (tests and diagnostics only)
  --models            List available models from config

Feedback:
  feedback list                                  List all feedback entries
  feedback audit                                 Report corpus quality and readiness
  feedback correct --task-id <id> --tier <tier>  Correct a tier classification
  feedback tune                                  Evaluate a held-out calibration candidate
  feedback tune --promote                        Persist only a held-out improvement

Examples:
  bun persona-tier-resolve.ts "Fix the login bug"
  bun persona-tier-resolve.ts --json --persona security-engineer "Design a microservices architecture"
  bun persona-tier-resolve.ts --budget low "Summarize this article"
  bun persona-tier-resolve.ts --models`);
    return;
  }

  if (args[0] === "feedback") {
    if (args[1] === "list") { const f = await loadFeedback(); console.log(JSON.stringify(f, null, 2)); return; }
    if (args[1] === "audit") { await auditFeedback(); return; }
    if (args[1] === "correct" || args[1] === "fix") {
      const tid = args.findIndex(a => a === "--task-id" || a === "-id");
      const tid2 = args.findIndex(a => a === "--tier" || a === "-t");
      if (tid === -1 || tid2 === -1 || !args[tid + 1] || !args[tid2 + 1]) { console.error("Usage: feedback correct --task-id <id> --tier <tier>"); process.exit(1); }
      const correctedTier = args[tid2 + 1]!;
      if (!["trivial", "simple", "moderate", "complex", "apex"].includes(correctedTier)) {
        console.error(`Invalid tier: ${correctedTier}`);
        process.exit(1);
      }
      await submitCorrection(args[tid + 1]!, correctedTier as ComplexityTier); return;
    }
    if (args[1] === "tune" || args[1] === "auto-tune") {
      const status = await autoTuneWeights(args.includes("--promote"));
      if (status === "insufficient" || status === "rejected") process.exitCode = 2;
      return;
    }
    console.error("Unknown feedback subcommand. Use: list | correct | tune"); process.exit(1);
  }

  if (args[0] === "--models") {
    const config = await loadModels();
    console.log("\nAvailable models:");
    for (const [key, m] of Object.entries(config.models)) {
      console.log(`  ${key.padEnd(16)} ${m.id.padEnd(24)} ${m.provider.padEnd(12)} ${m.costTier.padEnd(8)} ${m.label}`);
    }
    console.log("\nTier defaults:");
    for (const [tier, key] of Object.entries(config.tierDefaults)) {
      console.log(`  ${tier.padEnd(12)} -> ${key}`);
    }
    console.log("\nPersona overrides:");
    for (const [persona, overrides] of Object.entries(config.personaOverrides)) {
      if (Object.keys(overrides).length > 0) {
        console.log(`  ${persona}: ${JSON.stringify(overrides)}`);
      }
    }
    return;
  }

  const jsonMode = args.includes("--json");
  const personaIdx = args.findIndex(a => a === "--persona");
  const persona = personaIdx !== -1 ? (args[personaIdx + 1] ?? null) : null;
  const options: any = {};
  const bi = args.findIndex(a => a === "--budget"); if (bi !== -1) options.budget = args[bi + 1];
  const li = args.findIndex(a => a === "--latency"); if (li !== -1) options.latency = args[li + 1];
  const qi = args.findIndex(a => a === "--quality"); if (qi !== -1) options.quality = args[qi + 1];
  const si = args.findIndex(a => a === "--speed"); if (si !== -1) options.speed = args[si + 1];
  const flagValueIndices = new Set(
    [bi, li, qi, si, personaIdx].filter(i => i !== -1).map(i => i + 1)
  );
  const rawTaskText = args.filter((a, idx) => !a.startsWith("--") && !flagValueIndices.has(idx)).join(" ");
  const taskText = sanitizeTaskText(rawTaskText);

  if (!taskText) {
    console.error("Usage: bun persona-tier-resolve.ts [options] \"<task prompt>\"");
    console.error("Run with --help for full options.");
    process.exit(1);
  }

  const interactive = args.includes("--interactive");
  const startTime = Bun.nanoseconds();
  const complexity = await estimateComplexity(taskText, options);
  const config = await loadModels();
  const pool = config.externalRouting ? await loadExternalPool() : null;
  const recommendation = resolveModel(complexity.tier, complexity.inferredTaskType, complexity.constraints, persona, config, { interactive, pool });
  const elapsedMs = (Bun.nanoseconds() - startTime) / 1_000_000;

  if (!args.includes("--no-feedback")) {
    const feedbackText = feedbackTaskText(rawTaskText);
    await logFeedback({
      id: randomUUID(),
      timestamp: Date.now(),
      taskText: feedbackText.taskText,
      recommendedTier: complexity.tier,
      recommendedModel: recommendation.modelId,
      signals: complexity.signals,
      persona: persona || undefined,
      inputLength: feedbackText.inputLength,
      taskTextTruncated: feedbackText.truncated,
      taskTextSanitized: feedbackText.sanitized,
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      complexity: {
        tier: complexity.tier,
        score: complexity.score,
        inferredTaskType: complexity.inferredTaskType,
        semanticMatch: complexity.semanticMatch,
        domainPattern: complexity.domainPattern,
        constraints: complexity.constraints,
        scopeModifier: complexity.scopeModifier,
        signals: complexity.signals,
      },
      model: recommendation,
      persona: persona || null,
      performanceMs: Math.round(elapsedMs * 100) / 100,
    }, null, 2));
  } else {
    console.log(recommendation.modelId);
  }
}

if (import.meta.main) { main(); }
