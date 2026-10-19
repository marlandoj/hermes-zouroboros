/**
 * Database management for Zouroboros Memory
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { MemoryConfig } from 'zouroboros-core';

let db: Database | null = null;

const SCHEMA_SQL = `
-- Facts table (core memory storage)
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  persona TEXT,
  entity TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT DEFAULT 'fact' CHECK(category IN ('preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project')),
  decay_class TEXT DEFAULT 'stable' CHECK(decay_class IN ('permanent', 'stable', 'active', 'session', 'checkpoint')),
  importance REAL DEFAULT 1.0,
  source TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER,
  last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
  confidence REAL DEFAULT 1.0,
  metadata TEXT
);

-- Vector embeddings for semantic search
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT DEFAULT 'text-embedding-3-small',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Episodes (event-based memory)
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'resolved', 'ongoing')),
  happened_at INTEGER NOT NULL,
  duration_ms INTEGER,
  procedure_id TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Episode entity links
CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity)
);

-- Procedures (workflow memory)
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  steps TEXT NOT NULL, -- JSON array
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  evolved_from TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Open loops (tracking unresolved items)
CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  entity TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  priority INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  resolved_at INTEGER
);

-- Continuation context
CREATE TABLE IF NOT EXISTS continuation_context (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  last_summary TEXT NOT NULL,
  open_loop_ids TEXT, -- JSON array
  entity_stack TEXT, -- JSON array
  last_agent TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Cognitive profiles
CREATE TABLE IF NOT EXISTS cognitive_profiles (
  entity TEXT PRIMARY KEY,
  traits TEXT, -- JSON object
  preferences TEXT, -- JSON object
  interaction_count INTEGER DEFAULT 0,
  last_interaction INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Skill Crystallization v1: candidates produced from weighted-success patterns
CREATE TABLE IF NOT EXISTS crystallizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('procedure', 'episode', 'skill_execution', 'mixed')),
  source_ids TEXT NOT NULL, -- JSON array of source row IDs
  source_signature TEXT NOT NULL UNIQUE, -- sha256 of sorted(source_ids); dedupes cron+hook races
  weighted_score REAL NOT NULL,
  draft_path TEXT NOT NULL,
  promoted_path TEXT,
  eval_status TEXT NOT NULL DEFAULT 'pending' CHECK(eval_status IN ('pending', 'mechanical_pass', 'mechanical_fail', 'replay_pass', 'replay_fail', 'mechanical_only', 'complete')),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
  approval_token_prefix_8 TEXT, -- first 8 chars of HMAC; never store full token
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'event_hook', 'manual')),
  llm_cost_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  evaluated_at INTEGER,
  approved_at INTEGER,
  expires_at INTEGER NOT NULL -- created_at + 14d
);

-- Append-only audit log; status transitions live here, not as UPDATEs to crystallizations
CREATE TABLE IF NOT EXISTS crystallization_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crystallization_id TEXT NOT NULL REFERENCES crystallizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('created', 'mechanical_eval', 'replay_eval', 'email_sent', 'approved', 'rejected', 'expired', 'promoted', 'reverted', 'threshold_changed')),
  payload TEXT, -- JSON; e.g. {pattern_matched, files_diff, token_prefix_8}
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Observations (evidence-backed consolidated beliefs; hindsight concept)
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'shared',
  entity TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  proof_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','contested','faded')),
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  last_evidence_at INTEGER,
  UNIQUE(persona, entity, key)
);

-- Evidence links behind each observation (exact quotes, never overwritten)
CREATE TABLE IF NOT EXISTS observation_evidence (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (observation_id, fact_id)
);

-- Mental models (standing answers; reads are plain DB reads)
CREATE TABLE IF NOT EXISTS mental_models (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'shared',
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  model TEXT,
  evidence_count INTEGER DEFAULT 0,
  refresh_interval_s INTEGER DEFAULT 86400,
  refreshed_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(persona, question)
);

-- Intelligence plane (Track 1): audit trail for every scoped memory access
CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  fact_id TEXT,
  call_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Intelligence plane (Track 1): append-only promotion pipeline ledger.
-- A fact's current stage is its latest row (capture → extraction → review →
-- promotion); review is reserved for contradictions/contested facts.
CREATE TABLE IF NOT EXISTS fact_promotions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('capture', 'extraction', 'review', 'promotion')),
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  contradiction_of TEXT REFERENCES facts(id),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Intelligence plane (Track 1): reversible forgetting. A row here hides the
-- fact from every retrieval path; deleting the row restores it. Hard deletes
-- only happen via purge after a retention window.
CREATE TABLE IF NOT EXISTS fact_forgotten (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  forgotten_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  forgotten_by TEXT NOT NULL,
  reason TEXT,
  retention_score REAL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episode_entities ON episode_entities(entity);
CREATE INDEX IF NOT EXISTS idx_open_loops_entity ON open_loops(entity, status);
CREATE INDEX IF NOT EXISTS idx_crystallizations_status ON crystallizations(eval_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_crystallizations_slug ON crystallizations(slug);
CREATE INDEX IF NOT EXISTS idx_crystallizations_expires ON crystallizations(expires_at) WHERE approval_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crystallization_events_id ON crystallization_events(crystallization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity, key);
CREATE INDEX IF NOT EXISTS idx_observations_persona ON observations(persona, status);
CREATE INDEX IF NOT EXISTS idx_mental_models_persona ON mental_models(persona);
CREATE INDEX IF NOT EXISTS idx_memory_audit_actor ON memory_audit(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_audit_fact ON memory_audit(fact_id);
CREATE INDEX IF NOT EXISTS idx_memory_audit_action ON memory_audit(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_audit_call ON memory_audit(call_id);
CREATE INDEX IF NOT EXISTS idx_fact_promotions_fact ON fact_promotions(fact_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_promotions_stage ON fact_promotions(stage, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_forgotten_at ON fact_forgotten(forgotten_at);
`;

/**
 * Initialize the database with schema
 */

