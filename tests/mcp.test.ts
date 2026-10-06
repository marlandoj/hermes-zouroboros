import { test, expect } from 'bun:test';
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
