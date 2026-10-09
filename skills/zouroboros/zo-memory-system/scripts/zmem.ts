#!/usr/bin/env bun
// Zouroboros memory for Hermes: facts and episodes in the distribution's portable SQLite store.
// The database is always the profile's memory.db (the same file the `zouroboros` MCP server
// uses). ZO_MEMORY_DB / ZOUROBOROS_MEMORY_DB from the caller's environment are ignored so a
// session can never write to another host's memory database by inheritance.
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG } from 'zouroboros-core';
import {
  closeDatabase, createEpisode, getDbStats, getEpisodeStats, initDatabase, searchEpisodes, searchFacts, storeFact,
} from 'zouroboros-memory';
import { paths, repoRoot, settings } from '../../../../integration/profile.ts';

const DECAY = ['permanent', 'long', 'medium', 'short'] as const;
const CATEGORY = ['preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project'] as const;
const OUTCOME = ['success', 'failure', 'resolved', 'ongoing'] as const;
type Decay = typeof DECAY[number];
type Category = typeof CATEGORY[number];
type Outcome = typeof OUTCOME[number];
// Captured before library diagnostics are redirected to stderr in CLI mode.
const out = console.log.bind(console);

const usage = `zmem — Zouroboros memory (portable profile store)
  store --entity E [--key K] --value V [--category C] [--decay D]
  search <query> [--limit N]
  episode --summary S --outcome success|failure|resolved|ongoing [--entities a,b] [--duration-ms N]
  episodes [--since 7d|ISO] [--until ISO] [--outcome O] [--limit N]
  stats
  where            print the database path in use`;

function choice<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function limitOf(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--limit must be an integer from 1 to 100');
  return n;
}

/** Accepts ISO dates or a relative window such as 30m, 24h, 7d or 4w. */
export function timeArg(value: string | undefined, now = Date.now()): string | undefined {
  if (value === undefined) return undefined;
  const relative = /^(\d{1,4})([mhdw])$/.exec(value.trim());
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2] as 'm' | 'h' | 'd' | 'w'];
    return new Date(now - Number(relative[1]) * unit).toISOString();
  }
  if (Number.isNaN(new Date(value).getTime())) throw new Error('--since/--until take an ISO date or a window like 7d');
  return value;
}

/** The profile database; requires `bun integration/cli.ts init` to have run. */
export function memoryDbPath(): string {
  if (!existsSync(join(repoRoot, 'integration/profile.ts'))) throw new Error('Run from a hermes-zouroboros checkout.');
  settings();
  return paths().db;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { out(usage); return command ? 0 : 2; }
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      entity: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' },
      category: { type: 'string' }, decay: { type: 'string' }, limit: { type: 'string' },
      summary: { type: 'string' }, outcome: { type: 'string' }, entities: { type: 'string' },
      'duration-ms': { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
    },
  });
  const dbPath = memoryDbPath();
  if (command === 'where') { out(dbPath); return 0; }
  const config = { ...DEFAULT_CONFIG.memory, dbPath, vectorEnabled: false, autoCapture: false };
  initDatabase(config);
  try {
    switch (command) {
      case 'store': {
        if (!values.entity || !values.value) throw new Error('store requires --entity and --value');
        const entry = await storeFact({
          entity: values.entity, key: values.key, value: values.value, source: 'hermes-zouroboros:zo-memory-system',
          category: choice<Category>(values.category, CATEGORY, 'category') ?? 'fact',
          decay: choice<Decay>(values.decay, DECAY, 'decay'),
        }, config);
        out(JSON.stringify({ id: entry.id, entity: entry.entity, key: entry.key, value: entry.value, decay: entry.decay }));
        return 0;
      }
      case 'search': {
        const query = positionals.join(' ').trim();
        if (!query) throw new Error('search requires a query');
        out(JSON.stringify(searchFacts(query, { limit: limitOf(values.limit, 10) }).map(({ id, entity, key, value, decay }) => ({ id, entity, key, value, decay }))));
        return 0;
      }
      case 'episode': {
        const outcome = choice<Outcome>(values.outcome, OUTCOME, 'outcome');
        if (!values.summary || !outcome) throw new Error('episode requires --summary and --outcome');
        const duration = values['duration-ms'] === undefined ? undefined : Number(values['duration-ms']);
        if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) throw new Error('--duration-ms must be a non-negative number');
        const entities = (values.entities ?? '').split(',').map((e) => e.trim()).filter(Boolean);
        const episode = createEpisode({ summary: values.summary, outcome, entities, durationMs: duration });
        out(JSON.stringify({ id: episode.id, outcome: episode.outcome, entities }));
        return 0;
      }
      case 'episodes': {
        const found = searchEpisodes({ since: timeArg(values.since), until: timeArg(values.until), outcome: choice<Outcome>(values.outcome, OUTCOME, 'outcome'), limit: limitOf(values.limit, 20) });
        out(JSON.stringify(found.map(({ id, summary, outcome, entities, createdAt }) => ({ id, summary, outcome, entities, createdAt }))));
        return 0;
      }
      case 'stats':
        out(JSON.stringify({ database: getDbStats(config), episodes: getEpisodeStats() }));
        return 0;
      default:
        console.error(usage);
        return 2;
    }
  } finally {
    closeDatabase();
  }
}

if (import.meta.main) {
  // Keep stdout machine-readable: library diagnostics go to stderr.
  console.log = console.error;
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : 'zmem failed');
    process.exitCode = 1;
  });
}
