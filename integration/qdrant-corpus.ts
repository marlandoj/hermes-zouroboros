// Shared helpers for skills that build or query their own Qdrant corpus (the gaming corpus skills).
// Replaces the Zouroboros host's zo-memory-system model client and RAG pipeline: dense embeddings
// come straight from an OpenAI-compatible endpoint configured in the profile environment, and the
// sparse vector reproduces the host's hashed BM25 term-frequency scheme so collections built with
// either implementation stay query-compatible.
//
//   QDRANT_URL                 Qdrant base URL (default http://127.0.0.1:6333)
//   QDRANT_API_KEY             optional Qdrant API key
//   OPENAI_API_KEY             required for embeddings; never read from a file by this module
//   OPENAI_BASE_URL            optional OpenAI-compatible base URL (default https://api.openai.com/v1)
//   CORPUS_EMBEDDING_MODEL     embedding model (default text-embedding-3-small, 1536 dimensions)

export interface SparseVector { indices: number[]; values: number[] }
export interface EmbedResult { embedding: number[]; model: string }

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export function qdrantUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
}

export function qdrantHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.QDRANT_API_KEY) headers['api-key'] = env.QDRANT_API_KEY;
  return headers;
}

export async function embeddings(text: string, env: Record<string, string | undefined> = process.env): Promise<EmbedResult> {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set; add it to the Hermes profile environment');
  const model = env.CORPUS_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: text, model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Embeddings request failed with status ${response.status}`);
  const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
  return { embedding: data.data?.[0]?.embedding ?? [], model };
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from', 'had',
  'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 's', 'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'been', 'being',
  'am', 'not', 'no', 'nor', 'up', 'down', 'out', 'over', 'under', 'more', 'most', 'such',
  'very', 'can', 'could', 'would', 'should', 'might', 'may', 'must', 'ought',
]);

const SPARSE_BUCKETS = 1 << 20;

function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SPARSE_BUCKETS;
}

export function bm25Tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_]+/g)) {
    const token = match[0];
    if (token.length < 2 || token.length > 30 || STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Hashed term-frequency sparse vector (log(1 + tf)); Qdrant applies IDF when the index uses modifier "idf". */
export function buildSparseVector(text: string): SparseVector {
  const tf = new Map<number, number>();
  for (const token of bm25Tokenize(text)) {
    const index = hashToken(token);
    tf.set(index, (tf.get(index) ?? 0) + 1);
  }
  const indices: number[] = [];
  const values: number[] = [];
  for (const [index, count] of tf) {
    indices.push(index);
    values.push(Math.log(1 + count));
  }
  return { indices, values };
}
