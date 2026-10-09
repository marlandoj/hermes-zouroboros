import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initialize, registerSkills, restrictedEmailDomainsNotice, skillsDir } from '../integration/profile.ts';
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
    // Swarm execution defaults off with a literal 0 (no unresolved ${env:…} ref for Hermes to warn about).
    expect(config.mcp_servers.zouroboros.env.HERMES_ZOUROBOROS_ALLOW_SWARM).toBe('0');
    expect(before).not.toContain('${env:');
    expect(config.model).toBeUndefined();
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
test('init --model/--provider writes the Hermes model non-interactively; notices the unset restricted-domains guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
  try {
    mkdirSync(join(root, 'work'));
    const cli = join(import.meta.dir, '../integration/cli.ts');
    const env = (data: string, extra: Record<string, string> = {}) => {
      const base: Record<string, string> = { PATH: process.env.PATH!, HOME: root, HERMES_ZOUROBOROS_HOME: join(root, data), ...extra };
      return base;
    };
    const run = (data: string, args: string[], extra: Record<string, string> = {}) => {
      const result = Bun.spawnSync([process.execPath, cli, ...args], { env: env(data, extra), stdout: 'pipe', stderr: 'pipe' });
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    };
    const configOf = (data: string) => parse(readFileSync(join(root, data, 'hermes/config.yaml'), 'utf8'));

    const both = run('a', ['init', '--workspace', join(root, 'work'), '--model', 'vendor/model-x', '--provider', 'example-provider']);
    expect(both.code, both.stderr).toBe(0);
    expect(configOf('a').model).toEqual({ default: 'vendor/model-x', provider: 'example-provider' });
    expect(configOf('a').mcp_servers.zouroboros.env.HERMES_ZOUROBOROS_ALLOW_SWARM).toBe('0');
    expect(both.stderr.trim().split('\n')).toHaveLength(1);
    expect(both.stderr).toContain('ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS is not set');

    const modelOnly = run('b', ['init', '--workspace', join(root, 'work'), '--model', 'vendor/model-y'], { ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS: 'corp.example' });
    expect(modelOnly.code, modelOnly.stderr).toBe(0);
    expect(configOf('b').model).toEqual({ default: 'vendor/model-y' });
    expect(modelOnly.stderr).toBe('');

    for (const [data, args, message] of [
      ['c', ['--provider', 'example-provider'], '--provider requires --model'],
      ['d', ['--model', 'bad model; rm -rf'], '--model must be a model id'],
      ['e', ['--model', 'vendor/m', '--provider', 'bad provider'], '--provider must be'],
    ] as const) {
      const bad = run(data, ['init', '--workspace', join(root, 'work'), ...args]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain(message);
      expect(existsSync(join(root, data, 'settings.json'))).toBe(false);
    }

    const doctor = run('a', ['doctor']);
    expect(JSON.parse(doctor.stdout).notices).toEqual([expect.stringContaining('ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS is not set')]);
    expect(doctor.stderr).toContain('candidate-corpus guard');
    const configured = run('a', ['doctor'], { ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS: 'corp.example' });
    expect(JSON.parse(configured.stdout).notices).toBeUndefined();
    expect(configured.stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('restricted-domains notice: unset or invalid values notice; a valid domain silences it', () => {
  expect(restrictedEmailDomainsNotice({})).toContain('will not block employer-domain email addresses');
  expect(restrictedEmailDomainsNotice({ ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS: ' , not a domain' })).toBeDefined();
  expect(restrictedEmailDomainsNotice({ ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS: '@Corp.Example' })).toBeUndefined();
});
test('campaign rejects cycles, missing dependencies, duplicates and arbitrary executor override', () => {
  expect(() => validateTasks([{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }])).toThrow('cycle');
  expect(() => validateTasks([{ id: 'a', task: 'x', dependsOn: ['missing'] }])).toThrow('Unknown');
  expect(() => validateTasks([{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }])).toThrow('Duplicate');
  expect(() => validateTasks([{ id: 'a', task: 'x', executor: 'other' }])).toThrow();
  expect(validateTasks([{ id: 'a', task: 'x' }])[0]!.executor).toBe('hermes-vps');
});
