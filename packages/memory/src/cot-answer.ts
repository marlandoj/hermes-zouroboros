/**
 * Chain-of-Thought answering with multi-hop fallback.
 *
 * Takes retrieved memory chunks and uses CoT reasoning to extract
 * a precise answer. If the first pass can't answer, it refines the
 * query and does a second retrieval pass (multi-hop).
 *
 * Disposition traits (concept adopted from vectorize-io/hindsight's reflect
 * dispositions): optional 0..1 knobs — skepticism, literalism, empathy — that
 * shape HOW the answer is reasoned and phrased. All neutral (0) by default,
 * which renders no prompt block and keeps behavior byte-identical
 * (Article IX). Set per call via options.disposition or process-wide via
 * ZO_COT_SKEPTICISM / ZO_COT_LITERALISM / ZO_COT_EMPATHY; the explicit
 * per-call value wins over the env var.
 */

import type { MemoryConfig, MemorySearchResult, CotAnswerResult } from 'zouroboros-core';
import { llmCall } from './llm.js';
import { routeMemoryQuery } from './routing-gate.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_CHAR_LIMIT = 4000;

export interface Disposition {
  /** Scrutinize evidence; prefer "Not specified" over guessing. */
  skepticism?: number;
  /** Answer strictly from stated facts; no inference. */
  literalism?: number;
  /** Warmer, person-aware phrasing of the final answer. */
  empathy?: number;
}

const DISPOSITION_ENV: Record<keyof Required<Disposition>, string> = {
  skepticism: 'ZO_COT_SKEPTICISM',
  literalism: 'ZO_COT_LITERALISM',
  empathy: 'ZO_COT_EMPATHY',
};

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Resolve the effective disposition: explicit per-call value wins, then the
 * env var, then neutral 0. Values are clamped to [0, 1]; unparsable env
 * values fail safe to neutral.
 */
export function resolveDisposition(
  explicit?: Disposition,
  env: Record<string, string | undefined> = process.env,
): Required<Disposition> {
  const knob = (key: keyof Required<Disposition>): number => {
    if (explicit?.[key] !== undefined) return clamp01(explicit[key]!);
    const raw = env[DISPOSITION_ENV[key]];
    return raw !== undefined ? clamp01(Number(raw)) : 0;
  };
  return { skepticism: knob('skepticism'), literalism: knob('literalism'), empathy: knob('empathy') };
}

/**
 * Render prompt guidance for non-neutral knobs. Returns '' when fully
 * neutral, so a neutral disposition leaves the prompt byte-identical.
 * Bands: >= 0.7 strong, 0.3–0.7 moderate, < 0.3 silent.
 */
export function dispositionInstructions(d: Required<Disposition>): string {
  const lines: string[] = [];
  if (d.skepticism >= 0.7) {
    lines.push('- Skepticism HIGH: treat every passage as a claim, not a fact. Weigh conflicting passages against each other, name any conflict in your reasoning, and prefer "Not specified in context." over a guess whenever the evidence is thin or contradictory.');
  } else if (d.skepticism >= 0.3) {
    lines.push('- Skepticism MODERATE: double-check that the passage you rely on actually supports the answer, and mention uncertainty in your reasoning when it exists.');
  }
  if (d.literalism >= 0.7) {
    lines.push('- Literalism HIGH: answer strictly from what the passages explicitly state. No inference, no common-sense completion, no merging of partial hints into a conclusion the text does not state.');
  } else if (d.literalism >= 0.3) {
    lines.push('- Literalism MODERATE: stay close to the text; allow only minimal, clearly supported inference.');
  }
  if (d.empathy >= 0.7) {
    lines.push('- Empathy HIGH: phrase the final answer with warmth and acknowledge the person behind the question (their situation, feelings, or stakes), while keeping the answer factually exact.');
  } else if (d.empathy >= 0.3) {
    lines.push('- Empathy MODERATE: use a friendly, natural tone in the final answer.');
  }
  if (lines.length === 0) return '';
  return `\nDISPOSITION (how to reason and phrase):\n${lines.join('\n')}\n`;
}

type QueryCategory = 'procedural' | 'cross-persona' | 'swarm' | 'general';

/**
 * Detect query category from question text for category-specific prompting.
 */
function detectQueryCategory(question: string): QueryCategory {
  const q = question.toLowerCase();

  // Procedural: steps, procedures, versions, workflows, evolution
  if (/\b(step|procedure|workflow|version|evolve|v\d+|success.?rate|how.?(?:do|does|to)|process)\b/.test(q)) {
    return 'procedural';
  }

  // Cross-persona: access, persona, pool, inherit, shared, who can see
  if (/\b(persona|access|pool|inherit|shared|cross.?persona|who.?(?:can|has)|visible.?to)\b/.test(q)) {
    return 'cross-persona';
  }

  // Swarm: task, dag, artifact, dependency, swarm, propagat, downstream, upstream
  if (/\b(swarm|dag|artifact|dependen|upstream|downstream|propagat|task.?(?:chain|graph|output))\b/.test(q)) {
    return 'swarm';
  }

  return 'general';
}

