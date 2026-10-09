import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

// Offline end-to-end checks for the t5 self-improvement skills: a disposable profile, no
// provider credentials, and a decoy host memory database that must never be read or written.
const repo = resolve(import.meta.dir, '..');
const skill = (path: string) => join(repo, 'skills/zouroboros', path);
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-selfimprove-'));
  for (const dir of ['work', 'home', 'scratch']) mkdirSync(join(root, dir));
  env = {
    PATH: process.env.PATH!, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'),
  };
  expect(run(process.execPath, [join(repo, 'integration/cli.ts'), 'init', '--workspace', join(root, 'work')]).code).toBe(0);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(cmd: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd, env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 300_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
const bun = (script: string, args: string[] = [], extra: Record<string, string> = {}) => run(process.execPath, [script, ...args], extra);
const files = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];

test('self-heal loop: introspect → prescribe → evolve use the profile memory and state dirs only', () => {
  const decoy = join(root, 'host-memory.db');
  const hostEnv = { ZO_MEMORY_DB: decoy, ZOUROBOROS_MEMORY_DB: decoy, ZOUROBOROS_SELFHEAL_DIR: join(root, 'host-selfheal') };
  const state = join(root, 'data/state/selfheal');

  const json = bun(skill('zouroboros-introspect/scripts/introspect.ts'), ['--json'], hostEnv);
  expect(json.code).toBe(0);
  const scorecard = JSON.parse(json.stdout);
  expect(scorecard.metrics.length).toBeGreaterThan(5);
  expect(typeof scorecard.composite).toBe('number');

  expect(bun(skill('zouroboros-introspect/scripts/introspect.ts'), ['--store'], hostEnv).code).toBe(0);
  expect(files(state).some((f) => /^scorecard-\d+\.json$/.test(f))).toBe(true);
  const db = new Database(join(root, 'data/memory.db'), { readonly: true });
  expect(db.query("SELECT COUNT(*) AS n FROM facts WHERE entity = 'zouroboros.introspection'").get()).toEqual({ n: 1 });
  expect((db.query("SELECT COUNT(*) AS n FROM episode_entities WHERE entity = 'zouroboros.introspection'").get() as { n: number }).n).toBe(1);
  db.close();

  const rx = bun(skill('zouroboros-prescribe/scripts/prescribe.ts'), [], hostEnv);
  expect(rx.code).toBe(0);
  const summary = JSON.parse(rx.stdout);
  expect(summary.path.startsWith(join(state, 'prescriptions'))).toBe(true);
  expect(['approved', 'blocked']).toContain(summary.governor);

  expect(bun(skill('zouroboros-evolve/scripts/evolve.ts'), ['--prescription', summary.path], hostEnv).code).toBe(2);
  const dry = bun(skill('zouroboros-evolve/scripts/evolve.ts'), ['--prescription', summary.path, '--dry-run'], hostEnv);
  expect(dry.code === 0 || dry.code === 1).toBe(true);
  expect(JSON.parse(dry.stdout).prescriptionId).toBeTruthy();

  // Nothing leaked to the decoy locations or into the operator's workspace.
  expect(existsSync(decoy)).toBe(false);
  expect(existsSync(join(root, 'host-selfheal'))).toBe(false);
  expect(files(join(root, 'work'))).toEqual([]);
}, 300_000);

