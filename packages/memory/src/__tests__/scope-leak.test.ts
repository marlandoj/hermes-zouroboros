/**
 * Track 1 regression tests: the definer-rights scope-leak class.
 *
 * Before Track 1, searchFactsGraphBoosted's entity fetch had NO persona
 * filter: any actor could pull another persona's facts through the graph
 * arm. These tests pin the fix — cross-actor facts must not leak through
 * any graph-arm surface — and the fail-closed actor requirement at the MCP
 * boundary.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase, getDatabase } from '../database.js';
import { storeFact } from '../facts.js';
import {
  searchFactsGraphBoosted,
  extractQueryEntities,
  buildEntityGraph,
  invalidateGraphCache,
} from '../graph.js';
import { routeMemoryQuery } from '../routing-gate.js';
import { resolveScope, MissingActorError } from '../scope.js';
import { handleMessage } from '../mcp-server.js';
import type { MemoryConfig } from 'zouroboros-core';

const TEST_CONFIG: MemoryConfig = {
  enabled: true,
  dbPath: ':memory:',
  vectorEnabled: false,
  autoCapture: false,
  captureIntervalMinutes: 30,
  graphBoost: true,
  hydeExpansion: false,
  decayConfig: { permanent: Infinity, stable: 90, active: 14, session: 1, checkpoint: 4 / 24 },
};

beforeEach(() => {
  initDatabase(TEST_CONFIG);
  invalidateGraphCache();
});

afterEach(() => {
  closeDatabase();
});

/**
 * Seed the pre-Track-1 leak shape: a private fact owned by another persona
 * whose entity is linked (via episode co-occurrence) to an entity the
 * attacker legitimately queries.
 */
async function seedCrossActorBank() {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // The victim's private fact.
  await storeFact({
    actor: 'financial-advisor',
    entity: 'acme-portfolio',
    value: 'holds 40% NVDA — confidential allocation',
  }, TEST_CONFIG);

  // A fact the attacker CAN see (shared pool), entity-linked to the private one.
  await storeFact({
    actor: 'shared',
    entity: 'market-report',
    value: 'weekly market report covers tech sector',
  }, TEST_CONFIG);

  // Episode linking the two entities — this is the bridge the old code
  // walked straight across.
  db.run("INSERT INTO episodes (id, summary, outcome, happened_at) VALUES ('ep-leak', 'Reviewed acme portfolio against market report', 'resolved', ?)", [now]);
  db.run("INSERT INTO episode_entities (episode_id, entity) VALUES ('ep-leak', 'acme-portfolio')");
  db.run("INSERT INTO episode_entities (episode_id, entity) VALUES ('ep-leak', 'market-report')");
  invalidateGraphCache();
}

