import { createHash } from 'node:crypto';
import {
  RAG_CHUNK_CHARS,
  RAG_CHUNK_OVERLAP,
} from './ingestion.js';

export const MODAL_RAG_CANDIDATE_LOGICAL_NAME = 'zouroboros-modal-minilm-v1';
export const MODAL_RAG_CANDIDATE_DIMENSIONS = 384;
export const MODAL_RAG_INCUMBENT_DIMENSIONS = 1536;

export const MODAL_RAG_CANDIDATE_MODEL = Object.freeze({
  modelId: 'sentence-transformers/all-MiniLM-L6-v2',
  revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41',
  implementation: 'sentence-transformers@5.1.2',
  torchVersion: '2.8.0',
  dimensions: MODAL_RAG_CANDIDATE_DIMENSIONS,
  normalizeEmbeddings: true,
  quantizationDecimals: 2,
  license: 'Apache-2.0',
});

export const MODAL_RAG_CORPUS_MINIMUMS = Object.freeze({
  sourceDocuments: 500,
  chunks: 2_000,
  heldOutQueries: 200,
});

export const MODAL_RAG_CORPUS_STRATA = [
  'code',
  'documentation',
  'governance',
  'workflow_and_swarm',
  'rag_and_memory_public_docs',
] as const;

export type CandidateCorpusStratum = (typeof MODAL_RAG_CORPUS_STRATA)[number];
export type EmbeddingPath = 'candidate-384' | 'incumbent-1536';

export interface CandidateSourceLicense {
  spdxId: 'MIT';
  path: 'LICENSE';
  sha256: string;
}

export interface CandidateCorpusSource {
  id: string;
  path: string;
  stratum: CandidateCorpusStratum;
  classification: 'public';
  sourceCommit: string;
  license: CandidateSourceLicense;
  contentSha256: string;
  bytes: number;
}

export interface CandidateCorpusChunk {
  chunkId: string;
  sourceId: string;
  source: string;
  stratum: CandidateCorpusStratum;
  classification: 'public';
  sourceCommit: string;
  sourceLicense: 'MIT';
  sourceLicensePath: 'LICENSE';
  sourceLicenseSha256: string;
  chunkIndex: number;
  chunkTotal: number;
  contentSha256: string;
}

export interface CandidateCorpusManifest {
  schemaVersion: 1;
  corpusId: string;
  classification: 'public';
  repository: 'https://github.com/marlandoj/zouroboros';
  sourceCommit: string;
  createdAt: string;
  collection: {
    logicalName: typeof MODAL_RAG_CANDIDATE_LOGICAL_NAME;
    physicalName: string;
    vectorDimensions: typeof MODAL_RAG_CANDIDATE_DIMENSIONS;
    distance: 'Cosine';
  };
  model: typeof MODAL_RAG_CANDIDATE_MODEL;
  chunking: {
    chars: typeof RAG_CHUNK_CHARS;
    overlap: typeof RAG_CHUNK_OVERLAP;
    deterministicChunkIds: true;
  };
  counts: {
    sourceDocuments: number;
    chunks: number;
  };
  sources: CandidateCorpusSource[];
  chunks: CandidateCorpusChunk[];
  manifestSha256: string;
}

export interface CandidateHeldOutQuery {
  id: string;
  stratum: CandidateCorpusStratum;
  classification: 'public';
  text: string;
  relevantChunkIds: string[];
}

export interface CandidateHeldOutQuerySet {
  schemaVersion: 1;
  corpusId: string;
  classification: 'public';
  sourceCommit: string;
  corpusManifestSha256: string;
  counts: { queries: number };
  queries: CandidateHeldOutQuery[];
  querySetSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PHYSICAL_COLLECTION = /^zouroboros-modal-minilm-v1-[a-f0-9]{12}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\/-]+$/;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|secrets?|credentials?|private|shared-facts\.db)(?:\/|$)/i;
const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\b[^\s@]+@(?:jnj\.com|its\.jnj\.com)\b/i;

