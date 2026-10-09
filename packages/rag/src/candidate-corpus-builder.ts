import {
  MODAL_RAG_CANDIDATE_DIMENSIONS,
  MODAL_RAG_CANDIDATE_LOGICAL_NAME,
  MODAL_RAG_CANDIDATE_MODEL,
  MODAL_RAG_CORPUS_MINIMUMS,
  MODAL_RAG_CORPUS_STRATA,
  candidateCollectionName,
  computeCandidateCorpusManifestSha256,
  computeCandidateQuerySetSha256,
  sha256CandidateContent,
  validateCandidateCorpusManifest,
  validateCandidateHeldOutQuerySet,
  type CandidateCorpusChunk,
  type CandidateCorpusManifest,
  type CandidateCorpusSource,
  type CandidateCorpusStratum,
  type CandidateHeldOutQuery,
  type CandidateHeldOutQuerySet,
} from './candidate-collection.js';
import { approvedCandidateRepository } from './candidate-policy.js';
import {
  RAG_CHUNK_CHARS,
  RAG_CHUNK_OVERLAP,
  chunkText,
  deterministicChunkId,
} from './ingestion.js';

export interface CandidateCorpusBuildSource {
  path: string;
  text: string;
  stratum: CandidateCorpusStratum;
}

export interface CandidateCorpusBuildOptions {
  sourceCommit: string;
  createdAt: string;
  licenseSha256: string;
  sources: readonly CandidateCorpusBuildSource[];
  /** Defaults to, and must equal, ZOUROBOROS_CANDIDATE_REPOSITORY. */
  repository?: string;
}

export interface CandidateCorpusArtifacts {
  manifest: CandidateCorpusManifest;
  querySet: CandidateHeldOutQuerySet;
  chunkTexts: ReadonlyMap<string, string>;
}

function sourceId(path: string): string {
  return `sha256:${sha256CandidateContent(path)}`;
}

function queryTerms(text: string): string[] {
  const ignored = new Set(['const', 'export', 'import', 'from', 'function', 'return', 'string', 'number', 'interface', 'public']);
  const terms = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [];
  return [...new Set(terms.map((term) => term.toLowerCase()).filter((term) => !ignored.has(term)))].slice(0, 8);
}

function buildQueryText(chunk: CandidateCorpusChunk, chunkText: string): string {
  const name = chunk.source.split('/').at(-1) ?? chunk.source;
  const terms = queryTerms(chunkText);
  return `Locate the public Zouroboros ${chunk.stratum.replaceAll('_', ' ')} source ${name} covering ${terms.join(', ')}.`;
}

export function buildCandidateCorpusManifest(options: CandidateCorpusBuildOptions): CandidateCorpusManifest {
  const sources: CandidateCorpusSource[] = [];
  const chunks: CandidateCorpusChunk[] = [];
  for (const input of [...options.sources].sort((left, right) => left.path.localeCompare(right.path))) {
    const id = sourceId(input.path);
    const sourceChunks = chunkText(input.text);
    if (sourceChunks.length === 0) continue;
    const source: CandidateCorpusSource = {
      id,
      path: input.path,
      stratum: input.stratum,
      classification: 'public',
      sourceCommit: options.sourceCommit,
      license: { spdxId: 'MIT', path: 'LICENSE', sha256: options.licenseSha256 },
      contentSha256: sha256CandidateContent(input.text),
      bytes: Buffer.byteLength(input.text),
    };
    sources.push(source);
    for (const [chunkIndex, text] of sourceChunks.entries()) {
      chunks.push({
        chunkId: deterministicChunkId(id, chunkIndex, text),
        sourceId: id,
        source: input.path,
        stratum: input.stratum,
        classification: 'public',
        sourceCommit: options.sourceCommit,
        sourceLicense: 'MIT',
        sourceLicensePath: 'LICENSE',
        sourceLicenseSha256: options.licenseSha256,
        chunkIndex,
        chunkTotal: sourceChunks.length,
        contentSha256: sha256CandidateContent(text),
      });
    }
  }
  if (sources.length < MODAL_RAG_CORPUS_MINIMUMS.sourceDocuments || chunks.length < MODAL_RAG_CORPUS_MINIMUMS.chunks) {
    throw new Error(`Candidate corpus minimums not met: ${sources.length} sources, ${chunks.length} chunks`);
  }
  const repository = approvedCandidateRepository();
  if (options.repository !== undefined && options.repository !== repository) throw new Error('Candidate corpus repository is not approved');
  const corpusId = `zouroboros-public-${options.sourceCommit.slice(0, 12)}`;
  const unsigned = {
    schemaVersion: 1 as const,
    corpusId,
    classification: 'public' as const,
    repository,
    sourceCommit: options.sourceCommit,
    createdAt: options.createdAt,
    collection: {
      logicalName: MODAL_RAG_CANDIDATE_LOGICAL_NAME,
      physicalName: '',
      vectorDimensions: MODAL_RAG_CANDIDATE_DIMENSIONS,
      distance: 'Cosine' as const,
    },
    model: MODAL_RAG_CANDIDATE_MODEL,
    chunking: { chars: RAG_CHUNK_CHARS, overlap: RAG_CHUNK_OVERLAP, deterministicChunkIds: true as const },
    counts: { sourceDocuments: sources.length, chunks: chunks.length },
    sources,
    chunks,
  };
  const manifestSha256 = computeCandidateCorpusManifestSha256(unsigned as CandidateCorpusManifest);
  return validateCandidateCorpusManifest({
    ...unsigned,
    collection: { ...unsigned.collection, physicalName: candidateCollectionName(manifestSha256) },
    manifestSha256,
  });
}