const CATEGORY_INSTRUCTIONS: Record<QueryCategory, string> = {
  procedural: `
DOMAIN-SPECIFIC RULES (Procedural Memory):
- When asked about steps, count them precisely from the procedure definition. List step numbers if asked "how many."
- When asked about procedure evolution (version changes), compare the specific versions and describe what changed.
- Success rates should be computed as: success_count / (success_count + failure_count).
- If asked about the "latest" or "current" version, use the highest version number.
- If asked which procedure was used for an episode, check the procedure_id linkage.
- When multiple procedures share similar names, distinguish them precisely.`,

  'cross-persona': `
DOMAIN-SPECIFIC RULES (Cross-Persona Access):
- Pay attention to [Access Info] blocks that describe who is querying and which personas are accessible.
- If a fact belongs to an inaccessible persona, treat it as "[Access Denied]" — do not include it in the answer.
- Access paths matter: "own" means direct knowledge, "pool:X" means shared via pool X, "inherited:depth-N" means inherited.
- For multi-source aggregation questions ("all facts about X"), include facts from ALL accessible personas.
- When asked "who can access X?", list personas that have X in their accessible set.`,

  swarm: `
DOMAIN-SPECIFIC RULES (Swarm Context):
- Count artifacts precisely — each distinct output or deliverable is one artifact.
- Dependency chains flow from upstream to downstream tasks. Follow the DAG edges.
- When asked about "context propagation," describe how outputs from one task feed into the next.
- For role analysis, identify the executor/agent assigned to each task.
- DAG structure questions expect topological information: roots, leaves, critical paths.`,

  general: '',
};

function buildContext(results: MemorySearchResult[], charLimit: number): string {
  const parts: string[] = [];
  let total = 0;
  for (const r of results) {
    const chunk = r.entry.value;
    if (total + chunk.length > charLimit) {
      const remaining = charLimit - total;
      if (remaining > 50) parts.push(chunk.slice(0, remaining));
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join('\n---\n');
}

export async function answerWithCoT(
  question: string,
  results: MemorySearchResult[],
  config: MemoryConfig,
  options?: { contextCharLimit?: number; disposition?: Disposition },
): Promise<CotAnswerResult> {
  const model = config.cot?.model ?? DEFAULT_MODEL;
  const charLimit = options?.contextCharLimit ?? config.reranker?.contextCharLimit ?? DEFAULT_CHAR_LIMIT;
  const enableMultiHop = config.cot?.multiHopFallback !== false;

  const context = buildContext(results, charLimit);
  const category = detectQueryCategory(question);
  const domainRules = CATEGORY_INSTRUCTIONS[category];
  const dispositionBlock = dispositionInstructions(resolveDisposition(options?.disposition));

  const cotPrompt = `You are a memory retrieval assistant. Given conversation memories, answer the question.

INSTRUCTIONS:
- First, identify which passage(s) contain information relevant to the question.
- If multiple passages mention similar topics, carefully distinguish which one actually answers the specific question asked.
- If the context does not contain enough information to answer, say "Not specified in context."
- Give a short, direct final answer — just the name, number, date, or place.
${domainRules}${dispositionBlock}
Context:
${context}

Question: ${question}

Think step by step, then give your final answer on a new line starting with "ANSWER: "`;

  const resp = await llmCall({ prompt: cotPrompt, model, temperature: 0.1, maxTokens: 400 });
  const raw = resp.content;

  const answerMatch = raw.match(/ANSWER:\s*(.+)/i);
  if (answerMatch) {
    return {
      answer: answerMatch[1].trim(),
      reasoning: raw.slice(0, raw.indexOf('ANSWER:')).trim(),
      usedMultiHop: false,
      hops: 1,
    };
  }

  if (enableMultiHop && (raw.includes('Not specified') || raw.includes('not enough'))) {
    try {
      const refinedResults = await routeMemoryQuery(
        `${question} ${raw.slice(0, 200)}`,
        config,
        { limit: 5 },
      );
      if (refinedResults.length > 0) {
        const refinedContext = buildContext(refinedResults, charLimit);
        const retryResp = await llmCall({
          prompt: `Given these additional conversation memories, answer the question with ONLY the specific fact requested. Give a short, direct answer.

Context:
${refinedContext}

Question: ${question}

Answer:`,
          model,
          temperature: 0.1,
          maxTokens: 200,
        });
        return {
          answer: retryResp.content.trim(),
          reasoning: `First pass inconclusive. Multi-hop retrieval with refined query.`,
          usedMultiHop: true,
          hops: 2,
        };
      }
    } catch { /* fall through */ }
  }

  const lastLine = raw.split('\n').pop()?.trim() || raw.trim();
  return {
    answer: lastLine,
    reasoning: raw,
    usedMultiHop: false,
    hops: 1,
  };
}
