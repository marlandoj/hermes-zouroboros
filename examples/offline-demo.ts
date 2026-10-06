#!/usr/bin/env bun
// Real CLI + MCP calls, with a fresh disposable profile and no provider credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repoRoot } from '../integration/profile.ts';

const root = mkdtempSync(join(tmpdir(), 'hermes-demo-'));
const workspace = join(root, 'work');
mkdirSync(workspace);
// Deliberately pass only PATH and the disposable profile location to children.
const env = { PATH: process.env.PATH || '', HERMES_ZOUROBOROS_HOME: join(root, 'data') };
const client = new Client({ name: 'readme-demo', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(repoRoot, 'integration/mcp.ts')], env, stderr: 'pipe',
});
function cli(args: string[], expected = 0) {
  const result = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), ...args],
    { env, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(result.exitCode, expected, `CLI ${args[0]} did not return ${expected}`);
  return result.stdout.toString();
}
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `MCP ${name} failed`);
  const content = response.content as { type: string; text?: string }[];
  const block = content.find(item => item.type === 'text');
  assert.ok(block?.text, 'Expected MCP JSON response');
  return JSON.parse(block.text);
}
try {
  cli(['init', '--workspace', workspace]);
  console.log('[1/4] CHECK THE WORKSHOP');
  console.log('$ bun integration/cli.ts doctor');
  // Hermes is optional for this offline demonstration, but doctor reports it honestly.
  const doctor = JSON.parse(cli(['doctor'], Bun.which('hermes', { PATH: env.PATH }) ? 0 : 1));
  for (const [name, passed] of Object.entries(doctor.checks)) {
    if (name !== 'hermes') assert.equal(passed, true, `Build/setup required: ${name}`);
    console.log(`  ${passed ? 'PASS' : 'MISSING'} ${name}`);
  }
  console.log('Local checks only; provider authentication is separate.');

  console.log('\n[2/4] SAVE A DECISION');
  console.log('$ bun integration/cli.ts memory store --entity demo \\');
  console.log('    --key choice --value "Use copper widgets"');
  const stored = cli(['memory', 'store', '--entity', 'demo', '--key', 'choice', '--value', 'Use copper widgets']);
  assert.ok(stored.includes('Stored demo.choice = Use copper widgets'));
  console.log('Stored demo.choice = Use copper widgets');

  console.log('\n[3/4] RECALL IT THROUGH MCP');
  await client.connect(transport);
  console.log('MCP > memory_search({"query":"copper"})');
  const found = await call('memory_search', { query: 'copper' });
  assert.ok(Array.isArray(found));
  const fact = found.find(item => item.entity === 'demo' && item.key === 'choice');
  assert.equal(fact?.value, 'Use copper widgets');
  console.log(`${fact.entity}.${fact.key} = ${fact.value}`);
  console.log('Same SQLite fact, read by a new MCP process.');

  console.log('\n[4/4] PREPARE A CAMPAIGN');
  console.log('MCP > swarm_prepare(tasks: inspect -> summarize)');
  const tasks = [
    { id: 'inspect', task: 'Read the workspace and list its top-level files.' },
    { id: 'summarize', task: 'Summarize the inspection findings.', dependsOn: ['inspect'] },
  ];
  const prepared = await call('swarm_prepare', { tasks });
  assert.equal(prepared.taskCount, 2);
  assert.ok(prepared.taskFile.startsWith(join(env.HERMES_ZOUROBOROS_HOME, 'campaigns') + '/'));
  const saved = JSON.parse(readFileSync(prepared.taskFile, 'utf8'));
  assert.deepEqual(saved.map((task: { id: string }) => task.id), ['inspect', 'summarize']);
  assert.deepEqual(saved[1].dependsOn, ['inspect']);
  const status = await call('workshop_status', {});
  assert.equal(status.swarmExecution, false);
  console.log(`Saved ${prepared.taskCount} tasks: inspect -> summarize`);
  console.log('Campaign: <temporary-profile>/campaigns/<id>.json');
  console.log(`Worker execution enabled: ${status.swarmExecution}`);
  console.log('Ready for review. No model calls made.');
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
console.log('\nDemo complete. Temporary profile and campaign removed.');
