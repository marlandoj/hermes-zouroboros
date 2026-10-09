#!/usr/bin/env bun
/**
 * Graph connectivity of the profile memory database, for the Graph Connectivity playbooks.
 *
 *   graph-connectivity.ts                 prints "Linked facts: N (X%)" and "Orphan facts: M"
 *   graph-connectivity.ts knowledge-gaps  also lists the entities with the most orphan facts
 *
 * Replaces the source host's workspace graph script. Reads ZOUROBOROS_MEMORY_DB (the profile
 * database under the Hermes integration) and opens it read-only.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { getMemoryDbPath } from 'zouroboros-core';

export function connectivity(dbPath = getMemoryDbPath()) {
  if (!existsSync(dbPath)) throw new Error('memory database not found (set ZOUROBOROS_MEMORY_DB)');
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    if (!tables.has('facts')) return { total: 0, linked: 0, orphans: 0, ratio: 0, gaps: [] };
    const total = (db.query('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;
    if (!tables.has('fact_links')) return { total, linked: 0, orphans: total, ratio: 0, gaps: [] };
    const linked = (db.query('SELECT COUNT(*) AS n FROM facts WHERE id IN (SELECT source_id FROM fact_links UNION SELECT target_id FROM fact_links)').get() as { n: number }).n;
    const gaps = db.query(`SELECT entity, COUNT(*) AS orphans FROM facts
      WHERE id NOT IN (SELECT source_id FROM fact_links UNION SELECT target_id FROM fact_links)
      GROUP BY entity ORDER BY orphans DESC, entity LIMIT 20`).all() as { entity: string; orphans: number }[];
    return { total, linked, orphans: total - linked, ratio: total ? linked / total : 0, gaps };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const result = connectivity();
    console.log(`Linked facts: ${result.linked} (${(result.ratio * 100).toFixed(1)}%)`);
    console.log(`Orphan facts: ${result.orphans}`);
    if (process.argv[2] === 'knowledge-gaps') for (const gap of result.gaps) console.log(`  ${gap.entity}: ${gap.orphans} orphan fact(s)`);
  } catch (error) {
    console.error(`graph connectivity failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
