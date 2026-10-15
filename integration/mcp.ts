#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULT_CONFIG } from 'zouroboros-core';
import { initDatabase, closeDatabase, storeFact, searchFacts, getFact, getDbStats, requireActor } from 'zouroboros-memory';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths, runtimeEnv, settings } from './profile.ts';
import { validateTasks, taskSchema } from './tasks.ts';
import { readBoardSnapshot, isPullable, toTicket } from '../factory/kanban-intake.ts';

// Reserve stdout for MCP frames; library diagnostics belong on stderr.
console.log = console.error;
process.umask(0o077);
Object.assign(process.env, runtimeEnv());
settings();
const p = paths();
const memoryConfig = { ...DEFAULT_CONFIG.memory, dbPath: p.db, vectorEnabled: false, autoCapture: false };
initDatabase(memoryConfig);
const server = new McpServer({ name: 'hermes-zouroboros', version: '0.1.0' });
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

server.tool('workshop_status', 'Inspect local Zouroboros memory and execution mode. Does not invoke a model.', {}, async () => result({
  memory: getDbStats(memoryConfig), swarmExecution: process.env.HERMES_ZOUROBOROS_ALLOW_SWARM === '1',
  factoryConfigured: Boolean(process.env.HERMES_ZOUROBOROS_BOARD_DIR && process.env.HERMES_ZOUROBOROS_MANIFEST),
}));
// Track 1 actor cutover: every memory tool requires a caller identity. The
// schema keeps `actor` optional so pre-cutover clients reach requireActor and
// fail closed with the MISSING_ACTOR code instead of an opaque schema error.
server.tool('memory_store', 'Store a work fact or decision in SQLite memory under the calling actor. Requires a caller identity (actor); calls without one are rejected (MISSING_ACTOR). Do not store credentials.', {
  actor: z.string().max(200).optional().describe('REQUIRED caller identity (persona/seat). Fail-closed: calls without an actor are rejected. Use "shared" only for deliberately cross-persona facts.'),
  entity: z.string().min(1).max(200), key: z.string().max(200).optional(), value: z.string().min(1).max(20000),
}, async ({ actor, ...input }) => result(await storeFact({ actor: requireActor(actor, 'memory_store'), ...input, category: 'fact', source: 'hermes-zouroboros' }, memoryConfig)));
server.tool('memory_search', 'Find work facts by keyword within the calling actor\'s scope (own persona + shared pool), optionally restricted to an exact ID that also matches the query and is unexpired. Requires a caller identity (actor); calls without one are rejected (MISSING_ACTOR). No remote embedding API is called.', {
  actor: z.string().max(200).optional().describe('REQUIRED caller identity (persona/seat). Fail-closed: calls without an actor are rejected. Visibility = own persona + shared pool.'),
  query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(30).default(10),
  id: z.string().min(1).max(200).optional(),
}, async ({ actor, query, limit, id }) => {
  const caller = requireActor(actor, 'memory_search');
  if (id === undefined) return result(searchFacts(query, { actor: caller, limit }));
  // searchFacts filters by ID before its result cap, with the same keyword,
  // scope and expiry semantics. getFact alone intentionally includes expired rows.
  const match = searchFacts(query, { actor: caller, id, limit: 1 }).length > 0;
  const fact = match ? getFact(id, { actor: caller }) : null;
  return result(fact ? [fact] : []);
});
server.tool('swarm_prepare', 'Validate a task DAG and save an operator-reviewable campaign. Does not execute tasks.', {
  tasks: z.array(taskSchema).min(1).max(20),
}, async ({ tasks }) => {
  validateTasks(tasks);
  const directory = join(p.data, 'campaigns');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(tasks, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return result({ taskFile: file, taskCount: tasks.length, execution: 'Review the file, then run the documented opt-in swarm CLI command.' });
});
server.tool('factory_intake', 'Read ready, unclaimed Hermes Kanban tickets from the operator-configured board. Never claims or dispatches.', {}, async () => {
  const boardDir = process.env.HERMES_ZOUROBOROS_BOARD_DIR;
  const manifestPath = process.env.HERMES_ZOUROBOROS_MANIFEST;
  if (!boardDir || !manifestPath) throw new Error('Factory intake requires HERMES_ZOUROBOROS_BOARD_DIR and HERMES_ZOUROBOROS_MANIFEST in MCP environment configuration.');
  return result(readBoardSnapshot({ boardDir, manifestPath }).tasks.filter(isPullable).map(toTicket));
});
const shutdown = async () => { closeDatabase(); await server.close(); process.exit(0); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
await server.connect(new StdioServerTransport());
