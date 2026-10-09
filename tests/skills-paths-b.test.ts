import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Offline checks for the t7 path skills: each skill's own suite plus smoke checks, in a disposable
// data root, with no provider credentials, no network and nothing written inside the skill tree.
const repo = resolve(import.meta.dir, '..');
const skill = (path: string) => join(repo, 'skills', path);
const SLOW = 600_000;
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-paths-b-'));
  for (const dir of ['home', 'scratch', 'work']) mkdirSync(join(root, dir));
  env = {
    PATH: process.env.PATH!, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'), ZOUROBOROS_WORKSPACE: join(root, 'work'),
  };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(cmd: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd, env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: SLOW,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
const bun = (script: string, args: string[] = [], extra: Record<string, string> = {}) => run(process.execPath, [script, ...args], extra);
const files = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
const t7Skills = ['software-development/plan-closeout', 'software-development/production-ready', 'software-development/skill-security-gate',
  'software-development/spec-first-interview', 'software-development/verity', 'software-development/visual-verifier',
  'software-development/workspace-search', 'devops/repo-drift-autofix', 'zouroboros/persona-consult', 'zouroboros/rag-telemetry', 'zouroboros/wayfinder'];

test('Bun suites of the t7 skills pass', () => {
  for (const dir of ['software-development/production-ready/scripts', 'software-development/skill-security-gate/scripts',
    'software-development/visual-verifier/scripts', 'zouroboros/persona-consult/scripts', 'zouroboros/rag-telemetry/scripts']) {
    const suite = run(process.execPath, ['test'], {}, skill(dir));
    expect(`${dir}: ${suite.code}`).toBe(`${dir}: 0`);
    expect(suite.stderr).toContain(' 0 fail');
  }
}, SLOW);

test('shell and Python suites of the t7 skills pass', () => {
  const closeout = run('python3', [skill('software-development/plan-closeout/scripts/test-closeout.py')]);
  expect(closeout.code).toBe(0);
  expect(closeout.stdout).toMatch(/(\d+)\/\1 passed/);
  for (const suite of ['software-development/verity/test/run.sh', 'zouroboros/wayfinder/test/run.sh']) {
    const result = run('bash', [skill(suite)]);
    const failures = result.stdout.split('\n').filter((line) => line.startsWith('FAIL')).join('; ');
    expect(`${suite}: ${result.code} ${failures}`).toBe(`${suite}: 0 `);
    expect(result.stdout).toMatch(/ 0 failed/);
  }
  expect(run('python3', [skill('zouroboros/wayfinder/test/regression.py')]).code).toBe(0);
}, SLOW);

test('workspace-search refuses without an allowed root and finds content inside one', () => {
  const script = skill('software-development/workspace-search/scripts/workspace-search.ts');
  const { ZOUROBOROS_WORKSPACE: _, ...bare } = env;
  const refused = Bun.spawnSync([process.execPath, script, '--root', root, '--query', 'x', '--no-log'], { env: bare, stdout: 'pipe', stderr: 'pipe' });
  expect(refused.exitCode).toBe(2);
  writeFileSync(join(root, 'work', 'notes.txt'), 'alpha\nneedle here\n');
  if (!Bun.which('rg')) {
    // ripgrep is a declared prerequisite; without it the search fails cleanly.
    const missing = bun(script, ['--root', join(root, 'work'), '--query', 'needle']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('ripgrep (rg) is required');
    return;
  }
  const found = bun(script, ['--root', join(root, 'work'), '--query', 'needle']);
  expect(found.code).toBe(0);
  expect(JSON.parse(found.stdout)).toMatchObject({ status: 'completed', partial: false });
  expect(found.stdout).toContain('notes.txt');
  expect(existsSync(join(root, 'data', 'logs', 'workspace-search.jsonl'))).toBe(true);
  expect(bun(script, ['--root', '/', '--query', 'needle']).code).toBe(2);
});

test('repo-drift-autofix: help is side-effect free and a protected branch is refused without a commit', () => {
  const script = skill('devops/repo-drift-autofix/scripts/autofix.ts');
  expect(bun(script, ['--help']).code).toBe(0);
  const work = join(root, 'repo');
  mkdirSync(work);
  const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {}, work);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  writeFileSync(join(work, 'b.txt'), 'b\n');
  const result = bun(script, ['--repo', work, '--dry-run'], { REPO_DRIFT_GITHUB_WRITES_DISABLED: '1' });
  expect(result.code).toBe(0);
  expect(result.stdout.toLowerCase()).toContain('protected');
  expect(git('rev-list', '--count', 'HEAD').stdout.trim()).toBe('1');
  expect(existsSync(join(root, 'data', 'logs', 'repo-drift-autofix.log'))).toBe(true);
});

test('t7 skills carry no operator brand or persona identity and no host paths', () => {
  // Same salted hashes as the t6 check, so this test does not itself contain the guarded strings.
  const guarded = new Set(['278767c100fa693178b04b62dd2d55e422a8310420257f5a0deae3bd263eea7b', '67b63f40d0a09e846a315d5fafdbf5826ec09e5b7fe16bc35a57c017d68d8e68', '27a8849a02cd9f5c06dd2a8a1fe101d8676fd42d722a9cdc32d52d6cabe05c83', '73b1869f0b02d0b4fe221d984f1e6422ac0ab70ff6fc0a9783a50828e71bcb1d']);
  const hashToken = (token: string) => createHash('sha256').update(`t6-brand-check:${token}`).digest('hex');
  for (const dir of t7Skills) {
    const skillMd = readFileSync(join(skill(dir), 'SKILL.md'), 'utf8');
    expect(skillMd.startsWith('---\nname: ')).toBe(true);
    expect(skillMd).toContain('  hermes:\n');
    for (const rel of files(skill(dir))) {
      const path = join(skill(dir), rel);
      if (!rel.includes('.') || rel.endsWith('/')) continue;
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      expect(`${rel}: ${text.match(/\/home\/workspace|\/root\/\.zo_secrets|\/home\/\.z\b|zo\.computer|zo\.space|\/dev\/shm\//)?.[0] ?? 'clean'}`).toBe(`${rel}: clean`);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (token) expect(guarded.has(hashToken(token))).toBe(false);
      }
    }
  }
  expect(existsSync(skill('software-development/ux-laws'))).toBe(false);
});
