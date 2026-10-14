import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../integration/profile.ts';

// Regression for keyword search (assessment D-27, D-13): memory_search is documented as keyword
// search, so a fact must match when every query term occurs in it, in any order, and LIKE
// wildcards in the query must match only themselves. Real stdio MCP in disposable state.
async function withMemory(run: (client: Client) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-terms-'));
  const data = join(root, 'data'); const workspace = join(root, 'work'); mkdirSync(workspace);
  const env = { PATH: process.env.PATH!, HOME: root, TMPDIR: root,
    HERMES_ZOUROBOROS_HOME: data, HERMES_ZOUROBOROS_ALLOW_SWARM: '0' };
  const client = new Client({ name: 'search-terms-fixture', version: '1' });
  try {
    const setup = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), 'init', '--workspace', workspace], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(setup.exitCode).toBe(0);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'integration/mcp.ts')], env, stderr: 'pipe' }));
    await run(client);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}
function unpack(value: any) {
  expect(value.isError).not.toBe(true);
  return JSON.parse(value.content[0].text);
}
async function store(client: Client, entity: string, value: string) {
  return unpack(await client.callTool({ name: 'memory_store', arguments: { entity, key: 'note', value } }));
}
async function hits(client: Client, query: string, id?: string): Promise<string[]> {
  const rows = unpack(await client.callTool({ name: 'memory_search', arguments: id ? { query, id } : { query } }));
  return rows.map((r: { entity: string }) => r.entity).sort();
}

describe('memory_search keyword matching', () => {
  test('every term must match, in any order, across entity and value', async () => {
    await withMemory(async client => {
      const target = await store(client, 'shared-goal', 'Hermes and Zouroboros share work memory');
      await store(client, 'other', 'unrelated cobalt note about Hermes');
      expect(await hits(client, 'memory shared work')).toEqual(['shared-goal']);
      expect(await hits(client, 'Zouroboros Hermes')).toEqual(['shared-goal']);
      expect(await hits(client, '  share   Zouroboros  ')).toEqual(['shared-goal']);
      expect(await hits(client, 'cobalt other')).toEqual(['other']);
      expect(await hits(client, 'Hermes')).toEqual(['other', 'shared-goal']);
      expect(await hits(client, 'Hermes and Zouroboros')).toEqual(['shared-goal']);
      expect(await hits(client, 'shared memory absentword')).toEqual([]);
      expect(await hits(client, 'memory Hermes', target.id)).toEqual(['shared-goal']);
      expect(await hits(client, 'absentword Hermes', target.id)).toEqual([]);
    });
  }, 30000);

  test('LIKE wildcards in the query are literal', async () => {
    await withMemory(async client => {
      const target = await store(client, 'plain', 'Hermes and Zouroboros share work memory');
      const literal = await store(client, 'literal', 'growth was 100% on a_b');
      expect(await hits(client, '%')).toEqual(['literal']);
      expect(await hits(client, '_')).toEqual(['literal']);
      expect(await hits(client, 'a_b 100%')).toEqual(['literal']);
      expect(await hits(client, 'Herm%')).toEqual([]);
      expect(await hits(client, 'H_rmes')).toEqual([]);
      expect(await hits(client, '%', target.id)).toEqual([]);
      expect(await hits(client, '%', literal.id)).toEqual(['literal']);
    });
  }, 30000);
});
