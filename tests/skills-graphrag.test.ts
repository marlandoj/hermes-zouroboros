import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// graphrag-relational offline: its own suite in a disposable data root with CI set, so the
// first-use Redis download/build is refused; afterwards nothing exists in the cache or skill tree.
const repo = resolve(import.meta.dir, '..');
const skill = join(repo, 'skills/zouroboros/graphrag-relational');
let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'skills-graphrag-')); mkdirSync(join(root, 'home')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: skill, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    env: { PATH: process.env.PATH!, HOME: join(root, 'home'), TMPDIR: root, HERMES_ZOUROBOROS_HOME: join(root, 'data'), CI: 'true', ...extra },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test('graphrag-relational offline suite passes and live tests are skipped with a marker', () => {
  const suite = run(['test', 'scripts']);
  expect(suite.code).toBe(0);
  expect(suite.stderr).toContain(' 0 fail');
  expect(suite.stderr).toMatch(/[1-9]\d* skip/);
  expect(existsSync(join(root, 'data/cache/falkordblite')) && readdirSync(join(root, 'data/cache/falkordblite')).length).toBeFalsy();
  expect(existsSync(join(skill, 'node_modules'))).toBe(false);
}, 120_000);

test('extract refuses to guess a source and reads a configured factory directory', () => {
  const none = run(['scripts/extract.ts']);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain('No source configured');
  const empty = run(['scripts/extract.ts', '--factory-dir', join(root, 'factory')]);
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.stdout).sources.swarmDb.engine).toBe('missing');
});

test('runtime prepare is refused in CI without downloading anything', () => {
  const prepare = run(['scripts/runtime.ts', 'prepare']);
  expect(prepare.code).toBe(1);
  expect(prepare.stderr).toContain('disabled in CI');
  expect(readdirSync(root).filter((name) => name.startsWith('zouroboros-redis-build-'))).toEqual([]);
});