export function sha256CandidateContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function normalizeCandidateUtf8Text(content: string): string {
  return Buffer.from(content, 'utf8').toString('utf8');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalCandidateJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeCandidateCorpusManifestSha256(
  manifest: Omit<CandidateCorpusManifest, 'manifestSha256'> | CandidateCorpusManifest,
): string {
  const { manifestSha256: _ignored, ...unsigned } = manifest as CandidateCorpusManifest;
  const { physicalName: _derived, ...collection } = unsigned.collection;
  return sha256CandidateContent(canonicalCandidateJson({ ...unsigned, collection }));
}

export function computeCandidateQuerySetSha256(
  querySet: Omit<CandidateHeldOutQuerySet, 'querySetSha256'> | CandidateHeldOutQuerySet,
): string {
  const { querySetSha256: _ignored, ...unsigned } = querySet as CandidateHeldOutQuerySet;
  return sha256CandidateContent(canonicalCandidateJson(unsigned));
}

export function candidateCollectionName(manifestSha256: string): string {
  if (!SHA256.test(manifestSha256)) throw new Error('Candidate corpus manifest digest must be lowercase SHA-256');
  return `${MODAL_RAG_CANDIDATE_LOGICAL_NAME}-${manifestSha256.slice(0, 12)}`;
}

export function isCandidateCollectionName(value: string): boolean {
  return PHYSICAL_COLLECTION.test(value);
}

export function assertEmbeddingPathDimensions(path: EmbeddingPath, dimensions: number): void {
  const expected = path === 'candidate-384' ? MODAL_RAG_CANDIDATE_DIMENSIONS : MODAL_RAG_INCUMBENT_DIMENSIONS;
  if (dimensions !== expected) {
    throw new Error(`${path} requires ${expected} dimensions; received ${dimensions}`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be lowercase SHA-256`);
  return result;
}

function sourceLicense(value: unknown, label: string): CandidateSourceLicense {
  const raw = object(value, label);
  if (raw.spdxId !== 'MIT' || raw.path !== 'LICENSE') throw new Error(`${label} must reference the repository MIT license`);
  return { spdxId: 'MIT', path: 'LICENSE', sha256: digest(raw.sha256, `${label}.sha256`) };
}

function validateModel(value: unknown): typeof MODAL_RAG_CANDIDATE_MODEL {
  const raw = object(value, 'candidate model');
  for (const [key, expected] of Object.entries(MODAL_RAG_CANDIDATE_MODEL)) {
    if (raw[key] !== expected) throw new Error(`Candidate model manifest mismatch: ${key}`);
  }
  return MODAL_RAG_CANDIDATE_MODEL;
}

export function validateCandidateCorpusManifest(value: unknown): CandidateCorpusManifest {
  const raw = object(value, 'candidate corpus manifest');
  if (raw.schemaVersion !== 1) throw new Error('Candidate corpus schemaVersion must be 1');
  if (raw.classification !== 'public') throw new Error('Candidate corpus must be classified public');
  if (raw.repository !== 'https://github.com/marlandoj/zouroboros') throw new Error('Candidate corpus repository is not approved');
  const sourceCommit = string(raw.sourceCommit, 'sourceCommit');
  if (!COMMIT.test(sourceCommit)) throw new Error('sourceCommit must be a full lowercase Git commit');
  const corpusId = string(raw.corpusId, 'corpusId');
  const collection = object(raw.collection, 'collection');
  if (collection.logicalName !== MODAL_RAG_CANDIDATE_LOGICAL_NAME) throw new Error('Candidate logical collection name mismatch');
  if (typeof collection.physicalName !== 'string' || !PHYSICAL_COLLECTION.test(collection.physicalName)) {
    throw new Error('Candidate physical collection name is invalid');
  }
  assertEmbeddingPathDimensions('candidate-384', Number(collection.vectorDimensions));
  if (collection.distance !== 'Cosine') throw new Error('Candidate collection distance must be Cosine');
  const model = validateModel(raw.model);
  const chunking = object(raw.chunking, 'chunking');
  if (chunking.chars !== RAG_CHUNK_CHARS || chunking.overlap !== RAG_CHUNK_OVERLAP || chunking.deterministicChunkIds !== true) {
    throw new Error('Candidate corpus must use deterministic 1500/200 chunking');
  }
  if (!Array.isArray(raw.sources) || raw.sources.length < MODAL_RAG_CORPUS_MINIMUMS.sourceDocuments) {
    throw new Error(`Candidate corpus requires at least ${MODAL_RAG_CORPUS_MINIMUMS.sourceDocuments} source documents`);
  }
  if (!Array.isArray(raw.chunks) || raw.chunks.length < MODAL_RAG_CORPUS_MINIMUMS.chunks) {
    throw new Error(`Candidate corpus requires at least ${MODAL_RAG_CORPUS_MINIMUMS.chunks} chunks`);
  }
  const sourceIds = new Set<string>();
  const sourceMap = new Map<string, CandidateCorpusSource>();
  const sources = raw.sources.map((entry, index) => {
    const source = object(entry, `sources[${index}]`);
    const id = string(source.id, `sources[${index}].id`);
    const path = string(source.path, `sources[${index}].path`);
    if (sourceIds.has(id)) throw new Error(`Duplicate source ID: ${id}`);
    if (!SAFE_PATH.test(path) || SENSITIVE_PATH.test(path)) throw new Error(`Unsafe public source path: ${path}`);
    if (!MODAL_RAG_CORPUS_STRATA.includes(source.stratum as CandidateCorpusStratum)) throw new Error(`Invalid source stratum: ${source.stratum}`);
    if (source.classification !== 'public' || source.sourceCommit !== sourceCommit) throw new Error(`Invalid public source provenance: ${id}`);
    const parsed: CandidateCorpusSource = {
      id,
      path,
      stratum: source.stratum as CandidateCorpusStratum,
      classification: 'public',
      sourceCommit,
      license: sourceLicense(source.license, `sources[${index}].license`),
      contentSha256: digest(source.contentSha256, `sources[${index}].contentSha256`),
      bytes: Number(source.bytes),
    };
    if (!Number.isInteger(parsed.bytes) || parsed.bytes < 1) throw new Error(`Invalid source byte count: ${id}`);
    sourceIds.add(id);
    sourceMap.set(id, parsed);
    return parsed;
  });
  const chunkIds = new Set<string>();
  const chunks = raw.chunks.map((entry, index) => {
    const chunk = object(entry, `chunks[${index}]`);
    const id = string(chunk.chunkId, `chunks[${index}].chunkId`);
    const sourceId = string(chunk.sourceId, `chunks[${index}].sourceId`);
    const source = sourceMap.get(sourceId);
    if (!source) throw new Error(`Unknown chunk source: ${sourceId}`);
    if (chunkIds.has(id)) throw new Error(`Duplicate chunk ID: ${id}`);
    const parsed: CandidateCorpusChunk = {
      chunkId: id,
      sourceId,
      source: string(chunk.source, `chunks[${index}].source`),
      stratum: chunk.stratum as CandidateCorpusStratum,
      classification: 'public',
      sourceCommit: string(chunk.sourceCommit, `chunks[${index}].sourceCommit`),
      sourceLicense: chunk.sourceLicense as 'MIT',
      sourceLicensePath: chunk.sourceLicensePath as 'LICENSE',
      sourceLicenseSha256: digest(chunk.sourceLicenseSha256, `chunks[${index}].sourceLicenseSha256`),
      chunkIndex: Number(chunk.chunkIndex),
      chunkTotal: Number(chunk.chunkTotal),
      contentSha256: digest(chunk.contentSha256, `chunks[${index}].contentSha256`),
    };
    if (chunk.classification !== 'public' || parsed.source !== source.path || parsed.stratum !== source.stratum || parsed.sourceCommit !== sourceCommit) {
      throw new Error(`Chunk provenance mismatch: ${id}`);
    }
    if (parsed.sourceLicense !== source.license.spdxId || parsed.sourceLicensePath !== source.license.path || parsed.sourceLicenseSha256 !== source.license.sha256) throw new Error(`Chunk license mismatch: ${id}`);
    if (!Number.isInteger(parsed.chunkIndex) || parsed.chunkIndex < 0 || !Number.isInteger(parsed.chunkTotal) || parsed.chunkTotal < 1 || parsed.chunkIndex >= parsed.chunkTotal) {
      throw new Error(`Chunk position is invalid: ${id}`);
    }
    chunkIds.add(id);
    return parsed;
  });
  const chunksBySource = new Map<string, CandidateCorpusChunk[]>();
  for (const chunk of chunks) {
    const group = chunksBySource.get(chunk.sourceId) ?? [];
    group.push(chunk);
    chunksBySource.set(chunk.sourceId, group);
  }
  for (const source of sources) {
    const group = chunksBySource.get(source.id) ?? [];
    if (group.length === 0) throw new Error(`Candidate source has no chunks: ${source.id}`);
    if (group.some((chunk) => chunk.chunkTotal !== group.length)) throw new Error(`Candidate chunk total mismatch: ${source.id}`);
    const positions = new Set(group.map((chunk) => chunk.chunkIndex));
    if (positions.size !== group.length || group.some((_, index) => !positions.has(index))) {
      throw new Error(`Candidate chunk positions are incomplete: ${source.id}`);
    }
  }
  const counts = object(raw.counts, 'counts');
  if (counts.sourceDocuments !== sources.length || counts.chunks !== chunks.length) throw new Error('Candidate corpus counts mismatch');
  const manifestSha256 = digest(raw.manifestSha256, 'manifestSha256');
  const createdAt = string(raw.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be an ISO timestamp');
  const manifest: CandidateCorpusManifest = {
    schemaVersion: 1,
    corpusId,
    classification: 'public',
    repository: 'https://github.com/marlandoj/zouroboros',
    sourceCommit,
    createdAt,
    collection: {
      logicalName: MODAL_RAG_CANDIDATE_LOGICAL_NAME,
      physicalName: collection.physicalName as string,
      vectorDimensions: MODAL_RAG_CANDIDATE_DIMENSIONS,
      distance: 'Cosine',
    },
    model,
    chunking: { chars: RAG_CHUNK_CHARS, overlap: RAG_CHUNK_OVERLAP, deterministicChunkIds: true },
    counts: { sourceDocuments: sources.length, chunks: chunks.length },
    sources,
    chunks,
    manifestSha256,
  };
  if (candidateCollectionName(manifestSha256) !== manifest.collection.physicalName) throw new Error('Candidate collection name does not match manifest digest');
  if (computeCandidateCorpusManifestSha256(manifest) !== manifestSha256) throw new Error('Candidate corpus manifest digest mismatch');
  return manifest;
}

export function validateCandidateHeldOutQuerySet(value: unknown, manifest: CandidateCorpusManifest): CandidateHeldOutQuerySet {
  const raw = object(value, 'candidate held-out query set');
  if (raw.schemaVersion !== 1 || raw.classification !== 'public') throw new Error('Candidate query set must be schema v1 and public');
  if (raw.corpusId !== manifest.corpusId || raw.sourceCommit !== manifest.sourceCommit || raw.corpusManifestSha256 !== manifest.manifestSha256) {
    throw new Error('Candidate query set corpus identity mismatch');
  }
  if (!Array.isArray(raw.queries) || raw.queries.length < MODAL_RAG_CORPUS_MINIMUMS.heldOutQueries) {
    throw new Error(`Candidate query set requires at least ${MODAL_RAG_CORPUS_MINIMUMS.heldOutQueries} queries`);
  }
  const knownChunks = new Set(manifest.chunks.map((chunk) => chunk.chunkId));
  const ids = new Set<string>();
  const represented = new Set<CandidateCorpusStratum>();
  const queries = raw.queries.map((entry, index) => {
    const query = object(entry, `queries[${index}]`);
    const id = string(query.id, `queries[${index}].id`);
    const text = string(query.text, `queries[${index}].text`);
    const stratum = query.stratum as CandidateCorpusStratum;
    if (ids.has(id)) throw new Error(`Duplicate query ID: ${id}`);
    if (!MODAL_RAG_CORPUS_STRATA.includes(stratum)) throw new Error(`Invalid query stratum: ${query.stratum}`);
    if (query.classification !== 'public' || SENSITIVE_CONTENT.test(text)) throw new Error(`Invalid public query: ${id}`);
    if (!Array.isArray(query.relevantChunkIds) || query.relevantChunkIds.length < 1 || query.relevantChunkIds.some((chunkId) => typeof chunkId !== 'string' || !knownChunks.has(chunkId))) {
      throw new Error(`Query relevance labels are invalid: ${id}`);
    }
    ids.add(id);
    represented.add(stratum);
    return { id, stratum, classification: 'public' as const, text, relevantChunkIds: [...query.relevantChunkIds] as string[] };
  });
  if (represented.size !== MODAL_RAG_CORPUS_STRATA.length) throw new Error('Candidate query set must cover every corpus stratum');
  const counts = object(raw.counts, 'counts');
  if (counts.queries !== queries.length) throw new Error('Candidate query count mismatch');
  const querySetSha256 = digest(raw.querySetSha256, 'querySetSha256');
  const result: CandidateHeldOutQuerySet = {
    schemaVersion: 1,
    corpusId: manifest.corpusId,
    classification: 'public',
    sourceCommit: manifest.sourceCommit,
    corpusManifestSha256: manifest.manifestSha256,
    counts: { queries: queries.length },
    queries,
    querySetSha256,
  };
  if (computeCandidateQuerySetSha256(result) !== querySetSha256) throw new Error('Candidate query set digest mismatch');
  return result;
}
