/**
 * Reranker for memory search results — two tiers with graceful degradation.
 *
 * Tier 1 (dormant unless armed): local cross-encoder via a TEI/Infinity-style
 *   /rerank HTTP endpoint. Zero API cost, GPU-local latency. Concept adopted
 *   from vectorize-io/hindsight's cross-encoder reranking; HTTP pattern ported
 *   from packages/rag (ZOU-420). Armed ONLY by the memory-specific
 *   ZO_MEMORY_RERANK_BASE_URL — deliberately not by the shared
 *   ZO_RERANK_BASE_URL, so arming the RAG tier never silently changes
 *   memory behavior (Articles V and IX). It may point at the same endpoint.
 *
 * Tier 2 (original path): LLM-listwise rerank (gpt-4o-mini) that selects and
 *   reorders the most relevant results for a given query.
 *
 * Final fallback: truncation in retrieval order — never worse than today.
 */

import type { MemoryConfig, MemorySearchResult } from 'zouroboros-core';
import { llmCall } from './llm.js';

const DEFAULT_TOP_K = 6;
const DEFAULT_MODEL = 'gpt-4o-mini';
const PREVIEW_CHARS = 300;
const LOCAL_PASSAGE_CHARS = 800;
const LOCAL_TIMEOUT_MS = 10_000;
const DEFAULT_LOCAL_MODEL = 'bge-reranker-v2';

export interface LocalRerankConfig {
  baseUrl: string;
  model: string;
  token: string;
  maxDocs: number;
  armed: boolean;
}

/**
 * Resolve the local tier config lazily from the environment (tests flip env
 * per case; servers set it before process start).
 */
export function localRerankConfig(env: Record<string, string | undefined> = process.env): LocalRerankConfig {
  const baseUrl = (env.ZO_MEMORY_RERANK_BASE_URL || '').replace(/\/+$/, '');
  return {
    baseUrl,
    model: env.ZO_MEMORY_RERANK_MODEL || DEFAULT_LOCAL_MODEL,
    token: env.ZO_MEMORY_RERANK_API_KEY || '',
    maxDocs: Number(env.ZO_MEMORY_RERANK_MAX_DOCS || 60) || 60,
    armed: baseUrl.length > 0,
  };
}

export function localRerankArmed(): boolean {
  return localRerankConfig().armed;
}

/**
 * Reorder candidates with a self-hosted cross-encoder via /rerank.
 *
 * Returns the full list reordered (candidates the endpoint omitted, plus any
 * overflow beyond maxDocs, appended in original order), or null when the tier
 * is unarmed or fails — the caller then falls back to the LLM-listwise path,
 * which is never worse than today's behavior.
 *
 * Request shape:  { query, documents: string[], model }
 * Tolerated responses: TEI { results: [{ index, relevance_score }] } and
 * Infinity-style { indices, scores }.
 */
export async function rerankWithCrossEncoder(
  query: string,
  results: MemorySearchResult[],
  options: { config?: LocalRerankConfig; fetcher?: typeof fetch } = {},
): Promise<MemorySearchResult[] | null> {
  const cfg = options.config ?? localRerankConfig();
  if (!cfg.armed || results.length === 0) return null;

  const candidates = results.slice(0, cfg.maxDocs);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

  let order: number[];
  try {
    const resp = await (options.fetcher ?? fetch)(`${cfg.baseUrl}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        documents: candidates.map(r => r.entry.value.slice(0, LOCAL_PASSAGE_CHARS)),
        model: cfg.model,
      }),
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`[reranker] local cross-encoder HTTP ${resp.status}; falling back to LLM-listwise`);
      return null;
    }
    const data = (await resp.json()) as {
      results?: Array<{ index: number; relevance_score?: number }>;
      indices?: number[];
    };
    if (Array.isArray(data.results) && data.results.length > 0) {
      order = [...data.results]
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .map(r => r.index);
    } else if (Array.isArray(data.indices)) {
      order = data.indices;
    } else {
      console.error('[reranker] unparseable cross-encoder response; falling back to LLM-listwise');
      return null;
    }
  } catch (err) {
    console.error(`[reranker] local cross-encoder failed; falling back to LLM-listwise: ${(err as Error).message}`);
    return null;
  }

  const valid = [...new Set(order)].filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length);
  if (valid.length === 0) return null;

  const seen = new Set(valid);
  const reranked = valid.map(i => candidates[i]);
  for (let i = 0; i < results.length; i++) {
    if (!seen.has(i)) reranked.push(results[i]);
  }
  return reranked;
}

export async function rerankResults(
  query: string,
  results: MemorySearchResult[],
  config: MemoryConfig,
  topK?: number,
): Promise<MemorySearchResult[]> {
  const k = topK ?? config.reranker?.maxContextChunks ?? DEFAULT_TOP_K;
  if (results.length <= k) return results;

  // Tier 1: local cross-encoder (dormant unless armed). Any failure falls
  // through to the LLM-listwise path — today's behavior, never worse.
  const local = await rerankWithCrossEncoder(query, results);
  if (local) return local.slice(0, k);

  // Tier 2: LLM-listwise (original path).
  const model = config.reranker?.model ?? DEFAULT_MODEL;

  const numbered = results
    .map((r, i) => `[${i + 1}] ${r.entry.value.slice(0, PREVIEW_CHARS)}`)
    .join('\n\n');

  const prompt = `You are a relevance judge. Given a question and numbered context passages, return ONLY the numbers of the ${k} most relevant passages in order of relevance, comma-separated.

Question: ${query}

Passages:
${numbered}

Return ONLY comma-separated numbers (e.g. "3,1,5"). No explanation.`;

  try {
    const resp = await llmCall({ prompt, model, temperature: 0.0, maxTokens: 60 });
    const indices = resp.content
      .match(/\d+/g)
      ?.map(Number)
      .filter(n => n >= 1 && n <= results.length) ?? [];

    if (indices.length === 0) return results.slice(0, k);

    const seen = new Set<number>();
    const reranked: MemorySearchResult[] = [];
    for (const idx of indices) {
      if (!seen.has(idx) && reranked.length < k) {
        seen.add(idx);
        reranked.push(results[idx - 1]);
      }
    }
    for (let i = 0; i < results.length && reranked.length < k; i++) {
      if (!seen.has(i + 1)) reranked.push(results[i]);
    }
    return reranked;
  } catch {
    return results.slice(0, k);
  }
}
