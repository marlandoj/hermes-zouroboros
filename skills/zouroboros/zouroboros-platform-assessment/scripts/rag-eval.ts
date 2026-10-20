// Retrieval-quality eval for Qdrant collection zouroboros-code: hit@1 / hit@5 by expected source path.
// One embedding API call for all queries (counts toward the live-call budget; needs ASSESS_ALLOW_LIVE=1).
// Usage: ASSESS_ALLOW_LIVE=1 [HZ_REPO=<checkout>] QDRANT_URL=http://127.0.0.1:6333 bun rag-eval.ts   (default: this checkout)
if (process.env.ASSESS_ALLOW_LIVE !== '1') throw new Error('Set ASSESS_ALLOW_LIVE=1 after operator approval of embedding calls');
const repo = process.env.HZ_REPO || new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const { embed, openAiKey, qdrant } = await import(`${repo}/packages/rag/scripts/qdrant-lib.ts`);
// Known-answer cases: [query, expected path suffix]. Extend to ≥20 for a stable baseline.
const cases: [string, string][] = [
  ['where is the task dependency cycle detection for swarm campaigns', 'integration/tasks.ts'],
  ['MCP tool that saves an operator reviewable campaign file', 'integration/mcp.ts'],
  ['read-only kanban board snapshot with schema fingerprint check', 'factory/kanban-intake.ts'],
  ['circuit breaker cooldown and exponential backoff per failure category', 'packages/swarm/src/circuit/breaker.ts'],
  ['shell bridge that runs hermes one-shot with a kill timeout', 'integration/hermes-bridge.sh'],
  ['scan memory payload for secrets and redact before storage', 'packages/memory/src/defense.ts'],
  ['sqlite VACUUM INTO snapshot backup', 'packages/core/src/backup.ts'],
];
const { vectors, tokens } = await embed(openAiKey(), cases.map(c => c[0]));
let h1 = 0, h5 = 0; const rows: string[] = [];
for (let i = 0; i < cases.length; i++) {
  const r: any = await qdrant('POST', '/collections/zouroboros-code/points/search', { vector: vectors[i], limit: 5, with_payload: true });
  const paths: string[] = r.map((p: any) => p.payload?.source_path ?? p.payload?.sourcePath ?? p.payload?.path ?? '?');
  const rank = paths.findIndex(p => p.endsWith(cases[i]![1])) + 1;
  if (rank === 1) h1++; if (rank >= 1) h5++;
  rows.push(`${rank || '-'}\t${r[0]?.score?.toFixed(3)}\t${cases[i]![1]}\ttop=${paths[0]}`);
}
console.log(rows.join('\n'));
console.log(JSON.stringify({ n: cases.length, hitAt1: h1, hitAt5: h5, embedTokens: tokens, embedCalls: 1 }));
