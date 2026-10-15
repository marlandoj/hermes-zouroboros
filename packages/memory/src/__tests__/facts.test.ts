import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase, runMigrations } from '../database.js';
import {
  storeFact,
  searchFacts,
  getFact,
  deleteFact,
  forgetFact,
  restoreFact,
  sweepDecay,
  scoreRetention,
  DEFAULT_VECTOR_SIMILARITY_THRESHOLD,
} from '../facts.js';
import { MissingActorError } from '../scope.js';
import type { MemoryConfig } from 'zouroboros-core';

const TEST_CONFIG: MemoryConfig = {
  enabled: true,
  dbPath: ':memory:',
  vectorEnabled: false,
  autoCapture: false,
  captureIntervalMinutes: 30,
  graphBoost: false,
  hydeExpansion: false,
  decayConfig: { permanent: Infinity, stable: 90, active: 14, session: 1, checkpoint: 4 / 24 },
};

beforeEach(() => {
  initDatabase(TEST_CONFIG);
});

afterEach(() => {
  closeDatabase();
});

describe('storeFact', () => {
  test('pins the evidence-calibrated vector threshold', () => {
    expect(DEFAULT_VECTOR_SIMILARITY_THRESHOLD).toBe(0.46);
  });

  test('stores a fact under the actor persona by default', async () => {
    const entry = await storeFact({
      actor: 'researcher',
      entity: 'test.entity',
      value: 'test value',
    }, TEST_CONFIG);

    expect(entry.id).toBeDefined();
    expect(entry.entity).toBe('test.entity');

    const results = searchFacts('test value', { actor: 'researcher' });
    expect(results.length).toBe(1);
  });

  test('actor scope sees own persona facts, not others', async () => {
    await storeFact({
      actor: 'researcher',
      entity: 'project.zouroboros',
      value: 'uses Bun runtime',
    }, TEST_CONFIG);

    await storeFact({
      actor: 'financial-advisor',
      entity: 'project.acme',
      value: 'uses Shopify',
    }, TEST_CONFIG);

    const results = searchFacts('uses', { actor: 'researcher' });
    expect(results.length).toBe(1);
    expect(results[0].entity).toBe('project.zouroboros');
  });

  test('actor scope includes shared facts', async () => {
    await storeFact({
      actor: 'shared',
      entity: 'user.preference',
      value: 'prefers dark mode',
    }, TEST_CONFIG);

    await storeFact({
      actor: 'researcher',
      entity: 'project.zouroboros',
      value: 'prefers Bun over Node',
    }, TEST_CONFIG);

    const results = searchFacts('prefers', { actor: 'researcher' });
    expect(results.length).toBe(2);
  });

  test('actor scope excludes other persona facts', async () => {
    await storeFact({
      actor: 'financial-advisor',
      entity: 'project.acme',
      value: 'secret acme data',
    }, TEST_CONFIG);

    const results = searchFacts('acme', { actor: 'researcher' });
    expect(results.length).toBe(0);
  });

  test('the shared actor sees ONLY the shared pool', async () => {
    await storeFact({ actor: 'researcher', entity: 'a', value: 'fact one' }, TEST_CONFIG);
    await storeFact({ actor: 'financial-advisor', entity: 'b', value: 'fact two' }, TEST_CONFIG);
    await storeFact({ actor: 'shared', entity: 'c', value: 'fact three' }, TEST_CONFIG);

    const results = searchFacts('fact', { actor: 'shared' });
    expect(results.length).toBe(1);
    expect(results[0].entity).toBe('c');
  });
});

describe('fail-closed actor requirement', () => {
  test('storeFact without actor throws MissingActorError', async () => {
    await expect(
      storeFact({ entity: 'x', value: 'y' } as never, TEST_CONFIG),
    ).rejects.toBeInstanceOf(MissingActorError);
  });

  test('searchFacts without actor throws MissingActorError', () => {
    expect(() => searchFacts('anything', {} as never)).toThrow(MissingActorError);
  });

  test('empty/whitespace actor is rejected — no silent default scope', () => {
    expect(() => searchFacts('anything', { actor: '   ' })).toThrow(MissingActorError);
    expect(() => searchFacts('anything', { actor: '' })).toThrow(MissingActorError);
  });
});

