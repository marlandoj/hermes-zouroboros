import { createHash } from 'node:crypto';
import {
  MODAL_RAG_CANDIDATE_MODEL,
  isCandidateCollectionName,
} from './candidate-collection.js';

export const DEFAULT_CANDIDATE_SHADOW_BUDGET_MS = 750;

export interface CandidateEmbeddingArtifact {
  schemaVersion: 1;
  classification: 'public';
  callbackId: string;
  querySha256: string;
  itemCount: 1;
  model: typeof MODAL_RAG_CANDIDATE_MODEL;
  dimensions: number;
  vector: number[];
  vectorSha256: string;
  cleanup: { complete: boolean };
}

export interface CandidateHit {
  id: string;
  chunkId: string;
  source: string;
  score: number;
  contentSha256?: string;
}

export interface CandidateRetrievalRequest {
  query: string;
  classification: 'public';
  collection: string;
  budgetMs?: number;
  topK?: number;
  minScore?: number;
}

export interface CandidateRetrievalDependencies {
  embed(request: {
    query: string;
    querySha256: string;
    classification: 'public';
    model: typeof MODAL_RAG_CANDIDATE_MODEL;
    signal: AbortSignal;
  }): Promise<unknown>;
  search(request: {
    collection: string;
    vector: number[];
    topK: number;
    minScore: number;
    signal: AbortSignal;
  }): Promise<unknown>;
  acceptedCallbackIds?: Set<string>;
}

export type CandidateRetrievalStatus =
  | 'ok'
  | 'timeout'
  | 'budget_exhausted'
  | 'failed';

