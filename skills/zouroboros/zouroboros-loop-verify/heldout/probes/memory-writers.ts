#!/usr/bin/env bun
// Held-out probe (concurrency class): N independent processes write through the memory LIBRARY (not MCP)
// into one SQLite file. Spec: every write succeeds and is persisted.
// Usage: bun memory-writers.ts <repo> <scratch> [writers=3] [perWriter=150]
// Prints `writers=W writes=N rows=R errors=E` and exits 0 iff rows === W*N and errors === 0 (97 on setup error).
const [repo, scratch, w = '3', n = '150', role, idx] = process.argv.slice(2);
const db = `${scratch}/heldout-memory.db`;
const lib = `${repo}/packages/memory/dist/index.js`;
const core = `${repo}/packages/core/dist/index.js`;
if (role === 'child') {
  const { initDatabase, storeFact } = await import(lib);
  const { DEFAULT_CONFIG } = await import(core);
  const cfg = { ...DEFAULT_CONFIG.memory, dbPath: db, vectorEnabled: false, autoCapture: false };
  initDatabase(cfg); let errors = 0;
  for (let i = 0; i < Number(n); i++) {
    try { await storeFact({ actor: 'shared', entity: `heldout-${idx}`, key: `k${i}`, value: `writer ${idx} item ${i}`, category: 'fact', source: 'heldout' }, cfg); }
    catch { errors++; }
  }
  console.log(JSON.stringify({ errors })); process.exit(0);
}
try { await import(lib); await import(core); } catch (e) { console.log(`setup error: ${e}`); process.exit(97); }
// Pre-create the schema once so the probe measures concurrent writes, not concurrent DDL.
{ const { initDatabase, closeDatabase } = await import(lib); const { DEFAULT_CONFIG } = await import(core);
  initDatabase({ ...DEFAULT_CONFIG.memory, dbPath: db, vectorEnabled: false, autoCapture: false }); closeDatabase?.(); }
const procs = Array.from({ length: Number(w) }, (_, k) => Bun.spawn([process.execPath, import.meta.path, repo, scratch, w, n, 'child', String(k)], { stdout: 'pipe', stderr: 'pipe' }));
let errors = 0;
for (const p of procs) { const out = await new Response(p.stdout).text(); await p.exited; try { errors += JSON.parse(out.trim().split('\n').pop()!).errors; } catch { errors += Number(n); } }
const { Database } = await import('bun:sqlite');
const rows = (new Database(db, { readonly: true }).query("SELECT count(*) AS c FROM facts WHERE entity LIKE 'heldout-%'").get() as any).c;
console.log(`writers=${w} writes=${Number(w) * Number(n)} rows=${rows} errors=${errors}`);
process.exit(rows === Number(w) * Number(n) && errors === 0 ? 0 : 1);
