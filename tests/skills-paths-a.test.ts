import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSparseVector, bm25Tokenize, embeddings } from '../integration/qdrant-corpus.ts';

// Offline checks for the t6 path skills: a disposable data root, no provider credentials, no
// network, and nothing written inside the skill tree.
const repo = resolve(import.meta.dir, '..');
const skill = (path: string) => join(repo, 'skills', path);
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-paths-a-'));
  for (const dir of ['home', 'scratch', 'work']) mkdirSync(join(root, dir));
  env = {
    PATH: process.env.PATH!, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'), ZOUROBOROS_WORKSPACE: join(root, 'work'),
  };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(cmd: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd: root, env: { ...env, ...extra }, stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
const bun = (script: string, args: string[] = [], extra: Record<string, string> = {}) => run(process.execPath, [script, ...args], extra);
const files = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
const t6Skills = ['media/ai-character-builder', 'media/fal-ai-media', 'gaming/all-out-game-development', 'gaming/gamedev-engine-corpus',
  'software-development/compile-build-spec', 'software-development/design-md-drift-guard', 'software-development/destructive-op-guard',
  'software-development/gauntlet-loop', 'devops/n8n-setup', 'finance/daily-top5-advisor', 'finance/strategy-scout'];

test('qdrant-corpus: hashed BM25 sparse vectors are deterministic and embeddings need a profile key', async () => {
  expect(bm25Tokenize('The Scene tree of a Godot project')).toEqual(['scene', 'tree', 'godot', 'project']);
  const a = buildSparseVector('signals signals and nodes');
  expect(a).toEqual(buildSparseVector('signals signals and nodes'));
  expect(a.indices).toHaveLength(2);
  expect(a.values.sort()).toEqual([Math.log(2), Math.log(3)].sort());
  expect(a.indices.every((index) => index >= 0 && index < 1 << 20)).toBe(true);
  await expect(embeddings('x', {})).rejects.toThrow('OPENAI_API_KEY not set');
});

test('gaming corpus skills: help probes succeed and an engine dry run is offline and credential-free', () => {
  for (const script of ['all-out-game-development/scripts/check-corpus.ts', 'all-out-game-development/scripts/query.ts',
    'all-out-game-development/scripts/sync-corpus.ts', 'gamedev-engine-corpus/scripts/ingest-engine-corpus.ts']) {
    expect(bun(skill(`gaming/${script}`), ['--help']).code).toBe(0);
  }
  const checkout = join(root, 'acq');
  mkdirSync(join(checkout, 'godot-docs/tutorials'), { recursive: true });
  mkdirSync(join(checkout, 'godot-docs/classes'), { recursive: true });
  mkdirSync(join(checkout, 'godot-demos/2d/demo'), { recursive: true });
  writeFileSync(join(checkout, 'godot-docs/tutorials/signals.rst'), `Using signals\n=============\n\n${'Signals let nodes react to events. '.repeat(10)}\n`);
  writeFileSync(join(checkout, 'godot-docs/classes/class_node.rst'), `Node\n====\n\n${'Base class for all scene objects. '.repeat(10)}\n`);
  writeFileSync(join(checkout, 'godot-demos/2d/demo/player.gd'), `extends CharacterBody2D\n\n${'# move the player with input\n'.repeat(10)}`);
  const dry = bun(skill('gaming/gamedev-engine-corpus/scripts/ingest-engine-corpus.ts'), ['--engine', 'godot', '--checkout-root', checkout, '--dry-run'],
    { QDRANT_URL: 'http://127.0.0.1:9' });
  expect(dry.code).toBe(0);
  const summary = JSON.parse(dry.stdout);
  expect(summary).toMatchObject({ engine: 'godot', collection: 'godot-game-development', documents: 3, chunks: 3, dryRun: true });
  expect(summary.counts).toEqual({ 'godotengine/godot-docs:docs': 1, 'godotengine/godot-docs:api': 1, 'godotengine/godot-demo-projects:code': 1 });
});

test('compile-build-spec: its own suite passes and review --dry-run calls no model', () => {
  const suite = run(process.execPath, ['test', skill('software-development/compile-build-spec/scripts/spec-tool.test.ts')]);
  expect(suite.code).toBe(0);
  expect(suite.stderr).toContain(' 0 fail');
});

test('design-md-drift-guard: audit, mechanical heal and plan-only digest stay under the profile state dir', () => {
  const site = join(root, 'work/site');
  mkdirSync(site, { recursive: true });
  // oklch(0.5753 0.1904 259.53) renders to #2973E7, one RGB unit from the declared #2A73E7, so "primary"
  // is mechanical drift; "accent" is clean.
  writeFileSync(join(site, 'DESIGN.md'), '---\nname: Example\ncolors:\n  primary: "#2A73E7"\n  accent: "#FF5722"\n---\n# Example\n');
  writeFileSync(join(site, 'index.css'), ':root {\n  --primary: oklch(0.5753 0.1904 259.53);\n  --accent: #FF5722;\n}\n');
  const scripts = skill('software-development/design-md-drift-guard/scripts');
  const before = files(skill('software-development/design-md-drift-guard'));
  const extra = { DESIGN_DRIFT_LINT: 'off' };

  expect(bun(join(scripts, 'drift-guard.ts'), ['--json'], extra).code).toBe(2); // no projects config yet
  const config = join(root, 'data/config/design-md-drift-guard');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'projects.json'), JSON.stringify({ projects: [{ slug: 'ex', name: 'Example', designMd: join(site, 'DESIGN.md'), siteCss: [join(site, 'index.css')] }] }));

  const guard = bun(join(scripts, 'drift-guard.ts'), ['--json'], extra);
  expect(guard.code).toBe(0);
  expect(JSON.parse(guard.stdout).results[0].drift.declaredOnly).toEqual([{ token: 'primary', hex: '#2A73E7' }]);

  const digest = bun(join(scripts, 'orchestrate.ts'), [], extra);
  expect(digest.code).toBe(0);
  expect(digest.stdout).toContain('plan-only run');
  expect(readFileSync(join(site, 'index.css'), 'utf8')).toContain('oklch('); // default run changes nothing

  const heal = bun(join(scripts, 'auto-heal.ts'), ['--apply', '--json'], extra);
  expect(heal.code).toBe(0);
  expect(JSON.parse(heal.stdout).plans[0].edits).toHaveLength(1);
  expect(readFileSync(join(site, 'index.css'), 'utf8')).toContain('--primary: #2A73E7;');

  const reports = files(join(root, 'data/state/design-md-drift-guard/reports'));
  expect(reports.some((name) => name.startsWith('drift-'))).toBe(true);
  expect(reports.some((name) => name.startsWith('orchestrate-'))).toBe(true);
  expect(files(skill('software-development/design-md-drift-guard'))).toEqual(before);

  const scan = bun(join(scripts, 'pii-leak-scan.ts'), ['--json']);
  expect(scan.code).toBe(0);
});

