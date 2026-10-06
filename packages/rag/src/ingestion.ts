import { createHash } from 'node:crypto';

export const RAG_CHUNK_CHARS = 1500;
export const RAG_CHUNK_OVERLAP = 200;

export function chunkText(
  text: string,
  chars = RAG_CHUNK_CHARS,
  overlap = RAG_CHUNK_OVERLAP,
): string[] {
  if (!Number.isInteger(chars) || chars < 1) throw new Error('Chunk size must be a positive integer');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chars) {
    throw new Error('Chunk overlap must be a non-negative integer smaller than the chunk size');
  }
  if (text.length <= chars) return [text];
  const advance = chars - overlap;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += advance) {
    chunks.push(text.slice(index, index + chars));
  }
  return chunks;
}

export function deterministicChunkId(sourceId: string, index: number, text: string): string {
  if (!sourceId.trim()) throw new Error('Chunk source ID is required');
  if (!Number.isInteger(index) || index < 0) throw new Error('Chunk index must be a non-negative integer');
  const digest = createHash('sha256')
    .update(sourceId)
    .update('\0')
    .update(String(index))
    .update('\0')
    .update(text)
    .digest('hex');
  return `sha256:${digest}`;
}