export interface CandidateRetrievalEvidence {
  status: CandidateRetrievalStatus;
  classification: 'public';
  collection: string;
  querySha256: string;
  model: typeof MODAL_RAG_CANDIDATE_MODEL;
  latencyMs: number;
  budgetMs: number;
  hits: CandidateHit[];
  resultConsumed: false;
  cleanupComplete: boolean;
  error?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function candidateVectorSha256(vector: number[]): string {
  return sha256(JSON.stringify(vector));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function validateCandidateEmbeddingArtifact(
  value: unknown,
  querySha256: string,
  acceptedCallbackIds = new Set<string>(),
): CandidateEmbeddingArtifact {
  const artifact = requireObject(value, 'Candidate embedding artifact') as unknown as CandidateEmbeddingArtifact;
  if (artifact.schemaVersion !== 1) throw new Error('Candidate embedding artifact schemaVersion must be 1');
  if (artifact.classification !== 'public') throw new Error('Candidate embedding artifact must be public');
  if (artifact.querySha256 !== querySha256) throw new Error('Candidate embedding query digest mismatch');
  if (artifact.itemCount !== 1) throw new Error('Candidate embedding artifact must contain exactly one query');
  if (!artifact.callbackId || typeof artifact.callbackId !== 'string') throw new Error('Candidate callback ID is required');
  if (acceptedCallbackIds.has(artifact.callbackId)) throw new Error('Duplicate candidate callback');
  if (!artifact.model || Object.entries(MODAL_RAG_CANDIDATE_MODEL).some(([key, expected]) => (
    (artifact.model as unknown as Record<string, unknown>)[key] !== expected
  ))) {
    throw new Error('Candidate embedding model manifest mismatch');
  }
  if (artifact.dimensions !== MODAL_RAG_CANDIDATE_MODEL.dimensions) {
    throw new Error(`Candidate embedding dimensions must be ${MODAL_RAG_CANDIDATE_MODEL.dimensions}`);
  }
  if (!Array.isArray(artifact.vector) || artifact.vector.length !== MODAL_RAG_CANDIDATE_MODEL.dimensions) {
    throw new Error(`Candidate vector must contain ${MODAL_RAG_CANDIDATE_MODEL.dimensions} values`);
  }
  if (artifact.vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error('Candidate vector contains a non-finite value');
  }
  if (artifact.vectorSha256 !== candidateVectorSha256(artifact.vector)) {
    throw new Error('Candidate vector digest mismatch');
  }
  if (artifact.cleanup?.complete !== true) throw new Error('Candidate embedding cleanup was incomplete');
  acceptedCallbackIds.add(artifact.callbackId);
  return artifact;
}

function validateCandidateHits(value: unknown, topK: number, minScore: number): CandidateHit[] {
  const raw = requireObject(value, 'Candidate search response');
  if (!Array.isArray(raw.result)) throw new Error('Candidate search result must be an array');
  return raw.result.slice(0, topK).map((entry, index) => {
    const hit = requireObject(entry, `Candidate search result[${index}]`);
    const payload = requireObject(hit.payload, `Candidate search result[${index}].payload`);
    const id = typeof hit.id === 'string' || typeof hit.id === 'number' ? String(hit.id) : '';
    const score = hit.score;
    const chunkId = payload.chunk_id;
    const source = payload.source;
    if (!id) throw new Error(`Candidate search result[${index}] ID is invalid`);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error(`Candidate search result[${index}] score is invalid`);
    }
    if (typeof chunkId !== 'string' || !chunkId) {
      throw new Error(`Candidate search result[${index}] chunk_id is invalid`);
    }
    if (typeof source !== 'string' || !source) {
      throw new Error(`Candidate search result[${index}] source is invalid`);
    }
    if (payload.classification !== 'public') {
      throw new Error(`Candidate search result[${index}] is not public`);
    }
    const contentSha256 = typeof payload.content_sha256 === 'string' ? payload.content_sha256 : undefined;
    return { id, chunkId, source, score, contentSha256 };
  }).filter((hit) => hit.score >= minScore);
}

function failureEvidence(
  request: CandidateRetrievalRequest,
  querySha256: string,
  budgetMs: number,
  startTime: number,
  status: Exclude<CandidateRetrievalStatus, 'ok'>,
  error: unknown,
): CandidateRetrievalEvidence {
  return {
    status,
    classification: 'public',
    collection: request.collection,
    querySha256,
    model: MODAL_RAG_CANDIDATE_MODEL,
    latencyMs: Date.now() - startTime,
    budgetMs,
    hits: [],
    resultConsumed: false,
    cleanupComplete: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function retrieveCandidate(
  request: CandidateRetrievalRequest,
  dependencies: CandidateRetrievalDependencies,
): Promise<CandidateRetrievalEvidence> {
  const startTime = Date.now();
  const budgetMs = request.budgetMs ?? DEFAULT_CANDIDATE_SHADOW_BUDGET_MS;
  const querySha256 = sha256(request.query);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return failureEvidence(request, querySha256, Math.max(0, budgetMs), startTime, 'budget_exhausted', 'Candidate budget exhausted');
  }
  if (!request.query.trim()) {
    return failureEvidence(request, querySha256, budgetMs, startTime, 'failed', 'Candidate query is empty');
  }
  if (!request.collection.trim()) {
    return failureEvidence(request, querySha256, budgetMs, startTime, 'failed', 'Candidate collection is required');
  }
  if (!isCandidateCollectionName(request.collection)) {
    return failureEvidence(request, querySha256, budgetMs, startTime, 'failed', 'Candidate collection name is invalid');
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Candidate retrieval exceeded ${budgetMs}ms budget`));
    }, budgetMs);
  });

  try {
    const operation = (async () => {
      const rawArtifact = await dependencies.embed({
        query: request.query,
        querySha256,
        classification: 'public',
        model: MODAL_RAG_CANDIDATE_MODEL,
        signal: controller.signal,
      });
      const artifact = validateCandidateEmbeddingArtifact(
        rawArtifact,
        querySha256,
        dependencies.acceptedCallbackIds,
      );
      const rawHits = await dependencies.search({
        collection: request.collection,
        vector: artifact.vector,
        topK: request.topK ?? 5,
        minScore: request.minScore ?? 0,
        signal: controller.signal,
      });
      const hits = validateCandidateHits(rawHits, request.topK ?? 5, request.minScore ?? 0);
      return { artifact, hits };
    })();
    const { hits } = await Promise.race([operation, deadline]);
    return {
      status: 'ok',
      classification: 'public',
      collection: request.collection,
      querySha256,
      model: MODAL_RAG_CANDIDATE_MODEL,
      latencyMs: Date.now() - startTime,
      budgetMs,
      hits,
      resultConsumed: false,
      cleanupComplete: true,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return failureEvidence(request, querySha256, budgetMs, startTime, timedOut ? 'timeout' : 'failed', error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createHttpCandidateRetrievalDependencies(
  options: {
    embeddingUrl?: string;
    qdrantUrl?: string;
    qdrantApiKey?: string;
    embeddingBearerToken?: string;
    fetchImpl?: typeof fetch;
    acceptedCallbackIds?: Set<string>;
  } = {},
): CandidateRetrievalDependencies {
  const fetchImpl = options.fetchImpl ?? fetch;
  const embeddingUrl = options.embeddingUrl ?? process.env.MODAL_RAG_CANDIDATE_EMBED_URL;
  const qdrantUrl = options.qdrantUrl ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6333';
  const qdrantApiKey = options.qdrantApiKey ?? process.env.QDRANT_API_KEY;
  const embeddingBearerToken = options.embeddingBearerToken ?? process.env.MODAL_RAG_CANDIDATE_TOKEN;
  return {
    acceptedCallbackIds: options.acceptedCallbackIds ?? new Set<string>(),
    async embed(request) {
      if (!embeddingUrl) throw new Error('MODAL_RAG_CANDIDATE_EMBED_URL is not configured');
      const response = await fetchImpl(embeddingUrl, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(embeddingBearerToken ? { Authorization: `Bearer ${embeddingBearerToken}` } : {}),
        },
        body: JSON.stringify({
          schemaVersion: 1,
          query: request.query,
          querySha256: request.querySha256,
          classification: request.classification,
          model: request.model,
        }),
      });
      if (!response.ok) throw new Error(`Candidate embedding transport failed: ${response.status}`);
      return response.json();
    },
    async search(request) {
      const response = await fetchImpl(`${qdrantUrl}/collections/${encodeURIComponent(request.collection)}/points/search`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          'api-key': qdrantApiKey ?? '',
        },
        body: JSON.stringify({ vector: request.vector, limit: request.topK, with_payload: true }),
      });
      if (!response.ok) throw new Error(`Candidate Qdrant search failed: ${response.status}`);
      return response.json();
    },
  };
}
