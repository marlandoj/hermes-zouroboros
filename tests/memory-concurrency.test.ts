import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Regression for concurrent writers sharing one memory.db (assessment D-03): Hermes and Claude Code
// each run integration/mcp.ts against the same file, so writes from separate processes must wait for
// the lock instead of failing with SQLITE_BUSY ("database is locked").
const root = resolve(import.meta.dir, '..');
const writer = `
  const [db, id, n] = process.argv.slice(2);
  const { initDatabase, storeFact } = await import(${JSON.stringify(join(root, 'packages/memory/dist/index.js'))});
  const { DEFAULT_CONFIG } = await import(${JSON.stringify(join(root, 'packages/core/dist/index.js'))});
  const config = { ...DEFAULT_CONFIG.memory, dbPath: db, vectorEnabled: false, autoCapture: false };
  initDatabase(config);
  let errors = 0;
  for (let i = 0; i < Number(n); i++) {
    try { await storeFact({ actor: 'shared', entity: 'concurrency-' + id, value: 'writer ' + id + ' item ' + i, category: 'fact', source: 'test' }, config); }
    catch { errors++; }
  }
  console.log(errors);
`;

describe('memory database under concurrent writers', () => {
  test('two processes x 200 writes all persist without lock errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-concurrency-'));
    try {
      const db = join(dir, 'memory.db');
      const script = join(dir, 'writer.ts');
      await Bun.write(script, writer);
      // Create the schema once so the test measures concurrent writes, not concurrent DDL.
      const seed = Bun.spawn([process.execPath, script, db, 'seed', '0'], { stdout: 'pipe' });
      await seed.exited;
      const writers = [0, 1].map(id => Bun.spawn([process.execPath, script, db, String(id), '200'], { stdout: 'pipe', stderr: 'pipe' }));
      const errors = await Promise.all(writers.map(async p => Number((await new Response(p.stdout).text()).trim().split('\n').pop())));
      await Promise.all(writers.map(p => p.exited));
      const rows = (new Database(db, { readonly: true }).query("SELECT count(*) AS c FROM facts WHERE entity LIKE 'concurrency-%'").get() as { c: number }).c;
      expect(errors).toEqual([0, 0]);
      expect(rows).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
