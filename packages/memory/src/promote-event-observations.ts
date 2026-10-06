#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * promote-event-observations.ts — Sweep hook observations into episodic memory.
 *
 * Batches unpromoted event observations (working tier) into episodes
 * (episodic tier), one per session or time window. Idempotent; safe to run on
 * a timer.
 *
 *   bun src/promote-event-observations.ts [--dry-run] [--grace-minutes N]
 *
 * Env: ZOUROBOROS_MEMORY_DB / ZO_MEMORY_DB override the configured dbPath.
 * Exit 0 always unless the sweep itself crashes.
 */

import { loadConfig } from 'zouroboros-core';
import { promoteObservations, PROMOTION_GRACE_MS } from './event-observations.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const graceIdx = args.indexOf('--grace-minutes');
const graceMs =
  graceIdx >= 0 ? parseInt(args[graceIdx + 1]!, 10) * 60_000 : PROMOTION_GRACE_MS;

const config = loadConfig();
const envDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
const memoryConfig = { ...config.memory, dbPath: envDb || config.memory.dbPath };

if (dryRun) {
  const { Database } = await import('bun:sqlite');
  const db = new Database(memoryConfig.dbPath, { readonly: true });
  const pending = db
    .query(
      `SELECT COUNT(*) AS c FROM event_observations
       WHERE promoted_at IS NULL AND created_at <= ?`
    )
    .get(Math.floor((Date.now() - graceMs) / 1000)) as { c: number };
  console.log(JSON.stringify({ dryRun: true, pending: pending.c, dbPath: memoryConfig.dbPath }));
  process.exit(0);
}

const result = promoteObservations(memoryConfig, { graceMs });
console.log(JSON.stringify({ ...result, dbPath: memoryConfig.dbPath }));
