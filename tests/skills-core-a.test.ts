import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Offline end-to-end checks for the t2 core skills: a disposable profile, a fake `hermes`
// executable, and no provider credentials or live profile in the child environment.
const repo = resolve(import.meta.dir, '..');
const skill = (name: string, file: string) => join(repo, 'skills/zouroboros', name, 'scripts', file);
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-core-a-'));
  for (const dir of ['work', 'home', 'scratch', 'bin']) mkdirSync(join(root, dir));
  env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'),
  };
  const init = run(join(repo, 'integration/cli.ts'), ['init', '--workspace', join(root, 'work')]);
  expect(init.code).toBe(0);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(script: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd, env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function fakeHermes(body: string) {
  const file = join(root, 'bin', 'hermes');
  writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' called >> "${root}/hermes.calls"\n${body}\n`);
  chmodSync(file, 0o700);
  return file;
}

test('zo-memory-system writes only the profile database, shared with the MCP server', async () => {
  const zmem = skill('zo-memory-system', 'zmem.ts');
  const hostile = { ZO_MEMORY_DB: join(root, 'host.db'), ZOUROBOROS_MEMORY_DB: join(root, 'host2.db') };
  const stored = run(zmem, ['store', '--entity', 'project.widgets', '--key', 'metal', '--value', 'Use copper widgets', '--category', 'decision'], hostile);
  expect(stored.code).toBe(0);
  expect(JSON.parse(stored.stdout).value).toBe('Use copper widgets');
  expect(run(zmem, ['where'], hostile).stdout.trim()).toBe(join(root, 'data', 'memory.db'));
  expect(existsSync(hostile.ZO_MEMORY_DB)).toBe(false);
  expect(existsSync(hostile.ZOUROBOROS_MEMORY_DB)).toBe(false);

  const episode = run(zmem, ['episode', '--summary', 'Shipped copper widgets', '--outcome', 'success', '--entities', 'project.widgets']);
  expect(episode.code).toBe(0);
  const episodes = JSON.parse(run(zmem, ['episodes', '--since', '1d']).stdout);
  expect(episodes.map((e: { summary: string }) => e.summary)).toEqual(['Shipped copper widgets']);
  expect(JSON.parse(run(zmem, ['stats']).stdout).database).toMatchObject({ facts: 1, episodes: 1 });
  expect(run(zmem, ['store', '--entity', 'x', '--value', 'y', '--decay', 'forever']).code).toBe(1);

  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, 'integration/mcp.ts')], env, stderr: 'pipe' });
  const client = new Client({ name: 'skills-core-a', version: '1.0.0' });
  try {
    await client.connect(transport);
    const found = await client.callTool({ name: 'memory_search', arguments: { query: 'copper' } });
    expect(JSON.stringify(found)).toContain('Use copper widgets');
  } finally { await client.close(); }

  const noProfile = run(zmem, ['search', 'copper'], { HERMES_ZOUROBOROS_HOME: join(root, 'missing') });
  expect(noProfile.code).toBe(1);
  expect(noProfile.stderr).toContain('Run init first');
}, 30_000);

test('zo-swarm-orchestrator gates, validates, prepares and runs a DAG through the real orchestrator', () => {
  const swarm = skill('zo-swarm-orchestrator', 'swarm.ts');
  expect(JSON.parse(run(swarm, ['gate', 'Fix a typo in the README']).stdout).decision).toBe('DIRECT');
  expect(JSON.parse(run(swarm, ['gate', 'Use a swarm to migrate the schema across all packages']).stdout).decision).toBe('FORCE_SWARM');

  writeFileSync(join(root, 'cycle.json'), JSON.stringify([{ id: 'a', task: 'x', dependsOn: ['a'] }]));
  expect(run(swarm, ['validate', 'cycle.json']).code).toBe(1);
  writeFileSync(join(root, 'extra.json'), JSON.stringify([{ id: 'a', task: 'x', executor: 'other' }]));
  expect(run(swarm, ['validate', 'extra.json']).code).toBe(1);

  writeFileSync(join(root, 'tasks.json'), JSON.stringify([
    { id: 'inspect', task: 'List files', timeoutSeconds: 10 },
    { id: 'summarize', task: 'Summarize', dependsOn: ['inspect'], timeoutSeconds: 10 },
  ]));
  expect(JSON.parse(run(swarm, ['validate', 'tasks.json']).stdout).ids).toEqual(['inspect', 'summarize']);
  const prepared = JSON.parse(run(swarm, ['prepare', 'tasks.json']).stdout);
  expect(prepared.taskFile.startsWith(join(root, 'data', 'campaigns') + '/')).toBe(true);

  fakeHermes(`printf 'FAKE_OK\\n'`);
  const denied = run(swarm, ['run', prepared.taskFile]);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain('opt-in');
  expect(existsSync(join(root, 'hermes.calls'))).toBe(false);

  const executed = run(swarm, ['run', prepared.taskFile], { HERMES_ZOUROBOROS_ALLOW_SWARM: '1' });
  expect(executed.code).toBe(0);
  const summary = JSON.parse(executed.stdout.trim().split('\n').at(-1)!);
  expect(summary.ok).toBe(true);
  expect(summary.results.map((r: { output: string }) => r.output)).toEqual(['FAKE_OK\n', 'FAKE_OK\n']);
  expect(readFileSync(join(root, 'hermes.calls'), 'utf8')).toBe('called\ncalled\n');
  expect(existsSync(join(root, 'home', '.hermes'))).toBe(false);
}, 60_000);