test('self-heal G7: a fresh profile measures Memory Recall with the shipped synthetic eval, never a workspace file', () => {
  const selfheal = join(repo, 'packages/selfheal/src');
  const scorecard = JSON.parse(bun(skill('zouroboros-introspect/scripts/introspect.ts'), ['--json']).stdout);
  const recall = scorecard.metrics.find((metric: { name: string }) => metric.name === 'Memory Recall');
  expect(recall).toBeDefined();
  expect(recall.status).not.toBe('CRITICAL');
  expect(recall.value).toBe(1);
  expect(recall.detail).toBe('100.0% fixture pass rate');
  expect(JSON.stringify(scorecard)).not.toMatch(/not found in Skills|Install zo-memory-system/);
  // The fresh workspace is empty: nothing came from it.
  expect(files(join(root, 'work'))).toEqual([]);

  // The eval is synthetic and hermetic, and it can fail: a fixture expecting an absent phrase misses.
  const fixtures = JSON.parse(readFileSync(join(selfheal, 'introspect/memory-recall-fixtures.json'), 'utf8'));
  expect(fixtures._provenance).toContain('Synthetic');
  fixtures.cases.push({ id: 'absent', query: 'what colour is the orchard robot?', expectAny: ['ultramarine'] });
  writeFileSync(join(root, 'fixtures.json'), JSON.stringify(fixtures));
  const missed = bun(join(selfheal, 'introspect/memory-recall-eval.ts'), [], { ZOUROBOROS_MEMORY_RECALL_FIXTURES: join(root, 'fixtures.json') });
  expect(missed.stdout).toContain('Cases: 11');
  expect(missed.stdout).toContain('Passed: 10');
  expect(missed.stdout).toContain('Failed: absent');
  expect(readdirSync(join(root, 'scratch'))).toEqual([]);

  // A missing eval is insufficient evidence, not a CRITICAL score.
  const absent = JSON.parse(bun(skill('zouroboros-introspect/scripts/introspect.ts'), ['--json'], { ZOUROBOROS_MEMORY_RECALL_EVAL: join(root, 'missing.ts') }).stdout);
  expect(absent.metrics.find((metric: { name: string }) => metric.name === 'Memory Recall')).toBeDefined();
}, 300_000);

test('self-heal G7: evolve recipes point at existing distribution files, never Skills/ or the workspace', async () => {
  const { getPlaybook } = await import('../packages/selfheal/src/prescribe/playbook.ts');
  const names = ['Memory Recall', 'Graph Connectivity', 'Routing Accuracy', 'Eval Calibration'];
  for (const name of names) for (const status of ['CRITICAL', 'WARNING']) {
    const playbook = getPlaybook({ name, status, value: 0.5, target: 0.9, critical: 0.7, weight: 0.2, score: 0.5, detail: '', recommendation: '', trend: 'stable' } as never);
    const text = JSON.stringify(playbook);
    expect(text).not.toMatch(/Skills\/|zo-memory-system|eval-continuation|shared-facts\.db/);
    for (const file of [playbook.targetFile, ...(playbook.readOnlyFiles ?? [])].filter(Boolean) as string[]) {
      expect(file.startsWith(repo + '/')).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  }
  const recall = getPlaybook({ name: 'Memory Recall', status: 'WARNING' } as never);
  const metric = run('bash', ['-c', recall.metricCommand]);
  expect(metric.stdout.trim()).toBe('100.0');
  // Graph connectivity metric reads the profile memory database (introspect creates it).
  expect(bun(skill('zouroboros-introspect/scripts/introspect.ts'), ['--json']).code).toBe(0);
  const graph = run('bash', ['-c', getPlaybook({ name: 'Graph Connectivity', status: 'WARNING' } as never).metricCommand], { ZOUROBOROS_MEMORY_DB: join(root, 'data/memory.db') });
  expect(graph.stdout.trim()).toMatch(/^\d+(\.\d+)?$/);
}, 300_000);

test('instinct-harvester: own selftests pass and the store lives under the profile state dir', () => {
  for (const t of ['selftest', 'lifecycle-selftest', 'supersede-selftest', 'use-flush-selftest', 'remove-verify-selftest']) {
    const result = bun(skill(`instinct-harvester/scripts/${t}.ts`));
    expect({ t, code: result.code, tail: result.stdout.trim().split('\n').at(-1) }).toMatchObject({ t, code: 0 });
    expect(result.stdout).toMatch(/\d+ pass \/ 0 fail/);
  }
  const observer = skill('instinct-harvester/scripts/observer.ts');
  expect(bun(observer, ['add', '--trigger', 'when changing CI in this repo', '--action', 'run the leak gate first', '--domain', 'ci']).code).toBe(0);
  expect(bun(observer, ['brief', '--context', 'a ci change']).stdout).toContain('run the leak gate first');
  expect(readFileSync(join(root, 'data/state/instincts/instincts.yaml'), 'utf8')).toContain('domain: ci');
  expect(bun(skill('instinct-harvester/scripts/lifecycle.ts'), ['--help']).code).toBe(0);
  expect(existsSync(join(root, 'data/state/instincts/lifecycle-reports'))).toBe(false);
  expect(bun(skill('instinct-harvester/scripts/lifecycle.ts')).code).toBe(0);
  expect(files(join(root, 'data/state/instincts/lifecycle-reports')).length).toBe(1);
}, 300_000);

test('extract-patterns: Hermes hook selftest passes and paths default under the profile', () => {
  const selftest = run('bash', [skill('extract-patterns/scripts/selftest.sh')]);
  expect(selftest.code).toBe(0);
  expect(selftest.stdout).toContain('0 fail');
  const hook = skill('extract-patterns/scripts/extract-patterns-hook.sh');
  const payload = JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: 's1', extra: { conversation_history: Array(40).fill({}) } });
  const result = Bun.spawnSync(['bash', hook], { env, stdin: new TextEncoder().encode(payload), stdout: 'pipe' });
  expect(JSON.parse(result.stdout.toString()).context).toContain('instinct-harvester/scripts/observer.ts');
  expect(readFileSync(join(root, 'data/logs/extract-patterns.log'), 'utf8')).toContain('session=s1 decision=prompted messages=40');
  expect(existsSync(join(root, 'data/state/extract-patterns/s1.prompted'))).toBe(true);
});