/**
 * Reconcile pre-2026-09-27 VPS databases where hook-event capture owned a
 * legacy table named `observations` (schema has `hash`, no `persona`) — the
 * table name belief observations (PR #799) now use. Moves the legacy table to
 * `event_observations`: a plain rename when the target does not exist yet,
 * otherwise a row-copy + drop. Idempotent; a no-op on fresh databases. Must
 * run before SCHEMA_SQL, whose belief-observation indexes would otherwise
 * fail against the legacy shape.
 */
export function reconcileLegacyHookObservations(database: Database): void {
  const legacy = database
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'observations'`)
    .get();
  if (!legacy) return;
  const cols = new Set(
    (database.query(`PRAGMA table_info(observations)`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('hash') || cols.has('persona')) return;
  const hasPromoted = cols.has('promoted_at');
  const target = database
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'event_observations'`)
    .get();
  if (!target) {
    database.exec('ALTER TABLE observations RENAME TO event_observations');
  } else {
    database.exec(
      `INSERT OR IGNORE INTO event_observations
         (id, hash, source, session_id, tool, content, redaction_count, created_at${hasPromoted ? ', promoted_at' : ''})
       SELECT id, hash, source, session_id, tool, content, redaction_count, created_at${hasPromoted ? ', promoted_at' : ''}
       FROM observations`,
    );
    database.exec('DROP TABLE observations');
  }
}

export function initDatabase(config: MemoryConfig): Database {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) {
    const { mkdirSync } = require('fs');
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  // Several processes (Hermes and Claude Code MCP servers, CLI, selfheal) share
  // one memory.db; wait for a competing writer instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  // Legacy hook-capture table must move to event_observations before the base
  // schema creates belief-observation indexes (see reconcile helper above).
  reconcileLegacyHookObservations(db);
  db.exec(SCHEMA_SQL);
  // MEM-07: every startup path (MCP server, CLI, scripts) must see a migrated
  // schema. initDatabase applies pending migrations idempotently; the narrow
  // integration/mcp.ts path previously skipped them and failed against legacy
  // decay CHECK constraints.
  applyPendingMigrations(db);

  return db;
}

/**
 * Get the database instance (must call initDatabase first)
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Check if database is initialized
 */
export function isInitialized(): boolean {
  return db !== null;
}

/**
 * MEM-12: run a mutation and its mandatory audit as one atomic write group.
 * Executes `fn` inside a transaction on the singleton connection; an audit
 * failure rolls the mutation back instead of leaving a durable unaudited
 * change. `fn` must be synchronous — provider calls (embeddings) happen
 * BEFORE entering the group.
 */
export function atomicWriteGroup<T>(fn: () => T): T {
  return getDatabase().transaction(fn)();
}

/**
 * Run database migrations
 */
interface Migration {
  name: string;
  sql: string;
  /**
   * Optional pre-apply check; throw to refuse the migration (fail-closed).
   * Runs inside the migration's transaction, before any statement executes.
   */
  guard?: (database: Database) => void;
}