test('destructive-op-guard: a destructive terminal command yields one next-turn reminder; benign commands none', () => {
  const hook = skill('software-development/destructive-op-guard/scripts/post-destructive-sweep-hook.sh');
  const post = (command: string) => run('bash', [hook], {}, JSON.stringify({ hook_event_name: 'post_tool_call', tool_name: 'terminal', tool_input: { command }, session_id: 's-1' }));
  const pre = () => run('bash', [hook], {}, JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: 's-1' }));

  expect(post('ls -la').stdout).toBe('');
  expect(pre().stdout).toBe('');
  expect(post('terraform destroy -auto-approve').code).toBe(0);
  const reminder = JSON.parse(pre().stdout);
  expect(reminder.context).toContain('terraform destroy');
  expect(reminder.context).toContain('sweep-refs.sh');
  expect(pre().stdout).toBe(''); // delivered once
  expect(files(join(root, 'data/state/destructive-op-guard'))).toEqual([]);
  expect(run('bash', [hook], {}, JSON.stringify({ hook_event_name: 'post_tool_call', tool_input: { command: 'rm -rf x' }, session_id: '../evil' })).stdout).toBe('');

  const sweep = skill('software-development/destructive-op-guard/scripts/sweep-refs.sh');
  writeFileSync(join(root, 'work/app.json'), '{"host":"old-box-7"}');
  writeFileSync(join(root, 'work/notes.md'), 'old-box-7 retired');
  const hit = run('bash', [sweep, 'old-box-7']);
  expect(hit.code).toBe(1);
  expect(hit.stdout).toContain('[LIVE] app.json');
  expect(hit.stdout).toContain('[doc ] notes.md');
  expect(run('bash', [sweep, 'never-seen-id']).code).toBe(0);
  expect(run('bash', [sweep]).code).toBe(2);
});

