import {
  MODAL_RAG_CANDIDATE_DIMENSIONS,
  MODAL_RAG_CANDIDATE_MODEL,
  canonicalCandidateJson,
  sha256CandidateContent,
  type CandidateCorpusManifest,
} from './candidate-collection.js';

export interface RagQualificationBatchItem {
  id: string;
  text: string;
  contentSha256: string;
}

export interface RagQualificationBatch {
  schemaVersion: 1;
  classification: 'public';
  batchId: string;
  batchSha256: string;
  corpusManifestSha256: string;
  model: typeof MODAL_RAG_CANDIDATE_MODEL;
  itemCount: number;
  items: RagQualificationBatchItem[];
}

export interface RagQualificationEmbeddingItem {
  id: string;
  dimensions: typeof MODAL_RAG_CANDIDATE_DIMENSIONS;
  vectorBase64: string;
  sha256: string;
}

export interface RagQualificationEmbeddingArtifact {
  schemaVersion: 1;
  classification: 'public';
  batchId: string;
  batchSha256: string;
  corpusManifestSha256: string;
  model: typeof MODAL_RAG_CANDIDATE_MODEL;
  device: 'cuda';
  deviceName: string;
  itemCount: number;
  vectorSetSha256: string;
  durationMs: number;
  providerStartedAt?: string;
  providerCompletedAt?: string;
  items: RagQualificationEmbeddingItem[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_ADDRESS = /^sha256:[a-f0-9]{64}$/;
const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\b[^\s@]+@(?:jnj\.com|its\.jnj\.com)\b/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256.test(parsed)) throw new Error(`${label} must be lowercase SHA-256`);
  return parsed;
}

function validateModel(value: unknown): typeof MODAL_RAG_CANDIDATE_MODEL {
  const raw = object(value, 'Qualification model');
  for (const [key, expected] of Object.entries(MODAL_RAG_CANDIDATE_MODEL)) {
    if (raw[key] !== expected) throw new Error(`Qualification model manifest mismatch: ${key}`);
  }
  return MODAL_RAG_CANDIDATE_MODEL;
}

export function computeRagQualificationBatchSha256(
  batch: Omit<RagQualificationBatch, 'batchId' | 'batchSha256'> | RagQualificationBatch,
): string {
  const { batchId: _batchId, batchSha256: _batchSha256, ...unsigned } = batch as RagQualificationBatch;
  return sha256CandidateContent(canonicalCandidateJson(unsigned));
}

export function buildRagQualificationBatch(
  corpusManifestSha256: string,
  items: readonly RagQualificationBatchItem[],
): RagQualificationBatch {
  const unsigned = {
    schemaVersion: 1 as const,
    classification: 'public' as const,
    corpusManifestSha256,
    model: MODAL_RAG_CANDIDATE_MODEL,
    itemCount: items.length,
    items: items.map((item) => ({ ...item })),
  };
  const batchSha256 = computeRagQualificationBatchSha256(unsigned as RagQualificationBatch);
  return validateRagQualificationBatch({
    ...unsigned,
    batchId: `sha256:${batchSha256}`,
    batchSha256,
  });
}

export function buildRagQualificationBatches(
  manifest: CandidateCorpusManifest,
  chunkTexts: ReadonlyMap<string, string>,
  maximumItemsPerBatch = 256,
): RagQualificationBatch[] {
  if (!Number.isInteger(maximumItemsPerBatch) || maximumItemsPerBatch < 1) throw new Error('maximumItemsPerBatch must be a positive integer');
  const result: RagQualificationBatch[] = [];
  for (let index = 0; index < manifest.chunks.length; index += maximumItemsPerBatch) {
    result.push(buildRagQualificationBatch(
      manifest.manifestSha256,
      manifest.chunks.slice(index, index + maximumItemsPerBatch).map((chunk) => {
        const text = chunkTexts.get(chunk.chunkId);
        if (text === undefined) throw new Error(`Candidate chunk text is unavailable: ${chunk.chunkId}`);
        return {
          id: chunk.chunkId,
          text,
          contentSha256: chunk.contentSha256,
        };
      }),
    ));
  }
  return result;
}

export function validateRagQualificationBatch(value: unknown): RagQualificationBatch {
  const raw = object(value, 'Qualification batch');
  if (raw.schemaVersion !== 1 || raw.classification !== 'public') throw new Error('Qualification batch must be schema v1 public content');
  const batchId = string(raw.batchId, 'Qualification batch ID');
  const batchSha256 = digest(raw.batchSha256, 'Qualification batch SHA-256');
  const corpusManifestSha256 = digest(raw.corpusManifestSha256, 'Qualification corpus manifest SHA-256');
  if (!CONTENT_ADDRESS.test(batchId) || batchId !== `sha256:${batchSha256}`) throw new Error('Qualification batch content address mismatch');
  const model = validateModel(raw.model);
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.itemCount !== raw.items.length) {
    throw new Error('Qualification batch item count mismatch');
  }
  const ids = new Set<string>();
  const items: RagQualificationBatchItem[] = raw.items.map((entry, index) => {
    const item = object(entry, `Qualification batch item[${index}]`);
    const id = string(item.id, `Qualification batch item[${index}].id`);
    const text = string(item.text, `Qualification batch item[${index}].text`);
    const contentSha256 = digest(item.contentSha256, `Qualification batch item[${index}].contentSha256`);
    if (ids.has(id)) throw new Error(`Duplicate qualification item: ${id}`);
    if (SENSITIVE_CONTENT.test(text)) throw new Error(`Sensitive-data pattern in qualification item: ${id}`);
    if (sha256CandidateContent(text) !== contentSha256) throw new Error(`Qualification item content digest mismatch: ${id}`);
    ids.add(id);
    return { id, text, contentSha256 };
  });
  const batch: RagQualificationBatch = {
    schemaVersion: 1,
    classification: 'public',
    batchId,
    batchSha256,
    corpusManifestSha256,
    model,
    itemCount: items.length,
    items,
  };
  if (computeRagQualificationBatchSha256(batch) !== batchSha256) throw new Error('Qualification batch digest mismatch');
  return batch;
}

