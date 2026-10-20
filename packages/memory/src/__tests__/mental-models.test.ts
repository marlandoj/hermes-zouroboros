import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '../database.js';
import {
  defineMentalModel,
  readMentalModel,
  listMentalModels,
  refreshMentalModel,
  refreshDueMentalModels,
} from '../mental-models.js';
import { resolveScope } from '../scope.js';
import type { MemoryConfig } from 'zouroboros-core';

// Refresh falls back to a deterministic digest when no model key is present;
// make sure the test never reaches for a real provider.
for (const key of ['OPENAI_API_KEY', 'ZO_OPENAI_API_KEY']) delete process.env[key];

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

describe('MEM-02: mental models are actor-scoped', () => {
  test('list honors the actor scope', () => {
    defineMentalModel({ persona: 'alice', question: 'q-alice' });
    defineMentalModel({ persona: 'bob', question: 'q-bob' });
    defineMentalModel({ persona: 'shared', question: 'q-shared' });

    const listed = listMentalModels({ scope: resolveScope('alice') });
    expect(listed.map(m => m.persona).sort()).toEqual(['alice', 'shared']);

    // Legacy unscoped path (operator CLI) still sees everything.
    expect(listMentalModels().length).toBe(3);
  });

  test('read resolves within the actor scope', () => {
    defineMentalModel({ persona: 'bob', question: 'q-secret' });
    // Bob's model is invisible to alice even by exact question.
    expect(readMentalModel('alice', 'q-secret')).toBeNull();
    defineMentalModel({ persona: 'shared', question: 'q-open' });
    const model = readMentalModel('alice', 'q-open');
    expect(model?.persona).toBe('shared');
  });

  test('refresh outside the scope fails; inside succeeds', async () => {
    const alice = defineMentalModel({ persona: 'alice', question: 'q-a' });
    const bob = defineMentalModel({ persona: 'bob', question: 'q-b' });

    await expect(refreshMentalModel(bob.id, resolveScope('alice'))).rejects.toThrow(/outside.*scope/);

    const refreshed = await refreshMentalModel(alice.id, resolveScope('alice'));
    expect(refreshed.id).toBe(alice.id);
    // No provider key in this test: the fail-safe deterministic fallback ran.
    expect(refreshed.answer).toContain('No memory facts available yet');
    expect(refreshed.model).toBe('deterministic-fallback');
  });

  test('refresh_due only touches in-scope models', async () => {
    defineMentalModel({ persona: 'alice', question: 'q-a' });
    defineMentalModel({ persona: 'bob', question: 'q-b' });
    defineMentalModel({ persona: 'shared', question: 'q-s' });

    const due = await refreshDueMentalModels(resolveScope('alice'));
    // bob's due model is out of scope and left alone.
    expect(due.refreshed).toBe(2);
    const bobAfter = listMentalModels({ persona: 'bob' })[0];
    expect(bobAfter.refreshedAt).toBeNull();
  });

  test('refresh never uses forgotten facts as evidence', async () => {
    const { storeFact, forgetFact } = await import('../facts.js');
    const fact = await storeFact(
      { actor: 'alice', entity: 'secret', value: 'the forgotten launch code is 12345' },
      TEST_CONFIG,
    );
    const model = defineMentalModel({ persona: 'alice', question: 'q-evidence' });
    expect(forgetFact(fact.id, { actor: 'alice' })).toBe(true);

    const refreshed = await refreshMentalModel(model.id, resolveScope('alice'));
    // The deterministic fallback digests live evidence only.
    expect(refreshed.answer).not.toContain('12345');
    expect(refreshed.answer).toContain('No memory facts available yet');
  });

  test('missing actor resolves to the shared scope', () => {
    expect(resolveScope('').actor).toBe('shared');
    expect(resolveScope('   ').personas).toEqual(['shared']);
  });
});
