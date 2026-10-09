#!/usr/bin/env bun
/** Real MCP handshake and shared-memory reconnect check; no provider calls. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';

const expected = ['factory_intake', 'memory_search', 'memory_store', 'swarm_prepare', 'workshop_status'];
const configPath = process.argv[2];
const checkOnly = process.argv[3] === '--check';
const config = parse(await Bun.file(configPath).text());
const server = config.mcp_servers?.zouroboros;
const mapping = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
if (!mapping(server) || !mapping(server.env) || !mapping(server.sampling)
    || server.enabled !== true || server.sampling.enabled !== false
    || server.timeout !== 120 || server.connect_timeout !== 30) throw new Error('Unsafe or absent Zouroboros configuration');
if (Object.values(server.env).some(value => typeof value !== 'string')) throw new Error('Invalid MCP environment');
if (server.tools !== undefined) {
  if (!mapping(server.tools)) throw new Error('Invalid MCP tools mapping');
  for (const key of ['include', 'exclude']) {
    const values = server.tools[key];
    if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string'))) throw new Error('Invalid MCP tool filter');
  }
  if ((server.tools.include && JSON.stringify([...new Set(server.tools.include)].sort()) !== JSON.stringify(expected)) || server.tools.exclude?.length) throw new Error('Unexpected MCP tool filters');
}
if (typeof server.command !== 'string' || realpathSync(server.command) !== realpathSync(process.execPath)
    || JSON.stringify(server.args) !== JSON.stringify([resolve(import.meta.dir, '../integration/mcp.ts')])) throw new Error('Changed MCP command/source; refusing to spawn it');
if (server.env?.HERMES_ZOUROBOROS_ALLOW_SWARM !== '0') throw new Error('Workers must be disabled');
const dataHome = server.env.HERMES_ZOUROBOROS_HOME;
if (typeof dataHome !== 'string' || !isAbsolute(dataHome) || resolve(dataHome) !== dataHome
    || (process.env.HERMES_ZOUROBOROS_HOME && process.env.HERMES_ZOUROBOROS_HOME !== dataHome)) throw new Error('Invalid MCP state path');
function checkState() {
  let directory = dataHome;
  while (true) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || (info.mode & 0o022) !== 0
        || (info.uid !== process.getuid!() && !(directory !== dataHome && info.uid === 0))) throw new Error('Unsafe workshop state directory hierarchy');
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  for (const relative of ['hermes', 'tools', 'state', 'config', 'cache', 'logs', 'campaigns']) {
    const info = lstatSync(join(dataHome, relative), { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o022) !== 0)) throw new Error('Unsafe workshop state directory');
  }
  for (const relative of ['settings.json', 'executors.json', 'hermes/config.yaml', 'memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db-journal']) {
    const info = lstatSync(join(dataHome, relative), { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.uid !== process.getuid!() || info.nlink !== 1 || (info.mode & 0o022) !== 0
        || (relative.startsWith('memory.db') && (info.mode & 0o777) !== 0o600))) throw new Error('Unsafe workshop state file or SQLite sidecar');
  }
}
checkState();
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && (['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'].includes(key) || key.startsWith('XDG_'))) env[key] = value;
}
// No provider credentials are required by this server. Preserve only its state
// paths and optional read-only factory paths, never the parent process's secrets.
for (const key of ['HERMES_ZOUROBOROS_HOME', 'HERMES_ZOUROBOROS_ALLOW_SWARM', 'HERMES_ZOUROBOROS_BOARD_DIR', 'HERMES_ZOUROBOROS_MANIFEST']) {
  if (typeof server.env?.[key] === 'string') env[key] = server.env[key];
}
async function connect() {
  checkState();
  const client = new Client({ name: 'hermes-zouroboros-installer', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'pipe' });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw error; }
  return client;
}
function unpack(result: any) {
  if (result.isError) throw new Error('MCP tool returned an error');
  return JSON.parse(result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n'));
}
const marker = { entity: 'hermes-zouroboros-installation', key: 'mcp-connection', value: 'hermes-zouroboros-installer-v1: shared MCP memory verified' };
const dbPath = join(dataHome, 'memory.db');
// Receipt lookup must include expired rows. Never broaden this installer-owned
// identity to other work facts or change memory_store's ordinary retention.
const receiptWhere = 'entity = ? AND key = ? AND value = ? AND source = ? AND persona = ? AND category = ?';
const receiptIdentity = [marker.entity, marker.key, marker.value, 'hermes-zouroboros', 'shared', 'fact'];
function existingReceipts() {
  checkState();
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(`SELECT id FROM facts WHERE ${receiptWhere} ORDER BY created_at ASC, id ASC`).all(...receiptIdentity) as { id: string }[];
  } finally { db.close(); }
}
function makeReceiptPermanent(id: string) {
  checkState();
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.transaction(() => {
      const changed = db.query(`UPDATE facts SET decay_class = ?, expires_at = NULL
        WHERE id = ? AND ${receiptWhere} AND (decay_class != ? OR expires_at IS NOT NULL)`)
        .run('permanent', id, ...receiptIdentity, 'permanent');
      if (changed.changes > 1) throw new Error('Installation receipt update affected multiple records');
      const row = db.query(`SELECT decay_class, expires_at FROM facts WHERE id = ? AND ${receiptWhere}`)
        .get(id, ...receiptIdentity) as { decay_class: string; expires_at: number | null } | null;
      if (row?.decay_class !== 'permanent' || row.expires_at !== null) throw new Error('Installation receipt lifecycle readback failed');
    })();
  } finally { db.close(); }
}
let receipt: { id: string; matchingRecords: number; decay: 'permanent' } | null = null;
let client = await connect();
let status: any;
try {
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Expected exactly five Zouroboros tools');
  status = unpack(await client.callTool({ name: 'workshop_status', arguments: {} }));
  if (status.swarmExecution !== false) throw new Error('Worker execution unexpectedly enabled');
  if (!checkOnly) {
    const existing = existingReceipts();
    let id = existing[0]?.id;
    if (!id) {
      const saved = unpack(await client.callTool({ name: 'memory_store', arguments: marker }));
      if (typeof saved.id !== 'string' || saved.entity !== marker.entity || saved.key !== marker.key || saved.value !== marker.value) throw new Error('Unexpected installation receipt store result');
      id = saved.id;
      const stored = unpack(await client.callTool({ name: 'memory_search', arguments: { query: marker.value, id, limit: 1 } }));
      if (stored.length !== 1 || stored[0].id !== id || stored[0].entity !== marker.entity || stored[0].key !== marker.key || stored[0].value !== marker.value) throw new Error('Installation receipt MCP readback failed');
    }
    receipt = { id, matchingRecords: existing.length || 1, decay: 'permanent' };
    // Recover expired receipts locally before the unexpired-only MCP lookup.
    // Prove this selected ID on the current connection as well as after reconnect.
    makeReceiptPermanent(id);
    const selected = unpack(await client.callTool({ name: 'memory_search', arguments: { query: marker.value, id, limit: 1 } }));
    if (selected.length !== 1 || selected[0].id !== id || selected[0].entity !== marker.entity || selected[0].key !== marker.key || selected[0].value !== marker.value || selected[0].decay !== 'permanent') throw new Error('Selected installation receipt MCP readback failed');
  }
} finally { await client.close(); }
if (!checkOnly) {
  // Prove selected-ID retrieval after reconnect, independently of keyword ranking.
  client = await connect();
  try {
    const found = unpack(await client.callTool({ name: 'memory_search', arguments: { query: marker.value, id: receipt!.id, limit: 1 } }));
    if (found.length !== 1 || found[0].id !== receipt!.id || found[0].entity !== marker.entity || found[0].key !== marker.key || found[0].value !== marker.value || found[0].decay !== 'permanent') throw new Error('Saved installation fact did not survive reconnection');
    status = unpack(await client.callTool({ name: 'workshop_status', arguments: {} }));
  } finally { await client.close(); }
}
checkState();
const db = lstatSync(dbPath);
if (!db.isFile() || (db.mode & 0o777) !== 0o600 || db.uid !== process.getuid!()) throw new Error('Shared database must be a user-owned regular file with mode 0600');
console.log(JSON.stringify({ toolCount: expected.length, tools: expected, memoryRoundTrip: checkOnly ? null : true, installerReceipt: receipt, status, dbPath, dbMode: '0600', checkOnly, startupFilesystemWritesPossible: true }));