// Define migrations (ordered; each runs once, tracked by name in _migrations)
function getMigrations(): Migration[] {
  return [    {
      name: '001_ensure_facts_persona_column',
      sql: `
        -- Add persona column if missing (idempotent via pragma check)
        -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
        -- so we check the schema first
        CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
      `,
    },
    {
      name: '002_backfill_facts_persona_shared',
      // MEM-06: unknown ownership must never be widened silently. If any facts
      // still have NULL persona, refuse and require an explicit operator
      // decision instead of backfilling them to 'shared' unasked.
      guard: (database) => {
        const cols = database.query('PRAGMA table_info(facts)').all() as { name: string }[];
        if (!cols.some(c => c.name === 'persona')) return;
        const row = database.query(
          'SELECT COUNT(*) AS n FROM facts WHERE persona IS NULL'
        ).get() as { n: number };
        if (row.n > 0 && process.env.HERMES_ZOUROBOROS_ALLOW_PERSONA_BACKFILL !== '1') {
          throw new Error(
            `[hermes-zouroboros] refusing migration 002_backfill_facts_persona_shared: ` +
            `${row.n} fact(s) have NULL persona and would be silently widened to 'shared'. ` +
            `Decide ownership explicitly first (see docs/operations.md "Persona backfill preflight"), ` +
            `or set HERMES_ZOUROBOROS_ALLOW_PERSONA_BACKFILL=1 to backfill them to 'shared'.`
          );
        }
      },
      sql: `UPDATE facts SET persona = 'shared' WHERE persona IS NULL;`,
    },
    {
      name: '003_create_crystallizations',
      sql: `
        CREATE TABLE IF NOT EXISTS crystallizations (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('procedure', 'episode', 'skill_execution', 'mixed')),
          source_ids TEXT NOT NULL,
          source_signature TEXT NOT NULL UNIQUE,
          weighted_score REAL NOT NULL,
          draft_path TEXT NOT NULL,
          promoted_path TEXT,
          eval_status TEXT NOT NULL DEFAULT 'pending' CHECK(eval_status IN ('pending', 'mechanical_pass', 'mechanical_fail', 'replay_pass', 'replay_fail', 'mechanical_only', 'complete')),
          approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
          approval_token_prefix_8 TEXT,
          trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('cron', 'event_hook', 'manual')),
          llm_cost_usd REAL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          evaluated_at INTEGER,
          approved_at INTEGER,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_crystallizations_status ON crystallizations(eval_status, approval_status);
        CREATE INDEX IF NOT EXISTS idx_crystallizations_slug ON crystallizations(slug);
        CREATE INDEX IF NOT EXISTS idx_crystallizations_expires ON crystallizations(expires_at) WHERE approval_status = 'pending';
      `,
    },
    {
      name: '005_create_observations',
      sql: `
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          persona TEXT NOT NULL DEFAULT 'shared',
          entity TEXT NOT NULL,
          key TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL,
          proof_count INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','contested','faded')),
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now')),
          last_evidence_at INTEGER,
          UNIQUE(persona, entity, key)
        );
        CREATE TABLE IF NOT EXISTS observation_evidence (
          observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
          fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
          quote TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          PRIMARY KEY (observation_id, fact_id)
        );
        CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity, key);
        CREATE INDEX IF NOT EXISTS idx_observations_persona ON observations(persona, status);
      `,
    },
    {
      name: '006_create_mental_models',
      sql: `
        CREATE TABLE IF NOT EXISTS mental_models (
          id TEXT PRIMARY KEY,
          persona TEXT NOT NULL DEFAULT 'shared',
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          model TEXT,
          evidence_count INTEGER DEFAULT 0,
          refresh_interval_s INTEGER DEFAULT 86400,
          refreshed_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          UNIQUE(persona, question)
        );
        CREATE INDEX IF NOT EXISTS idx_mental_models_persona ON mental_models(persona);
      `,
    },
    {
      name: '007_create_event_observations',
      sql: `
        CREATE TABLE IF NOT EXISTS event_observations (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT,
          tool TEXT,
          content TEXT NOT NULL,
          redaction_count INTEGER NOT NULL DEFAULT 0,
          promoted_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_event_observations_hash ON event_observations(hash);
        CREATE INDEX IF NOT EXISTS idx_event_observations_created ON event_observations(created_at);
      `,
    },
    {
      name: '004_create_crystallization_events',
      sql: `
        CREATE TABLE IF NOT EXISTS crystallization_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crystallization_id TEXT NOT NULL REFERENCES crystallizations(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK(event_type IN ('created', 'mechanical_eval', 'replay_eval', 'email_sent', 'approved', 'rejected', 'expired', 'promoted', 'reverted', 'threshold_changed')),
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_crystallization_events_id ON crystallization_events(crystallization_id, created_at);
      `,
    },
    {
      name: '008_unify_decay_vocabulary',
      sql: `
        -- Adopt the activity-set decay vocabulary
        -- (permanent/stable/active/session/checkpoint) everywhere.
        -- Relabels: long -> stable, medium -> stable, short -> active.
        -- expires_at is per-row and left untouched, so existing rows keep
        -- their computed expiry; only the label (and future-write TTLs) change.
        -- The facts table is rebuilt because SQLite cannot ALTER a CHECK.
        -- (PRAGMA foreign_keys is never enabled in this codebase, so the
        -- DROP does not cascade into fact_embeddings.)
        CREATE TABLE IF NOT EXISTS facts_new (
          id TEXT PRIMARY KEY,
          persona TEXT,
          entity TEXT NOT NULL,
          key TEXT,
          value TEXT NOT NULL,
          text TEXT NOT NULL,
          category TEXT DEFAULT 'fact' CHECK(category IN ('preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project')),
          decay_class TEXT DEFAULT 'stable' CHECK(decay_class IN ('permanent', 'stable', 'active', 'session', 'checkpoint')),
          importance REAL DEFAULT 1.0,
          source TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          expires_at INTEGER,
          last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
          confidence REAL DEFAULT 1.0,
          metadata TEXT
        );
        INSERT INTO facts_new (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, expires_at, last_accessed, confidence, metadata)
          SELECT id, persona, entity, key, value, text, category,
            CASE decay_class
              WHEN 'long' THEN 'stable'
              WHEN 'medium' THEN 'stable'
              WHEN 'short' THEN 'active'
              ELSE decay_class
            END,
            importance, source, created_at, expires_at, last_accessed, confidence, metadata
          FROM facts;
        DROP TABLE facts;
        ALTER TABLE facts_new RENAME TO facts;
        CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
        CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);
        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
      `,
    },
    // -----------------------------------------------------------------
    // Migration-numbering reconciliation (Track 1, 2026-10-14).
    //
    // Two migration systems share the `_migrations` table:
    //  (a) this file's name-tracked list (INSERT (name); the integer id is
    //      auto-assigned by SQLite), and
    //  (b) packages/core/src/migrations.ts's id-tracked registry
    //      (INSERT (id, name)), whose id 8 is `008_add_procedure_episodes`.
    // The decay unification added `008_unify_decay_vocabulary` here, so the
    // number 008 now names two different migrations, and this list's
    // auto-assigned row ids can collide with core's explicit ids (core's
    // runner decides "applied" by id, so a row this list inserted can mask a
    // core migration).
    //
    // Resolution: (1) `008_unify_decay_vocabulary` keeps its name — renaming
    // an applied migration would re-run its table rebuild on deployed DBs.
    // (2) All NEW migrations in this file use the 1xx block; the 0xx numeric
    // space is ceded to packages/core's registry (currently 001–019). Core
    // ids stay < 100, so the 1xx names can never be confused with a core id,
    // and the name-vs-id collision cannot recur for new entries. The
    // pre-existing id-masking hazard between the two runners is unchanged
    // (out of Track 1 scope) but is now documented here.
    // -----------------------------------------------------------------
    {
      name: '100_create_memory_audit',
      sql: `
        CREATE TABLE IF NOT EXISTS memory_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          scope TEXT NOT NULL,
          action TEXT NOT NULL,
          fact_id TEXT,
          call_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_audit_actor ON memory_audit(actor, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_fact ON memory_audit(fact_id);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_action ON memory_audit(action, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_call ON memory_audit(call_id);
      `,
    },
    {
      name: '101_create_fact_promotions',
      sql: `
        CREATE TABLE IF NOT EXISTS fact_promotions (
          id TEXT PRIMARY KEY,
          fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK(stage IN ('capture', 'extraction', 'review', 'promotion')),
          decided_by TEXT NOT NULL,
          decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          contradiction_of TEXT REFERENCES facts(id),
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fact_promotions_fact ON fact_promotions(fact_id, decided_at DESC);
        CREATE INDEX IF NOT EXISTS idx_fact_promotions_stage ON fact_promotions(stage, decided_at DESC);
      `,
    },
    {
      name: '102_create_fact_forgotten',
      sql: `
        CREATE TABLE IF NOT EXISTS fact_forgotten (
          fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
          forgotten_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          forgotten_by TEXT NOT NULL,
          reason TEXT,
          retention_score REAL
        );
        CREATE INDEX IF NOT EXISTS idx_fact_forgotten_at ON fact_forgotten(forgotten_at);
      `,
    },
    {
      // MEM-10: episodes become actor-scoped. The column is added here (not in
      // the base schema) so this migration is the single owner of the change;
      // legacy rows keep 'shared'. The guard is defensive: the runner skips
      // recorded migrations, so a present-but-unrecorded column would mean
      // manual surgery — abort loudly rather than mis-record.
      name: '103_episodes_persona',
      guard: (database) => {
        const cols = database.query(`PRAGMA table_info(episodes)`).all() as Array<{ name: string }>;
        if (cols.some(c => c.name === 'persona')) {
          throw new Error('103_episodes_persona: persona column already present but migration not recorded — refusing to mis-record');
        }
      },
      sql: `
        ALTER TABLE episodes ADD COLUMN persona TEXT NOT NULL DEFAULT 'shared';
        CREATE INDEX IF NOT EXISTS idx_episodes_persona ON episodes(persona, happened_at DESC);
      `,
    },
  ];
}

