import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '../database.js';
import { storeFact } from '../facts.js';
import { consolidateObservations, listObservations, getObservation, searchObservations } from '../observations.js';
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

describe('MEM-13: observation grouping uses unambiguous tuple keys', () => {
  test('concatenation-colliding tuples form separate groups', async () => {
    // "ab"+"cd" and "a"+"bcd" collide under naive `${persona}${entity}${key}`.
    await storeFact({ actor: 'ab', entity: 'cd', value: 'belief one' }, TEST_CONFIG);
    await storeFact({ actor: 'a', entity: 'bcd', value: 'belief two' }, TEST_CONFIG);

    const result = await consolidateObservations({ minProof: 1 });

    expect(result.created).toBe(2);
    const all = listObservations();
    expect(all.length).toBe(2);
    expect(all.map(o => o.persona).sort()).toEqual(['a', 'ab']);
  });

  test('same tuple still groups together', async () => {
    await storeFact({ actor: 'zo', entity: 'likes', key: 'coffee', value: 'yes' }, TEST_CONFIG);
    await storeFact({ actor: 'zo', entity: 'likes', key: 'coffee', value: 'strong' }, TEST_CONFIG);

    const result = await consolidateObservations({ minProof: 2 });

    expect(result.created).toBe(1);
    expect(listObservations().length).toBe(1);
  });
});

describe('MEM-02: observation reads are actor-scoped', () => {
  test('list/search/show/consolidate honor the actor scope', async () => {
    const { resolveScope } = await import('../scope.js');
    await storeFact({ actor: 'alice', entity: 'likes', value: 'alice value one' }, TEST_CONFIG);
    await storeFact({ actor: 'alice', entity: 'likes', value: 'alice value two' }, TEST_CONFIG);
    await storeFact({ actor: 'bob', entity: 'likes', value: 'bob value one' }, TEST_CONFIG);
    await storeFact({ actor: 'bob', entity: 'likes', value: 'bob value two' }, TEST_CONFIG);
    await storeFact({ actor: 'shared', entity: 'likes', value: 'shared value one' }, TEST_CONFIG);
    await storeFact({ actor: 'shared', entity: 'likes', value: 'shared value two' }, TEST_CONFIG);

    const aliceScope = resolveScope('alice');
    const res = await consolidateObservations({ scope: aliceScope, minProof: 2 });
    // alice + shared consolidated; bob's facts never entered the run.
    expect(res.created).toBe(2);
    // Bob's own consolidation run creates his observation separately
    // (shared's is refined, not recreated).
    const bobRes = await consolidateObservations({ scope: resolveScope('bob'), minProof: 2 });
    expect(bobRes.created).toBe(1);
    expect(bobRes.refined).toBe(1);

    const listed = listObservations({ scope: aliceScope });
    expect(listed.length).toBe(2);
    expect(listed.map(o => o.persona).sort()).toEqual(['alice', 'shared']);

    const searched = searchObservations('value', { scope: aliceScope });
    expect(searched.length).toBe(2);
    expect(searched.every(o => ['alice', 'shared'].includes(o.persona))).toBe(true);

    // show: an out-of-scope observation does not exist for the caller.
    const bobObs = listObservations({ persona: 'bob' }); // legacy unscoped path (CLI)
    expect(bobObs.length).toBe(1);
    expect(getObservation(bobObs[0].id, aliceScope)).toBeNull();
    const aliceObs = listObservations({ scope: aliceScope, persona: 'alice' });
    expect(getObservation(aliceObs[0].id, aliceScope)).not.toBeNull();
  });

  test('MEM-03: forgetting all supporting facts fades the observation', async () => {
    const { forgetFact } = await import('../facts.js');
    const f1 = await storeFact({ actor: 'zo', entity: 'pref', value: 'likes tea' }, TEST_CONFIG);
    const f2 = await storeFact({ actor: 'zo', entity: 'pref', value: 'likes strong tea' }, TEST_CONFIG);
    const created = await consolidateObservations({ minProof: 2 });
    expect(created.created).toBe(1);
    expect(listObservations()[0].status).toBe('active');

    expect(forgetFact(f1.id, { actor: 'zo' })).toBe(true);
    expect(forgetFact(f2.id, { actor: 'zo' })).toBe(true);

    const reconsolidated = await consolidateObservations({ minProof: 2 });
    // No live facts remain: the observation fades instead of lingering active.
    expect(listObservations()[0].status).toBe('faded');
    expect(reconsolidated.faded).toBe(1);
  });
});