test('zo-swarm-executors lists the generated registry and health-checks the Hermes bridge', () => {
  const executors = skill('zo-swarm-executors', 'executors.ts');
  const listed = JSON.parse(run(executors, ['list']).stdout);
  expect(listed).toEqual([expect.objectContaining({ id: 'hermes-vps', transport: 'bridge', bridge: join(repo, 'integration/hermes-bridge.sh') })]);
  const missing = run(executors, ['doctor'], { PATH: `${join(root, 'bin')}:/usr/bin:/bin` });
  expect(missing.code).toBe(1);
  fakeHermes(`echo "Hermes Agent v0.0-test"`);
  const healthy = run(executors, ['doctor']);
  expect(healthy.code).toBe(0);
  expect(JSON.parse(healthy.stdout)[0]).toMatchObject({ id: 'hermes-vps', ok: true, checks: { bridge: true, health: true } });
});

test('tier-resolver ships a host-free default catalog and keeps feedback in the state dir', () => {
  const resolver = skill('tier-resolver', 'persona-tier-resolve.ts');
  const catalog = JSON.parse(readFileSync(join(repo, 'skills/zouroboros/tier-resolver/assets/models.default.json'), 'utf8'));
  expect(Object.values(catalog.models).map((m: any) => m.id)).toEqual(['', '', '']);
  expect(catalog.personaOverrides).toEqual({});
  expect(catalog.externalRouting).toBeUndefined();
  expect(readdirSync(join(repo, 'skills/zouroboros/tier-resolver')).sort()).toEqual(['SKILL.md', 'assets', 'scripts']);

  const json = JSON.parse(run(resolver, ['--json', 'Design a microservices architecture for the e-commerce platform with service mesh, API gateway, and event-driven communication']).stdout);
  expect(json.complexity.tier).toBe('complex');
  expect(json.model).toMatchObject({ modelKey: 'deep', modelId: '', provider: 'hermes' });

  const state = join(root, 'state');
  expect(run(resolver, ['Write a function to add two numbers'], { ZOUROBOROS_STATE_DIR: state }).code).toBe(0);
  const feedback = readFileSync(join(state, 'tier-resolver', 'feedback.jsonl'), 'utf8').trim().split('\n');
  expect(feedback).toHaveLength(1);
  expect(JSON.parse(feedback[0]!).recommendedTier).toBe('trivial');

  const config = join(root, 'config', 'tier-resolver');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'models.json'), JSON.stringify({ ...catalog, models: { ...catalog.models, fast: { ...catalog.models.fast, id: 'example/fast' } } }));
  expect(run(resolver, ['--no-feedback', 'Fix typo in the documentation'], { ZOUROBOROS_CONFIG_DIR: join(root, 'config') }).stdout.trim()).toBe('example/fast');
});

test('tier-resolver regression suite and its own tests pass against the default weights', () => {
  const suite = run(skill('tier-resolver', 'run-test-suite.ts'), []);
  expect(suite.code).toBe(0);
  expect(suite.stdout).toContain('All checks passed');
  const own = Bun.spawnSync(['bun', 'test', join(repo, 'skills/zouroboros/tier-resolver/scripts')], { cwd: repo, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  expect(own.exitCode).toBe(0);
  expect(own.stderr.toString()).toMatch(/\b45 pass\b/);
  expect(own.stderr.toString()).toContain(' 0 fail');
}, 90_000);

test('autoloop keeps improvements and records results through the Hermes bridge, opt-in only', () => {
  const project = join(root, 'project');
  mkdirSync(project);
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: project, env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }, stdout: 'pipe', stderr: 'pipe' });
  git('init', '-q');
  writeFileSync(join(project, 'value.txt'), '5\n');
  writeFileSync(join(project, '.gitignore'), 'results.tsv\nautoloop-summary-*\n');
  writeFileSync(join(project, 'program.md'), [
    '# Program: Shrink Value', '', '## Objective', 'Make the number in value.txt small.', '',
    '## Metric', '- **name**: value', '- **direction**: lower_is_better', '- **extract**: `cat value.txt`', '',
    '## Target File', 'value.txt', '', '## Run Command', '```bash', 'test -s value.txt', '```', '',
    '## Constraints', '- **Max experiments**: 3', '',
  ].join('\n'));
  git('add', '-A');
  git('commit', '-qm', 'init');
  // The fake agent always proposes the current value minus one.
  fakeHermes(`cur=$(cat value.txt); printf 'HYPOTHESIS: decrement\\n\`\`\`\\n%s\\n\`\`\`\\n' "$((cur-1))"`);
  const autoloop = skill('autoloop', 'autoloop.ts');
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

  expect(run(autoloop, ['--program', join(project, 'program.md'), '--dry-run']).code).toBe(0);
  const denied = run(autoloop, ['--program', join(project, 'program.md')], gitEnv);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain('opt-in');
  expect(existsSync(join(root, 'hermes.calls'))).toBe(false);

  const loop = run(autoloop, ['--program', join(project, 'program.md')], { ...gitEnv, HERMES_ZOUROBOROS_ALLOW_SWARM: '1' });
  expect(loop.code).toBe(0);
  expect(readFileSync(join(project, 'value.txt'), 'utf8').trim()).toBe('3');
  const rows = readFileSync(join(project, 'results.tsv'), 'utf8').trim().split('\n').slice(1).map((line) => line.split('\t'));
  expect(rows.map((row) => [row[1], row[2]])).toEqual([['5.000000', 'keep'], ['4.000000', 'keep'], ['3.000000', 'keep']]);
  expect(git('branch', '--show-current').stdout.toString().trim()).toStartWith('autoloop/shrink-value-');
  expect(readFileSync(join(root, 'hermes.calls'), 'utf8')).toBe('called\ncalled\n');
}, 60_000);
