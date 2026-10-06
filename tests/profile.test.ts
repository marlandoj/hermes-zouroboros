import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initialize } from '../integration/profile.ts';
import { validateTasks } from '../integration/tasks.ts';

test('isolated profile uses absolute MCP entry and preserves existing settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
  const previous = process.env.HERMES_ZOUROBOROS_HOME;
  try {
    process.env.HERMES_ZOUROBOROS_HOME = join(root, 'data');
    mkdirSync(join(root, 'work'));
    const paths = initialize(join(root, 'work'));
    const before = readFileSync(join(paths.profile, 'config.yaml'), 'utf8');
    const config = parse(before);
    expect(config.mcp_servers.zouroboros.args[0]).toMatch(/\/integration\/mcp.ts$/);
    expect(config.mcp_servers.zouroboros.command).toBe(process.execPath);
    expect(statSync(paths.settings).mode & 0o777).toBe(0o600);
    expect(() => initialize(join(root, 'work'))).toThrow('already exists');
    expect(readFileSync(join(paths.profile, 'config.yaml'), 'utf8')).toBe(before);
  } finally {
    if (previous === undefined) delete process.env.HERMES_ZOUROBOROS_HOME; else process.env.HERMES_ZOUROBOROS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('campaign rejects cycles, missing dependencies, duplicates and arbitrary executor override', () => {
  expect(() => validateTasks([{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }])).toThrow('cycle');
  expect(() => validateTasks([{ id: 'a', task: 'x', dependsOn: ['missing'] }])).toThrow('Unknown');
  expect(() => validateTasks([{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }])).toThrow('Duplicate');
  expect(() => validateTasks([{ id: 'a', task: 'x', executor: 'other' }])).toThrow();
  expect(validateTasks([{ id: 'a', task: 'x' }])[0]!.executor).toBe('hermes-vps');
});
