import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../integration/profile.ts';

test('Hermes-compatible MCP completes handshake, memory round trip and reviewable campaign', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-'));
  const data = join(root, 'data'); const workspace = join(root, 'work'); mkdirSync(workspace);
  const env = { PATH: process.env.PATH!, HERMES_ZOUROBOROS_HOME: data };
  const setup = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), 'init', '--workspace', workspace], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(setup.exitCode).toBe(0);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'integration/mcp.ts')], env, stderr: 'pipe' });
  const client = new Client({ name: 'hermes-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['factory_intake', 'memory_search', 'memory_store', 'swarm_prepare', 'workshop_status']);
    const stored = await client.callTool({ name: 'memory_store', arguments: { entity: 'fixture', key: 'decision', value: 'Use copper widgets' } });
    expect(stored.isError).not.toBe(true);
    const found = await client.callTool({ name: 'memory_search', arguments: { query: 'copper' } });
    expect(JSON.stringify(found)).toContain('Use copper widgets');
    const status = await client.callTool({ name: 'workshop_status', arguments: {} });
    expect(JSON.stringify(status)).toContain('swarmExecution');
    const prepared = await client.callTool({ name: 'swarm_prepare', arguments: { tasks: [{ id: 'a', task: 'Review widgets' }] } });
    const text = (prepared.content as { text: string }[])[0]!.text;
    const file = JSON.parse(text).taskFile;
    expect(file.startsWith(join(data, 'campaigns'))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].task).toBe('Review widgets');
    const factory = await client.callTool({ name: 'factory_intake', arguments: {} });
    expect(factory.isError).toBe(true);
    const denied = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), 'swarm', file], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr.toString()).toContain('opt-in');
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 20000);

// Real stdio MCP in disposable state; no credentials, sampling or workers.
async function withMemory(run: (client: Client, dbPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-id-'));
  const data = join(root, 'data'); const workspace = join(root, 'work'); mkdirSync(workspace);
  const env = { PATH: process.env.PATH!, HOME: root, TMPDIR: root,
    HERMES_ZOUROBOROS_HOME: data, HERMES_ZOUROBOROS_ALLOW_SWARM: '0' };
  const client = new Client({ name: 'exact-id-fixture', version: '1' });
  try {
    const setup = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), 'init', '--workspace', workspace], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(setup.exitCode).toBe(0);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'integration/mcp.ts')], env, stderr: 'pipe' }));
    await run(client, join(data, 'memory.db'));
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}
function unpack(value: any) {
  expect(value.isError).not.toBe(true);
  return JSON.parse(value.content[0].text);
}
async function store(client: Client, entity: string, value = 'copper widgets') {
  return unpack(await client.callTool({ name: 'memory_store', arguments: { entity, key: 'decision', value } }));
}
async function search(client: Client, args: Record<string, unknown>) {
  return unpack(await client.callTool({ name: 'memory_search', arguments: args }));
}

test('memory_search exact ID reaches a crowded fact without altering ordinary keyword defaults or rows', async () => {
  await withMemory(async (client, dbPath) => {
    const target = await store(client, 'oldest');
    for (let i = 0; i < 30; i++) await store(client, `newer-${i}`);
    const db = new Database(dbPath, { readwrite: true });
    try {
      // Deterministic newer timestamps without altering stored payloads or TTLs.
      db.query('UPDATE facts SET created_at = created_at - 1 WHERE id = ?').run(target.id);
      const before = db.query('SELECT * FROM facts ORDER BY id').all();
      const ordinary = await search(client, { query: 'copper', limit: 30 });
      expect(ordinary).toHaveLength(30);
      expect(ordinary.some((row: any) => row.id === target.id)).toBe(false);
      expect(await search(client, { query: 'copper' })).toHaveLength(10);
      expect(await search(client, { query: 'copper', limit: 1 })).toHaveLength(1);
      const exact = await search(client, { query: 'copper', id: target.id, limit: 1 });
      expect(exact).toHaveLength(1);
      expect(exact[0].id).toBe(target.id);
      expect(exact[0].value).toBe(target.value);
      expect(exact[0].tags).toEqual(['fact']);
      expect(db.query('SELECT * FROM facts ORDER BY id').all()).toEqual(before);
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'memory_search')!;
      expect(tool.inputSchema.required).toEqual(['query']);
      expect(tool.inputSchema.properties).toHaveProperty('id');
    } finally { db.close(); }
  });
}, 20000);

test('memory_search unknown exact ID returns empty, not other keyword matches', async () => {
  await withMemory(async client => {
    await store(client, 'known');
    expect(await search(client, { query: 'copper', id: 'unknown-fixture-id' })).toEqual([]);
    expect(await search(client, { query: 'copper', id: "' OR 1=1 --" })).toEqual([]);
  });
});

test('memory_search exact ID still requires existing SQLite keyword matching', async () => {
  await withMemory(async client => {
    const target = await store(client, 'distinct-entity');
    await store(client, 'decoy', 'no-match');
    expect(await search(client, { query: 'no-match', id: target.id })).toEqual([]);
    for (const query of ['COPPER', 'distinct-entity', 'decision', '%widgets', 'c_pper']) {
      expect((await search(client, { query, id: target.id })).map((row: any) => row.id)).toEqual([target.id]);
    }
  });
});

test('memory_search expired exact ID is empty and does not resurrect or modify the fact', async () => {
  await withMemory(async (client, dbPath) => {
    const target = await store(client, 'expired');
    await store(client, 'live');
    const db = new Database(dbPath, { readwrite: true });
    try {
      db.query('UPDATE facts SET expires_at = ? WHERE id = ?').run(1, target.id);
      const before = db.query('SELECT * FROM facts ORDER BY id').all();
      expect(await search(client, { query: 'copper', id: target.id })).toEqual([]);
      expect(await search(client, { query: 'copper' })).toHaveLength(1);
      expect(db.query('SELECT * FROM facts ORDER BY id').all()).toEqual(before);
    } finally { db.close(); }
  });
});

test('memory_search rejects invalid ID and retains query/limit validation', async () => {
  await withMemory(async client => {
    await store(client, 'known');
    const invalid = [
      { query: 'copper', id: '' }, { query: 'copper', id: 'x'.repeat(201) },
      { query: 'copper', id: 123 }, { query: 'copper', id: null },
      { id: 'known' }, { query: '', id: 'known' }, { query: 'x'.repeat(2001), id: 'known' },
      ...[0, 31, 1.5].map(limit => ({ query: 'copper', id: 'known', limit })),
    ];
    for (const arguments_ of invalid) {
      expect((await client.callTool({ name: 'memory_search', arguments: arguments_ })).isError).toBe(true);
    }
  });
});
