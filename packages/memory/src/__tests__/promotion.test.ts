/**
 * Track 1 promotion pipeline tests: capture → extraction → review → promotion
 * state machine, rules-based (no LLM), with the human review queue reserved
 * for contradictions/contested facts only (operator decision Q3).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase, getDatabase } from '../database.js';
import { storeFact, getFact, restoreFact } from '../facts.js';
import {
  getPromotionStage,
  advancePromotion,
  sweepPromotions,
  listReviewQueue,
  resolveReview,
  extractionRules,
  PromotionStateError,
} from '../promotion.js';
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

const ACTOR = 'researcher';

beforeEach(() => {
  initDatabase(TEST_CONFIG);
});

afterEach(() => {
  closeDatabase();
});

describe('stage transitions', () => {
  test('storeFact enters the pipeline at capture', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'runtime', value: 'uses Bun' }, TEST_CONFIG);
    expect(getPromotionStage(entry.id)).toBe('capture');
  });

  test('clean fact: capture → extraction → promotion', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'runtime', value: 'uses Bun' }, TEST_CONFIG);

    const step1 = advancePromotion(entry.id, { actor: ACTOR });
    expect(step1).toMatchObject({ from: 'capture', to: 'extraction' });
    expect(getPromotionStage(entry.id)).toBe('extraction');

    const step2 = advancePromotion(entry.id, { actor: ACTOR });
    expect(step2).toMatchObject({ from: 'extraction', to: 'promotion' });
    expect(getPromotionStage(entry.id)).toBe('promotion');
  });

  test('extraction rules reject noise; the fact stays at capture', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'junk', value: '!!' }, TEST_CONFIG);
    const step = advancePromotion(entry.id, { actor: ACTOR });
    expect(step.to).toBe('capture');
    expect(step.rejectedReason).toBeDefined();
    expect(getPromotionStage(entry.id)).toBe('capture');

    expect(extractionRules({ entity: '', value: 'fine value' }).pass).toBe(false);
    expect(extractionRules({ entity: 'e', value: 'ok' }).pass).toBe(false);
    expect(extractionRules({ entity: 'e', value: 'a real fact' }).pass).toBe(true);
  });

  test('promoted facts are terminal; review facts only move via resolveReview', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'k', value: 'value one' }, TEST_CONFIG);
    advancePromotion(entry.id, { actor: ACTOR });
    advancePromotion(entry.id, { actor: ACTOR });
    expect(() => advancePromotion(entry.id, { actor: ACTOR })).toThrow(PromotionStateError);
  });

  test('advancing an unknown or out-of-scope fact fails closed', async () => {
    expect(() => advancePromotion('no-such-id', { actor: ACTOR })).toThrow(PromotionStateError);

    const other = await storeFact({ actor: 'financial-advisor', entity: 'p', value: 'private fact' }, TEST_CONFIG);
    expect(() => advancePromotion(other.id, { actor: ACTOR })).toThrow(PromotionStateError);
  });

  test('actor is required everywhere', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'e', value: 'some value' }, TEST_CONFIG);
    expect(() => advancePromotion(entry.id, {} as never)).toThrow(MissingActorError);
    expect(() => sweepPromotions({} as never)).toThrow(MissingActorError);
    expect(() => listReviewQueue({} as never)).toThrow(MissingActorError);
    expect(() => resolveReview(entry.id, 'merge', {} as never)).toThrow(MissingActorError);
  });
});

describe('contradiction handling and the review queue', () => {
  async function seedContradiction() {
    const oldFact = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'db', value: 'uses Postgres' }, TEST_CONFIG);
    // Promote the first fact cleanly.
    advancePromotion(oldFact.id, { actor: ACTOR });
    advancePromotion(oldFact.id, { actor: ACTOR });

    const newFact = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'db', value: 'uses SQLite' }, TEST_CONFIG);
    advancePromotion(newFact.id, { actor: ACTOR }); // capture → extraction
    const step = advancePromotion(newFact.id, { actor: ACTOR }); // extraction → review
    return { oldFact, newFact, step };
  }

  test('a contradicting fact routes to review, not promotion', async () => {
    const { oldFact, newFact, step } = await seedContradiction();
    expect(step.to).toBe('review');
    expect(step.contradictionOf).toBe(oldFact.id);
    expect(getPromotionStage(newFact.id)).toBe('review');

    // A pending conflict row exists (fact_conflicts DDL pattern).
    const conflict = getDatabase().query(
      `SELECT resolution FROM fact_conflicts WHERE fact_id = ?`,
    ).get(newFact.id) as { resolution: string };
    expect(conflict.resolution).toBe('pending');
  });

  test('the review queue contains ONLY contradiction cases, scope-filtered', async () => {
    const { oldFact, newFact } = await seedContradiction();
    // A clean fact promoted in the same bank never appears in the queue.
    const clean = await storeFact({ actor: ACTOR, entity: 'proj.y', value: 'independent fact' }, TEST_CONFIG);
    advancePromotion(clean.id, { actor: ACTOR });
    advancePromotion(clean.id, { actor: ACTOR });

    const queue = listReviewQueue({ actor: ACTOR });
    expect(queue.length).toBe(1);
    expect(queue[0].factId).toBe(newFact.id);
    expect(queue[0].contradictionOf).toBe(oldFact.id);
    expect(queue[0].contradictingValue).toBe('uses Postgres');

    // Another actor sees an empty queue (scope isolation).
    expect(listReviewQueue({ actor: 'financial-advisor' }).length).toBe(0);
  });

  test('supersede: new fact promotes, contradicted fact is reversibly forgotten', async () => {
    const { oldFact, newFact } = await seedContradiction();
    const resolution = resolveReview(newFact.id, 'supersede', { actor: ACTOR });
    expect(resolution.stage).toBe('promotion');
    expect(resolution.forgottenFactId).toBe(oldFact.id);
    expect(getPromotionStage(newFact.id)).toBe('promotion');

    // The superseded fact is hidden from retrieval but recoverable.
    expect(getFact(oldFact.id, { actor: ACTOR })).toBeNull();
    expect(restoreFact(oldFact.id, { actor: ACTOR })).toBe(true);

    const conflict = getDatabase().query(
      `SELECT resolution FROM fact_conflicts WHERE fact_id = ?`,
    ).get(newFact.id) as { resolution: string };
    expect(conflict.resolution).toBe('superseded');
  });

  test('merge: both facts stand, new fact promotes', async () => {
    const { oldFact, newFact } = await seedContradiction();
    const resolution = resolveReview(newFact.id, 'merge', { actor: ACTOR });
    expect(resolution.stage).toBe('promotion');
    expect(resolution.forgottenFactId).toBeUndefined();
    expect(getFact(oldFact.id, { actor: ACTOR })).not.toBeNull();
    expect(getFact(newFact.id, { actor: ACTOR })).not.toBeNull();
  });

  test('flag: fact stays contested in review', async () => {
    const { newFact } = await seedContradiction();
    const resolution = resolveReview(newFact.id, 'flag', { actor: ACTOR });
    expect(resolution.stage).toBe('review');
    expect(getPromotionStage(newFact.id)).toBe('review');

    const queue = listReviewQueue({ actor: ACTOR });
    expect(queue.length).toBe(1);
    expect(queue[0].contested).toBe(true);
  });

  test('resolveReview on a non-review fact fails closed', async () => {
    const entry = await storeFact({ actor: ACTOR, entity: 'e2', value: 'plain fact' }, TEST_CONFIG);
    expect(() => resolveReview(entry.id, 'merge', { actor: ACTOR })).toThrow(PromotionStateError);
  });
});

describe('sweepPromotions (batch, idempotent)', () => {
  test('one sweep takes clean facts to promotion and routes contradictions to review', async () => {
    const promotedOld = await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'db', value: 'uses Postgres' }, TEST_CONFIG);
    advancePromotion(promotedOld.id, { actor: ACTOR });
    advancePromotion(promotedOld.id, { actor: ACTOR });

    await storeFact({ actor: ACTOR, entity: 'proj.x', key: 'db', value: 'uses SQLite' }, TEST_CONFIG);
    await storeFact({ actor: ACTOR, entity: 'proj.y', value: 'a clean independent fact' }, TEST_CONFIG);
    await storeFact({ actor: ACTOR, entity: 'junk', value: '!!' }, TEST_CONFIG);

    const dry = sweepPromotions({ actor: ACTOR, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.examined).toBe(3);
    expect(dry.promoted).toBe(0);

    const sweep = sweepPromotions({ actor: ACTOR });
    expect(sweep.promoted).toBe(1);        // proj.y
    expect(sweep.sentToReview).toBe(1);    // the SQLite contradiction
    expect(sweep.rejected.length).toBe(1); // the noise fact

    // Idempotent: a second sweep finds only the rejected capture-stage fact.
    const again = sweepPromotions({ actor: ACTOR });
    expect(again.promoted).toBe(0);
    expect(again.sentToReview).toBe(0);
    expect(again.rejected.length).toBe(1);
  });
});