export function validateRagQualificationEmbeddingArtifact(
  value: unknown,
  batchValue: unknown,
): RagQualificationEmbeddingArtifact {
  const batch = validateRagQualificationBatch(batchValue);
  const raw = object(value, 'Qualification embedding artifact');
  if (raw.schemaVersion !== 1 || raw.classification !== 'public') throw new Error('Qualification artifact must be schema v1 public content');
  if (raw.batchId !== batch.batchId || raw.batchSha256 !== batch.batchSha256 || raw.corpusManifestSha256 !== batch.corpusManifestSha256) {
    throw new Error('Qualification artifact batch identity mismatch');
  }
  const model = validateModel(raw.model);
  if (raw.device !== 'cuda') throw new Error('Qualification artifact must be produced on CUDA');
  const deviceName = string(raw.deviceName, 'Qualification artifact deviceName');
  if (!Number.isFinite(raw.durationMs) || Number(raw.durationMs) < 0) throw new Error('Qualification artifact duration is invalid');
  const hasProviderStartedAt = raw.providerStartedAt !== undefined;
  const hasProviderCompletedAt = raw.providerCompletedAt !== undefined;
  if (hasProviderStartedAt !== hasProviderCompletedAt) throw new Error('Qualification artifact provider timing is incomplete');
  let providerStartedAt: string | undefined;
  let providerCompletedAt: string | undefined;
  if (hasProviderStartedAt && hasProviderCompletedAt) {
    providerStartedAt = string(raw.providerStartedAt, 'Qualification artifact providerStartedAt');
    providerCompletedAt = string(raw.providerCompletedAt, 'Qualification artifact providerCompletedAt');
    const startedAt = Date.parse(providerStartedAt);
    const completedAt = Date.parse(providerCompletedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      throw new Error('Qualification artifact provider timing is invalid');
    }
  }
  if (!Array.isArray(raw.items) || raw.itemCount !== batch.itemCount || raw.items.length !== batch.itemCount) {
    throw new Error('Qualification artifact item count mismatch');
  }
  const expectedIds = batch.items.map((item) => item.id);
  const seen = new Set<string>();
  const items: RagQualificationEmbeddingItem[] = raw.items.map((entry, index) => {
    const item = object(entry, `Qualification artifact item[${index}]`);
    const id = string(item.id, `Qualification artifact item[${index}].id`);
    if (id !== expectedIds[index]) throw new Error(`Qualification artifact item order mismatch: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate qualification artifact item: ${id}`);
    if (item.dimensions !== MODAL_RAG_CANDIDATE_DIMENSIONS) throw new Error(`Qualification vector dimensions mismatch: ${id}`);
    const vectorBase64 = string(item.vectorBase64, `Qualification artifact item[${index}].vectorBase64`);
    const bytes = Buffer.from(vectorBase64, 'base64');
    if (bytes.byteLength !== MODAL_RAG_CANDIDATE_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error(`Qualification vector byte length mismatch: ${id}`);
    }
    const sha256 = digest(item.sha256, `Qualification artifact item[${index}].sha256`);
    if (sha256CandidateContent(bytes) !== sha256) throw new Error(`Qualification vector digest mismatch: ${id}`);
    const vector = new Float32Array(Uint8Array.from(bytes).buffer);
    if ([...vector].some((entry) => !Number.isFinite(entry))) throw new Error(`Qualification vector contains non-finite values: ${id}`);
    seen.add(id);
    return { id, dimensions: MODAL_RAG_CANDIDATE_DIMENSIONS, vectorBase64, sha256 };
  });
  const vectorSetSha256 = digest(raw.vectorSetSha256, 'Qualification vector-set SHA-256');
  if (sha256CandidateContent(items.map((item) => `${item.id}\0${item.sha256}`).join('\0')) !== vectorSetSha256) {
    throw new Error('Qualification vector-set digest mismatch');
  }
  return {
    schemaVersion: 1,
    classification: 'public',
    batchId: batch.batchId,
    batchSha256: batch.batchSha256,
    corpusManifestSha256: batch.corpusManifestSha256,
    model,
    device: 'cuda',
    deviceName,
    itemCount: items.length,
    vectorSetSha256,
    durationMs: Number(raw.durationMs),
    ...(providerStartedAt && providerCompletedAt ? { providerStartedAt, providerCompletedAt } : {}),
    items,
  };
}