describe('graph-arm scope leak (regression)', () => {
  test('searchFactsGraphBoosted does not return cross-actor facts', async () => {
    await seedCrossActorBank();
    const attacker = resolveScope('researcher');

    // The graph walk from market-report reaches acme-portfolio; the fact
    // fetch must still refuse to surface the other persona's fact.
    const results = searchFactsGraphBoosted([], ['market-report'], attacker, { limit: 10 });
    const values = results.map(r => r.entry.value).join(' | ');
    expect(values).not.toContain('confidential allocation');

    // The owner still gets their own fact through the same arm.
    const owner = resolveScope('financial-advisor');
    const ownResults = searchFactsGraphBoosted([], ['market-report'], owner, { limit: 10 });
    expect(ownResults.map(r => r.entry.value).join(' | ')).toContain('confidential allocation');
  });

  test('extractQueryEntities does not reveal other personas entities', async () => {
    await seedCrossActorBank();
    const attacker = resolveScope('researcher');

    // 'acme-portfolio' exists only as another persona's fact entity.
    const entities = extractQueryEntities('tell me about acme-portfolio holdings', attacker);
    expect(entities).not.toContain('acme-portfolio');

    const owner = resolveScope('financial-advisor');
    const ownerEntities = extractQueryEntities('tell me about acme-portfolio holdings', owner);
    expect(ownerEntities).toContain('acme-portfolio');
  });

  test('buildEntityGraph fact nodes are scope-filtered (per-scope cache)', async () => {
    await seedCrossActorBank();

    const attackerGraph = buildEntityGraph(resolveScope('researcher'));
    const ownerGraph = buildEntityGraph(resolveScope('financial-advisor'));

    // Episode-derived nodes are shared substrate, but neither actor's
    // fact-only entities may appear in the other's graph. Store a fact whose
    // entity appears in NO episode to isolate the fact-node path:
    await storeFact({ actor: 'financial-advisor', entity: 'private-ledger', value: 'ledger detail' }, TEST_CONFIG);
    invalidateGraphCache();

    const attackerGraph2 = buildEntityGraph(resolveScope('researcher'));
    expect(attackerGraph2.nodes.map(n => n.id)).not.toContain('private-ledger');
    const ownerGraph2 = buildEntityGraph(resolveScope('financial-advisor'));
    expect(ownerGraph2.nodes.map(n => n.id)).toContain('private-ledger');

    // Sanity: the two scopes got distinct cached graphs, not one shared one.
    expect(attackerGraph).not.toBe(ownerGraph);
  });

  test('routeMemoryQuery (production default path) does not leak through the graph boost', async () => {
    await seedCrossActorBank();

    const results = await routeMemoryQuery('market-report', TEST_CONFIG, { actor: 'researcher', limit: 10 });
    const values = results.map(r => r.entry.value).join(' | ');
    expect(values).toContain('weekly market report');
    expect(values).not.toContain('confidential allocation');
  });
});

describe('fail-closed actor at the MCP boundary', () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    return (await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      TEST_CONFIG,
    )) as { result?: { content?: Array<{ text: string }> }; error?: { message: string } };
  }

  test('memory_store without actor fails closed with MISSING_ACTOR semantics', async () => {
    const res = await callTool('memory_store', { entity: 'x', value: 'y' });
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('actor is required');
    // Nothing was written.
    const count = getDatabase().query('SELECT COUNT(*) as c FROM facts').get() as { c: number };
    expect(count.c).toBe(0);
  });

  test('memory_search without actor fails closed', async () => {
    const res = await callTool('memory_search', { query: 'anything' });
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('actor is required');
  });

  test('memory_search with actor returns scope metadata and scoped results', async () => {
    await storeFact({ actor: 'researcher', entity: 'n1', value: 'researcher note' }, TEST_CONFIG);
    await storeFact({ actor: 'financial-advisor', entity: 'n2', value: 'advisor note' }, TEST_CONFIG);

    const res = await callTool('memory_search', { actor: 'researcher', query: 'note', mode: 'keyword' });
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.result!.content![0].text) as {
      results: Array<{ value: string }>;
      scope: { actor: string; personas: string[] };
    };
    expect(payload.scope).toEqual({ actor: 'researcher', personas: ['researcher', 'shared'] });
    expect(payload.results.map(r => r.value)).toContain('researcher note');
    expect(payload.results.map(r => r.value)).not.toContain('advisor note');
  });

  test('memory_graph and memory_delete without actor fail closed', async () => {
    const g = await callTool('memory_graph', { action: 'build' });
    expect(g.error?.message).toContain('actor is required');

    const entry = await storeFact({ actor: 'researcher', entity: 'd', value: 'v' }, TEST_CONFIG);
    const d = await callTool('memory_delete', { id: entry.id });
    expect(d.error?.message).toContain('actor is required');
  });

  test('requireActor rejects non-string actors', () => {
    expect(() => resolveScope(42 as never)).toThrow(MissingActorError);
    expect(() => resolveScope(null as never)).toThrow(MissingActorError);
  });
});
