import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  getMigrationPreflight,
} from '../database.js';
import type { MemoryConfig } from 'zouroboros-core';

let tmpDir: string;
let n = 0;

const baseConfig = (): MemoryConfig => ({
  enabled: true,
  dbPath: join(tmpDir, `mig-${n++}.db`),
  vectorEnabled: false,
  autoCapture: false,
  captureIntervalMinutes: 30,
  graphBoost: false,
  hydeExpansion: false,
  decayConfig: { permanent: 99999, long: 365, medium: 90, short: 30 },
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zo-mig-'));
  n = 0;
});

afterEach(() => {
  try { closeDatabase(); } catch { /* not initialized */ }
  delete process.env.HERMES_ZOUROBOROS_ALLOW_PERSONA_BACKFILL;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a legacy store: old decay CHECK vocabulary
 * ('permanent','long','medium','short'), a NULL-persona fact, and no
 * migration ledger rows — the MEM-07 reproduced scenario.
 */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      persona TEXT,
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT NOT NULL,
      category TEXT DEFAULT 'fact',
      decay_class TEXT DEFAULT 'medium' CHECK(decay_class IN ('permanent', 'long', 'medium', 'short')),
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER,
      expires_at INTEGER,
      last_accessed INTEGER,
      confidence REAL DEFAULT 1.0,
      metadata TEXT
    );
  `);
  db.run(
    `INSERT INTO facts (id, persona, entity, value, text, decay_class) VALUES ('legacy1', NULL, 'e', 'v', 't', 'medium')`
  );
  db.close();
}

describe('MEM-07: initDatabase applies pending migrations', () => {
  test('fresh database ends fully migrated', () => {
    const config = baseConfig();
    initDatabase(config);
    const db = getDatabase();
    const rows = db.query('SELECT name FROM _migrations').all() as { name: string }[];
    const names = rows.map(r => r.name);
    expect(names).toContain('002_backfill_facts_persona_shared');
    expect(names).toContain('008_unify_decay_vocabulary');
    expect(names).toContain('102_create_fact_forgotten');
  });

  test('legacy decay store is rebuilt and accepts the new vocabulary', () => {
    process.env.HERMES_ZOUROBOROS_ALLOW_PERSONA_BACKFILL = '1';
    const config = baseConfig();
    seedLegacyDb(config.dbPath);
    initDatabase(config); // the MCP-startup path: must not throw
    const db = getDatabase();
    // 008 relabeled medium -> stable and rebuilt the CHECK.
    const fact = db.query(`SELECT persona, decay_class FROM facts WHERE id='legacy1'`).get() as {
      persona: string; decay_class: string;
    };
    expect(fact.persona).toBe('shared');
    expect(fact.decay_class).toBe('stable');
    const ddl = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`).get() as {
      sql: string;
    };
    expect(ddl.sql).not.toContain(`'permanent', 'long', 'medium', 'short'`);
    // The exact MEM-07 reproduced failure: new-vocabulary insert on an
    // upgraded store. Previously: CHECK constraint failed.
    db.run(`INSERT INTO facts (id, entity, value, text, decay_class) VALUES ('n1','e','v','t','stable')`);
    const count = db.query(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('MEM-06: 002 refuses silent NULL-persona widening', () => {
  test('refuses without explicit opt-in and writes no ledger row', () => {
    const config = baseConfig();
    seedLegacyDb(config.dbPath);
    expect(() => initDatabase(config)).toThrow(/refusing migration 002_backfill_facts_persona_shared/);
    try { closeDatabase(); } catch { /* init threw partway */ }
    // MEM-11: the guard ran inside the migration transaction, so the refusal
    // left no partial ledger row behind.
    const db = new Database(config.dbPath, { readonly: true });
    const rows = db
      .query(`SELECT name FROM _migrations WHERE name='002_backfill_facts_persona_shared'`)
      .all();
    db.close();
    expect(rows.length).toBe(0);
  });

  test('opt-in backfills and completes the upgrade', () => {
    process.env.HERMES_ZOUROBOROS_ALLOW_PERSONA_BACKFILL = '1';
    const config = baseConfig();
    seedLegacyDb(config.dbPath);
    initDatabase(config);
    const db = getDatabase();
    const fact = db.query(`SELECT persona FROM facts WHERE id='legacy1'`).get() as { persona: string };
    expect(fact.persona).toBe('shared');
  });
});

describe('getMigrationPreflight', () => {
  test('fresh path reports no database', () => {
    const config = baseConfig();
    const pre = getMigrationPreflight(config);
    expect(pre.pending).toEqual([]);
    expect(pre.nullPersonaFacts).toBe(0);
    expect(pre.legacyDecayCheck).toBe(false);
  });

  test('legacy store reports pending migrations, NULL personas and old CHECK', () => {
    const config = baseConfig();
    seedLegacyDb(config.dbPath);
    const pre = getMigrationPreflight(config);
    expect(pre.pending).toContain('002_backfill_facts_persona_shared');
    expect(pre.pending).toContain('008_unify_decay_vocabulary');
    expect(pre.nullPersonaFacts).toBe(1);
    expect(pre.legacyDecayCheck).toBe(true);
  });

  test('preflight never migrates', () => {
    const config = baseConfig();
    seedLegacyDb(config.dbPath);
    getMigrationPreflight(config);
    const db = new Database(config.dbPath, { readonly: true });
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
    db.close();
    expect(tables.map(t => t.name)).not.toContain('_migrations');
  });
});