function applyPendingMigrations(database: Database): void {
  // Migration tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  // Get applied migrations
  const applied = database.query('SELECT name FROM _migrations').all() as { name: string }[];
  const appliedSet = new Set(applied.map(m => m.name));

  // MEM-11: each migration's statements and its ledger insert run in a single
  // transaction, so a failure can never leave a half-applied migration without
  // its tracking row (or a tracking row without its statements).
  const applyOne = database.transaction((migration: Migration) => {
    if (migration.guard) migration.guard(database);
    database.exec(migration.sql);
    database.run('INSERT INTO _migrations (name) VALUES (?)', [migration.name]);
  });

  // Apply pending migrations
  for (const migration of getMigrations()) {
    if (!appliedSet.has(migration.name)) {
      applyOne(migration);
    }
  }
}

/**
 * Run database migrations
 */
export function runMigrations(config: MemoryConfig): void {
  applyPendingMigrations(initDatabase(config));
}

export interface MigrationPreflight {
  /** Migration names not yet applied to this database. */
  pending: string[];
  /** Facts with NULL persona (migration 002 refuses these without an explicit decision). */
  nullPersonaFacts: number;
  /** True when the facts table still carries the legacy decay CHECK vocabulary. */
  legacyDecayCheck: boolean;
}

/**
 * Advisory pre-upgrade report: what initDatabase would do to this store.
 * Opens the database read-only and never migrates. Used by `doctor`.
 */
