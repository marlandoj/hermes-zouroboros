#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * event-observations-cli.ts — Hook observation capture stats and manual promotion.
 *
 *   bun event-observations-cli.ts [stats] [--grace-minutes N]   (default)
 *   bun event-observations-cli.ts promote [--dry-run] [--grace-minutes N]
 *
 * Shows what the wired harnesses (Claude Code / Codex / Gemini / pi / OpenCode)
 * have fed into /observe, and lets an operator run the working-tier ->
 * episodic-tier sweep on demand instead of waiting for the scheduled sweep.
 */
import { loadConfig } from 'zouroboros-core';
import { init } from './index.js';
import { runMigrations } from './database.js';
import { getObservationStats, promoteObservations, PROMOTION_GRACE_MS } from './event-observations.js';

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'stats';
const dryRun = args.includes('--dry-run');
const graceIdx = args.indexOf('--grace-minutes');
const graceMs =
  graceIdx >= 0 ? parseInt(args[graceIdx + 1]!, 10) * 60_000 : PROMOTION_GRACE_MS;

function usage(): never {
  console.log(`
zouroboros-memory event observations — hook capture stats and promotion

USAGE:
  event-observations [stats] [--grace-minutes N]    Capture/promotion statistics (default)
  event-observations promote [--dry-run]            Run the working -> episodic sweep now

OPTIONS:
  --grace-minutes N   Promotion grace period (default: ${PROMOTION_GRACE_MS / 60_000})
  --dry-run           Report what would promote without writing
`);
  process.exit(sub === 'help' || sub === '--help' ? 0 : 1);
}

if (sub === 'help' || sub === '--help' || sub === '-h') usage();

const config = loadConfig();
const memoryConfig = { ...config.memory };
const envDb = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB;
if (envDb) memoryConfig.dbPath = envDb;

runMigrations(memoryConfig);
init(memoryConfig);

if (sub === 'promote') {
  if (dryRun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(memoryConfig.dbPath, { readonly: true });
    const cutoff = Math.floor((Date.now() - graceMs) / 1000);
    const pending = db
      .query('SELECT COUNT(*) AS c FROM event_observations WHERE promoted_at IS NULL AND created_at <= ?')
      .get(cutoff) as { c: number };
    const sessions = db
      .query('SELECT COUNT(DISTINCT session_id) AS c FROM event_observations WHERE promoted_at IS NULL AND created_at <= ? AND session_id IS NOT NULL')
      .get(cutoff) as { c: number };
    console.log(
      `Dry run: ${pending.c} observation(s) across ${sessions.c} session(s) would promote (grace ${graceMs / 60_000}m).`,
    );
    process.exit(0);
  }
  const result = promoteObservations(memoryConfig, { graceMs });
  console.log(
    `Promoted ${result.observationsPromoted} observation(s) into ${result.episodesCreated} episode(s) across ${result.groups} group(s).`,
  );
  process.exit(0);
}

if (sub !== 'stats') usage();

const db = (await import('./database.js')).getDatabase();
const stats = getObservationStats(memoryConfig);
const cutoff24h = Math.floor(Date.now() / 1000) - 24 * 3600;
const cutoffGrace = Math.floor((Date.now() - graceMs) / 1000);

const promoted = (
  db.query('SELECT COUNT(*) AS c FROM event_observations WHERE promoted_at IS NOT NULL').get() as { c: number }
).c;
const pendingGrace = (
  db
    .query('SELECT COUNT(*) AS c FROM event_observations WHERE promoted_at IS NULL AND created_at <= ?')
    .get(cutoffGrace) as { c: number }
).c;
const pendingFresh = stats.observations - promoted - pendingGrace;
const last24h = (
  db.query('SELECT COUNT(*) AS c FROM event_observations WHERE created_at >= ?').get(cutoff24h) as {
    c: number;
  }
).c;
const sessionsTotal = (
  db.query('SELECT COUNT(DISTINCT session_id) AS c FROM event_observations WHERE session_id IS NOT NULL').get() as {
    c: number;
  }
).c;

console.log('Event observation capture (hook pipeline)');
console.log(`  total observations : ${stats.observations}`);
console.log(`  last 24h           : ${last24h}`);
console.log(`  distinct sessions  : ${sessionsTotal}`);
console.log(`  redacted on ingest : ${stats.redacted}`);
console.log(`  promoted -> episodes: ${promoted}`);
console.log(`  pending (eligible) : ${pendingGrace}`);
console.log(`  pending (in grace) : ${pendingFresh}`);

const bySource = db
  .query(
    `SELECT source, COUNT(*) AS c,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS c24
     FROM event_observations GROUP BY source ORDER BY c DESC LIMIT 8`,
  )
  .all(cutoff24h) as { source: string; c: number; c24: number }[];
if (bySource.length > 0) {
  console.log('\nBy source (all-time / 24h):');
  for (const r of bySource) console.log(`  ${r.source.padEnd(28)} ${String(r.c).padStart(6)} / ${r.c24}`);
}

const byTool = db
  .query(
    `SELECT tool, COUNT(*) AS c FROM event_observations
     WHERE tool IS NOT NULL GROUP BY tool ORDER BY c DESC LIMIT 8`,
  )
  .all() as { tool: string; c: number }[];
if (byTool.length > 0) {
  console.log('\nTop tools:');
  for (const r of byTool) console.log(`  ${r.tool.padEnd(28)} ${String(r.c).padStart(6)}`);
}