export function buildCandidateHeldOutQuerySet(
  manifest: CandidateCorpusManifest,
  chunkTexts: ReadonlyMap<string, string>,
  queriesPerStratum = MODAL_RAG_CORPUS_MINIMUMS.heldOutQueries / MODAL_RAG_CORPUS_STRATA.length,
): CandidateHeldOutQuerySet {
  if (!Number.isInteger(queriesPerStratum) || queriesPerStratum < 1) throw new Error('queriesPerStratum must be a positive integer');
  const queries: CandidateHeldOutQuery[] = [];
  for (const stratum of MODAL_RAG_CORPUS_STRATA) {
    const candidates = manifest.chunks.filter((chunk) => chunk.stratum === stratum);
    if (candidates.length < queriesPerStratum) throw new Error(`Candidate corpus has too few held-out labels for ${stratum}`);
    for (const chunk of candidates.slice(0, queriesPerStratum)) {
      const chunkText = chunkTexts.get(chunk.chunkId);
      if (chunkText === undefined || sha256CandidateContent(chunkText) !== chunk.contentSha256) {
        throw new Error(`Candidate chunk text is unavailable or invalid: ${chunk.chunkId}`);
      }
      const text = buildQueryText(chunk, chunkText);
      queries.push({
        id: `sha256:${sha256CandidateContent(`${stratum}\0${chunk.chunkId}\0${text}`)}`,
        stratum,
        classification: 'public',
        text,
        relevantChunkIds: [chunk.chunkId],
      });
    }
  }
  const unsigned = {
    schemaVersion: 1 as const,
    corpusId: manifest.corpusId,
    classification: 'public' as const,
    sourceCommit: manifest.sourceCommit,
    corpusManifestSha256: manifest.manifestSha256,
    counts: { queries: queries.length },
    queries,
  };
  const querySetSha256 = computeCandidateQuerySetSha256(unsigned as CandidateHeldOutQuerySet);
  return validateCandidateHeldOutQuerySet({ ...unsigned, querySetSha256 }, manifest);
}

export function buildCandidateCorpusArtifacts(options: CandidateCorpusBuildOptions): CandidateCorpusArtifacts {
  const manifest = buildCandidateCorpusManifest(options);
  const chunkTexts = new Map<string, string>();
  for (const input of [...options.sources].sort((left, right) => left.path.localeCompare(right.path))) {
    const id = sourceId(input.path);
    for (const [chunkIndex, text] of chunkText(input.text).entries()) {
      chunkTexts.set(deterministicChunkId(id, chunkIndex, text), text);
    }
  }
  return { manifest, querySet: buildCandidateHeldOutQuerySet(manifest, chunkTexts), chunkTexts };
}
