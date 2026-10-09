import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initialize, registerSkills, skillsDir } from '../integration/profile.ts';
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
    expect(config.skills.external_dirs).toEqual([skillsDir]);
    expect(registerSkills().changed).toBe(false);
    expect(statSync(paths.settings).mode & 0o777).toBe(0o600);
    expect(() => initialize(join(root, 'work'))).toThrow('already exists');
    expect(readFileSync(join(paths.profile, 'config.yaml'), 'utf8')).toBe(before);
  } finally {
    if (previous === undefined) delete process.env.HERMES_ZOUROBOROS_HOME; else process.env.HERMES_ZOUROBOROS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('skills register adds the distribution skills dir to an existing profile without losing settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
  const previous = process.env.HERMES_ZOUROBOROS_HOME;
  try {
    process.env.HERMES_ZOUROBOROS_HOME = join(root, 'data');
    expect(() => registerSkills()).toThrow('Run init first');
    mkdirSync(join(root, 'data/hermes'), { recursive: true });
    const config = join(root, 'data/hermes/config.yaml');
    writeFileSync(config, '# operator comment\nmodel: example-model\nskills:\n  external_dirs: /srv/other-skills\n');
    expect(registerSkills().changed).toBe(true);
    expect(registerSkills().changed).toBe(false);
    const text = readFileSync(config, 'utf8');
    expect(text).toContain('# operator comment');
    expect(parse(text)).toEqual({ model: 'example-model', skills: { external_dirs: ['/srv/other-skills', skillsDir] } });
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