test('finance skills: offline suites pass, safety rules ship in the skill text, caps are configured', () => {
  const scripts = skill('finance/daily-top5-advisor/scripts');
  for (const suite of ['test_gates.py', 'test_confidence.py']) {
    const result = run('python3', ['-B', join(scripts, suite)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(' 0 failed');
  }
  expect(run('python3', ['-B', join(scripts, 'shortlist.py'), '--help']).code).toBe(0);
  const gates = JSON.parse(readFileSync(skill('finance/daily-top5-advisor/config/gates.json'), 'utf8'));
  expect(gates.position_sizing.max_single_security_pct).toBe(5);
  expect(gates.position_sizing.sector_flag_pct).toBe(25);
  for (const name of ['finance/daily-top5-advisor', 'finance/strategy-scout']) {
    const text = readFileSync(skill(`${name}/SKILL.md`), 'utf8');
    for (const rule of ['explicit confirmation', '5% cap per security', 'Always a stop-loss', 'Flag concentration', 'Tax impact', 'Log every recommendation']) {
      expect(text).toContain(rule);
    }
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // no recipient address
  }
  const scout = bun(skill('finance/strategy-scout/scripts/scout-data.ts'), ['AAPL']);
  expect(scout.code).toBe(2);
  expect(JSON.parse(scout.stdout)).toMatchObject({ error: true, stage: 'env' });
});

test('fal-ai-media and n8n-setup: no key means a clean failure; the n8n unit is local-only and templated', () => {
  const fal = skill('media/fal-ai-media/scripts/fal-media.ts');
  expect(bun(fal, ['--help']).code).toBe(0);
  const missing = bun(fal, ['generate', '--prompt', 'x', '--output', join(root, 'x.png')]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('FAL_KEY not set');
  const unit = readFileSync(skill('devops/n8n-setup/references/n8n.service'), 'utf8');
  expect(unit).toContain('N8N_LISTEN_ADDRESS=127.0.0.1');
  expect(unit).toContain('@DATA@');
  expect(unit).toContain('EnvironmentFile=@CONF@/n8n.env');
});

test('t6 skills carry no operator brand or persona identity and no host paths', () => {
  // Salted hashes of lowercased tokens, so this test does not itself contain the guarded strings.
  const guarded = new Set(['278767c100fa693178b04b62dd2d55e422a8310420257f5a0deae3bd263eea7b', '67b63f40d0a09e846a315d5fafdbf5826ec09e5b7fe16bc35a57c017d68d8e68', '27a8849a02cd9f5c06dd2a8a1fe101d8676fd42d722a9cdc32d52d6cabe05c83', '73b1869f0b02d0b4fe221d984f1e6422ac0ab70ff6fc0a9783a50828e71bcb1d']);
  const hashToken = (token: string) => createHash('sha256').update(`t6-brand-check:${token}`).digest('hex');
  for (const dir of t6Skills) {
    for (const rel of files(skill(dir))) {
      const path = join(skill(dir), rel);
      if (!rel.includes('.') || rel.endsWith('/')) continue;
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      expect(`${rel}: ${text.match(/\/home\/workspace|\/root\/\.zo_secrets|\/home\/\.z\b|zo\.computer|zo\.space/)?.[0] ?? 'clean'}`).toBe(`${rel}: clean`);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (token) expect(guarded.has(hashToken(token))).toBe(false);
      }
    }
  }
});