describe('getFact / deleteFact', () => {
  test('retrieves a stored fact by ID within scope', async () => {
    const entry = await storeFact({
      actor: 'researcher',
      entity: 'test.entity',
      value: 'retrievable value',
    }, TEST_CONFIG);

    const found = getFact(entry.id, { actor: 'researcher' });
    expect(found).not.toBeNull();
    expect(found!.value).toBe('retrievable value');
  });

  test('getFact outside scope returns null (no information disclosure)', async () => {
    const entry = await storeFact({
      actor: 'financial-advisor',
      entity: 'secret.entity',
      value: 'secret value',
    }, TEST_CONFIG);

    expect(getFact(entry.id, { actor: 'researcher' })).toBeNull();
  });

  test('deletes a fact by ID within scope', async () => {
    const entry = await storeFact({
      actor: 'researcher',
      entity: 'test.entity',
      value: 'deletable value',
    }, TEST_CONFIG);

    const deleted = deleteFact(entry.id, { actor: 'researcher' });
    expect(deleted).toBe(true);
    expect(getFact(entry.id, { actor: 'researcher' })).toBeNull();
  });

  test('deleteFact outside scope is a no-op returning false', async () => {
    const entry = await storeFact({
      actor: 'financial-advisor',
      entity: 'secret.entity',
      value: 'protected value',
    }, TEST_CONFIG);

    expect(deleteFact(entry.id, { actor: 'researcher' })).toBe(false);
    expect(getFact(entry.id, { actor: 'financial-advisor' })).not.toBeNull();
  });
});

describe('reversible forgetting (decay)', () => {
  test('forget hides a fact from retrieval; restore brings it back', async () => {
    const entry = await storeFact({
      actor: 'researcher',
      entity: 'temp.note',
      value: 'forgettable detail',
    }, TEST_CONFIG);

    expect(searchFacts('forgettable', { actor: 'researcher' }).length).toBe(1);

    expect(forgetFact(entry.id, { actor: 'researcher', reason: 'test' })).toBe(true);
    expect(searchFacts('forgettable', { actor: 'researcher' }).length).toBe(0);
    expect(getFact(entry.id, { actor: 'researcher' })).toBeNull();

    expect(restoreFact(entry.id, { actor: 'researcher' })).toBe(true);
    expect(searchFacts('forgettable', { actor: 'researcher' }).length).toBe(1);
  });

  test('forgetting a fact outside scope fails closed', async () => {
    const entry = await storeFact({
      actor: 'financial-advisor',
      entity: 'secret.entity',
      value: 'other persona fact',
    }, TEST_CONFIG);

    expect(forgetFact(entry.id, { actor: 'researcher' })).toBe(false);
    expect(searchFacts('other persona', { actor: 'financial-advisor' }).length).toBe(1);
  });

  test('scoreRetention: permanent facts never decay; stale checkpoints score low', () => {
    const now = Math.floor(Date.now() / 1000);
    const permanent = scoreRetention(
      { decay: 'permanent', importance: 0.1, createdAt: now - 10_000_000, lastAccessed: null },
      now,
    );
    expect(permanent.score).toBe(1);

    const staleCheckpoint = scoreRetention(
      { decay: 'checkpoint', importance: 0.1, createdAt: now - 7 * 24 * 3600, lastAccessed: null },
      now,
    );
    expect(staleCheckpoint.score).toBeLessThan(0.1);

    const freshStable = scoreRetention(
      { decay: 'stable', importance: 1.0, createdAt: now - 60, lastAccessed: now - 30 },
      now,
    );
    expect(freshStable.score).toBeGreaterThan(0.5);
  });

  test('sweepDecay honors the canonical vocabulary: forgets stale checkpoints, keeps permanent', async () => {
    runMigrations(TEST_CONFIG);
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 24 * 3600;

    const stale = await storeFact({
      actor: 'researcher', entity: 'scratch.state', value: 'stale checkpoint data', decay: 'checkpoint',
    }, TEST_CONFIG);
    const keep = await storeFact({
      actor: 'researcher', entity: 'core.identity', value: 'permanent core fact', decay: 'permanent',
    }, TEST_CONFIG);

    // Backdate the checkpoint so recency collapses (and let it expire).
    const { getDatabase } = await import('../database.js');
    getDatabase().run(
      'UPDATE facts SET created_at = ?, last_accessed = ?, expires_at = ? WHERE id = ?',
      [weekAgo, weekAgo, weekAgo + 4 * 3600, stale.id],
    );

    const dry = sweepDecay({ actor: 'researcher', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.forgotten.map(f => f.factId)).toContain(stale.id);
    // Dry run forgets nothing.
    expect(getDatabase().query('SELECT COUNT(*) as c FROM fact_forgotten').get()).toEqual({ c: 0 });

    const real = sweepDecay({ actor: 'researcher' });
    expect(real.forgotten.map(f => f.factId)).toContain(stale.id);
    expect(real.forgotten.map(f => f.factId)).not.toContain(keep.id);

    // Permanent fact untouched and still retrievable.
    expect(getFact(keep.id, { actor: 'researcher' })).not.toBeNull();
    // The forgotten fact is reversibly recoverable.
    expect(restoreFact(stale.id, { actor: 'researcher' })).toBe(true);
  });
});
