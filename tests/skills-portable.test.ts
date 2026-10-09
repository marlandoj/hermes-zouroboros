import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { classifyOutput, ledgerPath, logBlock, routeFallback } from '../skills/zouroboros/classifier-fallback/scripts/detector.ts';

const repo = resolve(import.meta.dir, '..');
const skillsDir = join(repo, 'skills');
let scratch = '';

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'skills-portable-test-')); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function skillFiles(dir = skillsDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return skillFiles(path);
    return name === 'SKILL.md' ? [path] : [];
  });
}

function frontmatter(path: string): Record<string, any> {
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${relative(repo, path)}: missing frontmatter`);
  return Bun.YAML.parse(match[1]!) as Record<string, any>;
}

test('every shipped skill has Hermes frontmatter, a licence and a unique name at skills/<category>/<name>', () => {
  const files = skillFiles();
  expect(files.length).toBeGreaterThan(0);
  const names = new Set<string>();
  for (const file of files) {
    const rel = relative(skillsDir, file).split('/');
    const meta = frontmatter(file);
    expect(rel.length).toBe(3);
    expect(meta.name).toBe(rel[1]);
    expect(typeof meta.description).toBe('string');
    expect(meta.description.length).toBeGreaterThan(20);
    expect(typeof meta.license).toBe('string');
    expect(meta.metadata?.hermes?.tags?.length).toBeGreaterThan(0);
    expect(names.has(meta.name)).toBe(false);
    names.add(meta.name);
  }
});

test('third-party skills ship their upstream licence file', () => {
  for (const dir of ['email/agentmail-sdk', 'email/agentmail-mcp', 'email/agentmail-check-email', 'email/agentmail-send-email',
    'email/agent-email-patterns', 'media/heygen-avatar', 'media/heygen-translate', 'media/heygen-video', 'research/tradingview-mcp-server']) {
    expect(readFileSync(join(skillsDir, dir, 'LICENSE'), 'utf8')).toStartWith('MIT License');
  }
});

test('skill names do not collide with Hermes bundled or optional skills (when HERMES_AGENT_SRC is set)', () => {
  const src = process.env.HERMES_AGENT_SRC;
  if (!src) return;
  const hermesNames = new Set<string>();
  for (const tree of ['skills', 'optional-skills']) {
    if (!existsSync(join(src, tree))) continue;
    const found = execFileSync('find', [join(src, tree), '-name', 'SKILL.md'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const file of found) hermesNames.add(frontmatter(file).name);
  }
  expect(hermesNames.size).toBeGreaterThan(0);
  const collisions = skillFiles().map((file) => frontmatter(file).name).filter((name) => hermesNames.has(name));
  expect(collisions).toEqual([]);
});

test('ponytail-debt ships with its own passing test suite', () => {
  const run = spawnSync('python3', ['-B', join(skillsDir, 'software-development/ponytail-debt/scripts/test-ponytail-debt.py')], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).not.toContain('FAIL');
});

test('classifier-fallback built-in suite passes and writes only to the configured ledger', () => {
  const ledger = join(scratch, 'blocks.jsonl');
  const run = spawnSync('bun', [join(skillsDir, 'zouroboros/classifier-fallback/scripts/detector.ts'), 'test'],
    { encoding: 'utf8', env: { ...process.env, CLASSIFIER_FALLBACK_LEDGER: ledger } });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('0 fail');
  expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('classifier-fallback never guesses a fallback model and keeps refuse-by-design domains', () => {
  expect(classifyOutput("I can't help with that.", 'anthropic').result).toBe('soft_block');
  expect(classifyOutput('function ok() {}', 'anthropic').result).toBe('ok');
  const unconfigured = routeFallback('security', {});
  expect(unconfigured.action).toBe('human_review');
  expect(unconfigured.fallback_model).toBeUndefined();
  expect(routeFallback('security', { CLASSIFIER_FALLBACK_MODEL: 'example/model' })).toMatchObject({ action: 'fallback', fallback_model: 'example/model' });
  const distillation = routeFallback('distillation', { CLASSIFIER_FALLBACK_MODEL: 'example/model' });
  expect(distillation.action).toBe('refuse_by_design');
  expect(distillation.fallback_model).toBeUndefined();
  expect(routeFallback('bio', { CLASSIFIER_FALLBACK_MODEL: 'example/model' }).action).toBe('human_review');
  const map = readFileSync(join(skillsDir, 'zouroboros/classifier-fallback/assets/fallback-map.json'), 'utf8');
  expect(map).not.toContain('byok:');
});

test('classifier-fallback ledger defaults to the Zouroboros state directory, not the skill tree', () => {
  expect(ledgerPath({ ZOUROBOROS_STATE_DIR: '/state' })).toBe('/state/classifier-fallback/classifier-blocks.jsonl');
  expect(ledgerPath({ XDG_STATE_HOME: '/xdg' })).toBe('/xdg/zouroboros/classifier-fallback/classifier-blocks.jsonl');
  const ledger = join(scratch, 'state', 'classifier-fallback', 'classifier-blocks.jsonl');
  const previous = process.env.ZOUROBOROS_STATE_DIR;
  const previousLedger = process.env.CLASSIFIER_FALLBACK_LEDGER;
  process.env.ZOUROBOROS_STATE_DIR = join(scratch, 'state');
  delete process.env.CLASSIFIER_FALLBACK_LEDGER;
  try {
    logBlock({ provider: 'anthropic', model: 'test', task_class: 'test', domain: 'general',
      detection: classifyOutput("I can't help with that.", 'anthropic'), fallback: routeFallback('general', {}) });
  } finally {
    if (previous === undefined) delete process.env.ZOUROBOROS_STATE_DIR; else process.env.ZOUROBOROS_STATE_DIR = previous;
    if (previousLedger !== undefined) process.env.CLASSIFIER_FALLBACK_LEDGER = previousLedger;
  }
  expect(JSON.parse(readFileSync(ledger, 'utf8')).domain).toBe('general');
});