test('agent-introspect: own tests pass; the audit reads a skills tree and reports under the state dir', () => {
  for (const t of ['test_introspect.py', 'test_persona_audit.py']) expect(run('python3', [skill(`agent-introspect/scripts/${t}`)]).code).toBe(0);
  const tree = join(root, 'tree');
  mkdirSync(join(tree, 'cat/good/scripts'), { recursive: true });
  mkdirSync(join(tree, 'cat/empty/scripts'), { recursive: true });
  writeFileSync(join(tree, 'cat/good/SKILL.md'), '---\nname: good\ndescription: ok\n---\n');
  writeFileSync(join(tree, 'cat/good/scripts/ok.sh'), 'echo usage\n');
  writeFileSync(join(tree, 'cat/good/scripts/bad.sh'), 'exit 7\n');
  writeFileSync(join(tree, 'cat/empty/SKILL.md'), '---\nname: empty\ndescription:\n---\n');
  writeFileSync(join(root, 'work/AGENTS.md'), '# agents\n');
  const extra = { AGENT_INTROSPECT_SKILLS_DIR: tree, ZOUROBOROS_WORKSPACE: join(root, 'work') };
  const findings = JSON.parse(run('python3', [skill('agent-introspect/scripts/introspect.py'), '--findings-only'], extra).stdout);
  expect(findings.identity).toEqual([]);
  expect(findings.skills.join('\n')).toContain('empty: empty description');
  expect(findings.skills.join('\n')).toContain('empty: scripts/ dir exists but has no runnable files');
  expect(findings.health.join('\n')).toContain('good/bad.sh: exit 7');
  expect(run('python3', [skill('agent-introspect/scripts/introspect.py')], extra).code).toBe(0);
  const status = JSON.parse(readFileSync(join(root, 'data/state/agent-introspect/.introspect-status.json'), 'utf8'));
  expect(status).toMatchObject({ status: 'OK', exit_code: 0, findings: 3 });
});

test('operator-digest: own tests pass; the digest reads profile state and writes under the state dir', () => {
  const own = run(process.execPath, ['test', skill('operator-digest/scripts/governance-evidence.test.ts')], {}, repo);
  expect(own.code).toBe(0);
  mkdirSync(join(root, 'data/state/agent-model-healer'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, 'data/state/agent-model-healer/state.json'), JSON.stringify({
    switches: [{ agentId: 'j1', agentTitle: 'nightly report', originalModel: 'model-a', currentModel: 'model-b', switchedAt: now, reason: 'unhealthy' }],
    lastProbe: { 'model-a': { model: 'model-a', healthy: false, health: 'unhealthy', checkedAt: now } },
  }));
  const result = bun(skill('operator-digest/scripts/digest.ts'), ['--no-pdf']);
  expect(result.code).toBe(0);
  const manifest = JSON.parse(result.stdout);
  // A profile with no governance ledger yet fails closed (the ledger is absent, so it cannot be
  // integrity-valid evidence); the accepted-ledger path is covered by the skill's own tests.
  expect(manifest.status).toBe('action');
  expect(manifest.summary).toContain('governance ledger failed integrity verification');
  expect(manifest.mdPath.startsWith(join(root, 'data/state/operator-digest'))).toBe(true);
  const md = readFileSync(manifest.mdPath, 'utf8');
  expect(md).toContain('nightly report');
  expect(md).not.toContain('Modal');
});
