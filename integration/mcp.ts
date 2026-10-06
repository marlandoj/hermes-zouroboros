#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULT_CONFIG } from 'zouroboros-core';
import { initDatabase, closeDatabase, storeFact, searchFacts, getDbStats } from 'zouroboros-memory';
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
server.tool('memory_store', 'Store a work fact or decision in the shared SQLite memory. Do not store credentials.', {
  entity: z.string().min(1).max(200), key: z.string().max(200).optional(), value: z.string().min(1).max(20000),
}, async input => result(await storeFact({ ...input, category: 'fact', source: 'hermes-zouroboros' }, memoryConfig)));
server.tool('memory_search', 'Find shared work facts by keyword. No remote embedding API is called.', {
  query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(30).default(10),
}, async ({ query, limit }) => result(searchFacts(query, { limit })));
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
