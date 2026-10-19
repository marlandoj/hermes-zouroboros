import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyMemoryQuery,
  logMemoryRoute,
  getRecentRoutingDecisions,
  getRoutingDistribution,
  _resetRoutingGateCache,
} from '../routing-gate.js';

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'zo-route-'));
  dbPath = join(tmpDir, 'shared-facts.db');
  // Touch the DB so existsSync passes; the gate will CREATE TABLE on first call.
  db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS _seed (id INTEGER);');
  process.env.ZOUROBOROS_MEMORY_DB = dbPath;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The routing table is created lazily on first log; only clear it when present.
  const exists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_routing_log'"
  ).get();
  if (exists) db.exec('DELETE FROM memory_routing_log;');
});

afterEach(() => {});

describe('classifyMemoryQuery (heuristic)', () => {
  test('procedural — how-to phrasing', () => {
    const d = classifyMemoryQuery('How do I deploy the agent?');
    expect(d.kind).toBe('procedural');
    expect(d.confidence).toBeGreaterThan(0.7);
  });

  test('procedural — steps for', () => {
    const d = classifyMemoryQuery('steps for restoring a backup');
    expect(d.kind).toBe('procedural');
  });

  test('episodic — temporal cue', () => {
    const d = classifyMemoryQuery('what happened yesterday with the PR?');
    expect(d.kind).toBe('episodic');
  });

  test('episodic — last week', () => {
    const d = classifyMemoryQuery('what did we ship last week');
    expect(d.kind).toBe('episodic');
  });

  test('semantic — fact lookup', () => {
    const d = classifyMemoryQuery('what is the email address for ops');
    expect(d.kind).toBe('semantic');
  });

  test('semantic — entity-rich default', () => {
    const d = classifyMemoryQuery('Client-B quarterly review');
    expect(d.kind).toBe('semantic');
  });

  test('parametric — short generic', () => {
    const d = classifyMemoryQuery('sql joins');
    expect(d.kind).toBe('parametric');
  });

  test('parametric — empty query', () => {
    const d = classifyMemoryQuery('');
    expect(d.kind).toBe('parametric');
  });
});

describe('logMemoryRoute + getRecentRoutingDecisions', () => {
  test('persists a routing decision', () => {
    logMemoryRoute(
      'how do I run the eval',
      { kind: 'procedural', confidence: 0.9, reason: 'how-to' },
      42,
      3,
      'memory-manager',
      'sess-1',
    );
    const recent = getRecentRoutingDecisions(10);
    expect(recent.length).toBeGreaterThan(0);
    const last = recent[0];
    expect(last.kind).toBe('procedural');
    expect(last.hitCount).toBe(3);
    expect(last.persona).toBe('memory-manager');
    expect(last.latencyMs).toBe(42);
  });

  test('quotes are escaped safely', () => {
    logMemoryRoute(
      "what's the config",
      { kind: 'semantic', confidence: 0.5, reason: "default 'fallback'" },
      10,
      0,
    );
    const recent = getRecentRoutingDecisions(5);
    expect(recent[0].query).toContain("what's");
  });
});

describe('auto-create regression (W3 lesson)', () => {
  test('routing log table is created lazily even if migration 016 never ran', () => {
    // Drop the table to simulate a DB that pre-dates migration 016.
    db.exec('DROP TABLE IF EXISTS memory_routing_log;');
    _resetRoutingGateCache();

    // Logging must still succeed because routing-gate calls ensureRoutingTable.
    logMemoryRoute(
      'recovery test',
      { kind: 'semantic', confidence: 0.5, reason: 'regression check' },
      5,
      0,
    );

    // Verify the table now exists and contains the row.
    const row = db.query(
      "SELECT COUNT(*) AS n FROM memory_routing_log WHERE query='recovery test'"
    ).get() as { n: number };
    expect(row.n).toBe(1);
  });
});

describe('MEM-09: no shell interpretation in routing logs', () => {
  test('query/actor/session metacharacters are stored as data, never executed', () => {
    const sentinel = join(tmpDir, 'mem09-pwned');
    const evilQuery = `x'; $(touch "${sentinel}") ; echo '`;
    const evilActor = 'actor`touch "' + sentinel + '"`';
    const evilSession = 'sess-$(touch "' + sentinel + '")';
    const evilReason = `reason'; DROP TABLE memory_routing_log; --`;
    logMemoryRoute(
      evilQuery,
      { kind: 'semantic', confidence: 0.5, reason: evilReason },
      7,
      0,
      evilActor,
      evilSession,
    );

    // The exact hostile strings round-trip verbatim.
    const recent = getRecentRoutingDecisions(10);
    const logged = recent.find(r => r.query === evilQuery);
    expect(logged).toBeDefined();
    expect(logged!.actor).toBe(evilActor);
    expect(logged!.sessionId).toBe(evilSession);
    expect(logged!.reason).toBe(evilReason);

    // The shell never ran and the table still exists.
    expect(existsSync(sentinel)).toBe(false);
    const count = db.query('SELECT COUNT(*) AS n FROM memory_routing_log').get() as { n: number };
    expect(count.n).toBeGreaterThan(0);
  });

  test('pipe characters survive the read path intact', () => {
    // The old sqlite3-CLI read path split rows on '|', corrupting queries
    // containing pipes. Bound-parameter reads return typed rows instead.
    const q = 'deploy|rollback|status';
    logMemoryRoute(q, { kind: 'semantic', confidence: 0.5, reason: 'pipes' }, 1, 0);
    const recent = getRecentRoutingDecisions(10);
    const found = recent.find(r => r.query === q);
    expect(found).toBeDefined();
    expect(found!.query).toBe(q);
  });
});

describe('getRoutingDistribution', () => {
  test('aggregates counts by kind', () => {
    logMemoryRoute('how to x', { kind: 'procedural', confidence: 0.8, reason: 'r' }, 1, 1);
    logMemoryRoute('how to y', { kind: 'procedural', confidence: 0.8, reason: 'r' }, 1, 2);
    logMemoryRoute('what is z', { kind: 'semantic', confidence: 0.5, reason: 'r' }, 1, 3);

    const dist = getRoutingDistribution();
    expect(dist.total).toBeGreaterThanOrEqual(3);
    expect(dist.byKind.procedural.count).toBeGreaterThanOrEqual(2);
    expect(dist.byKind.semantic.count).toBeGreaterThanOrEqual(1);
  });
});
