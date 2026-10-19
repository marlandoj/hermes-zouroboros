import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase, getDatabase } from '../database.js';
import { createEpisode, searchEpisodes, getEntityEpisodes } from '../episodes.js';
import { resolveScope, MissingActorError } from '../scope.js';
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

describe('MEM-10: episodes are actor-scoped', () => {
  test('migration 103 adds the persona column', () => {
    const cols = getDatabase().query(`PRAGMA table_info(episodes)`).all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'persona')).toBe(true);
    const applied = getDatabase().query(`SELECT name FROM _migrations`).all() as Array<{ name: string }>;
    expect(applied.some(m => m.name === '103_episodes_persona')).toBe(true);
  });

  test('createEpisode requires an actor and stores under its persona', () => {
    expect(() => (createEpisode as any)({ summary: 's', outcome: 'ongoing', entities: [] }))
      .toThrow(MissingActorError);
    const ep = createEpisode({ actor: 'alice', summary: 'alice episode', outcome: 'success', entities: ['e1'] });
    const row = getDatabase().query(`SELECT persona FROM episodes WHERE id = ?`).get(ep.id) as { persona: string };
    expect(row.persona).toBe('alice');
  });

  test('searchEpisodes honors the actor scope', () => {
    createEpisode({ actor: 'alice', summary: 'alice ep', outcome: 'success', entities: [] });
    createEpisode({ actor: 'bob', summary: 'bob ep', outcome: 'success', entities: [] });
    createEpisode({ actor: 'shared', summary: 'shared ep', outcome: 'success', entities: [] });

    const aliceEps = searchEpisodes({}, resolveScope('alice'));
    expect(aliceEps.length).toBe(2);
    expect(aliceEps.every(e => ['alice ep', 'shared ep'].includes(e.summary))).toBe(true);

    // Legacy unscoped path (operator tooling) still sees everything.
    expect(searchEpisodes({}).length).toBe(3);
  });

  test('getEntityEpisodes honors the actor scope', () => {
    createEpisode({ actor: 'alice', summary: 'a1', outcome: 'success', entities: ['proj'] });
    createEpisode({ actor: 'bob', summary: 'b1', outcome: 'success', entities: ['proj'] });

    const aliceEps = getEntityEpisodes('proj', { scope: resolveScope('alice') });
    expect(aliceEps.length).toBe(1);
    expect(aliceEps[0].summary).toBe('a1');
  });
});