export function getMigrationPreflight(config: MemoryConfig): MigrationPreflight {
  const all = getMigrations().map(m => m.name);
  if (!existsSync(config.dbPath)) {
    return { pending: [], nullPersonaFacts: 0, legacyDecayCheck: false };
  }
  const out: MigrationPreflight = { pending: all, nullPersonaFacts: 0, legacyDecayCheck: false };
  let database: Database | null = null;
  try {
    database = new Database(config.dbPath, { readonly: true });
    try {
      const applied = database.query('SELECT name FROM _migrations').all() as { name: string }[];
      const appliedSet = new Set(applied.map(m => m.name));
      out.pending = all.filter(n => !appliedSet.has(n));
    } catch {
      // No ledger yet: everything is pending (out.pending already reflects that).
    }
    const cols = database.query('PRAGMA table_info(facts)').all() as { name: string }[];
    if (cols.some(c => c.name === 'persona')) {
      out.nullPersonaFacts =
        (database.query('SELECT COUNT(*) AS n FROM facts WHERE persona IS NULL').get() as { n: number }).n ?? 0;
    }
    const ddl = database.query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`
    ).get() as { sql: string } | null;
    out.legacyDecayCheck = Boolean(ddl?.sql?.includes(`'permanent', 'long', 'medium', 'short'`));
  } finally {
    database?.close();
  }
  return out;
}

/**
 * Get database statistics
 */
export function getDbStats(config: MemoryConfig): {
  facts: number;
  episodes: number;
  procedures: number;
  openLoops: number;
  embeddings: number;
} {
  const database = initDatabase(config);

  return {
    facts: (database.query('SELECT COUNT(*) as count FROM facts').get() as { count: number }).count,
    episodes: (database.query('SELECT COUNT(*) as count FROM episodes').get() as { count: number }).count,
    procedures: (database.query('SELECT COUNT(*) as count FROM procedures').get() as { count: number }).count,
    openLoops: (database.query('SELECT COUNT(*) as count FROM open_loops').get() as { count: number }).count,
    embeddings: (database.query('SELECT COUNT(*) as count FROM fact_embeddings').get() as { count: number }).count,
  };
}
