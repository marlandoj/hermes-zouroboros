import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// Bundle integrity for the Zouroboros closed loop: introspect (platform assessment) → prescribe →
// evolve → verify, plus the orchestrator. The five skills only work together, so a missing skill,
// script or held-out probe must fail CI here rather than at run time.
const repo = resolve(import.meta.dir, '..');
const zdir = join(repo, 'skills/zouroboros');
const BUNDLE = ['zouroboros-platform-assessment', 'zouroboros-loop', 'zouroboros-loop-prescribe', 'zouroboros-loop-evolve', 'zouroboros-loop-verify'];

function meta(skill: string): Record<string, any> {
  const text = readFileSync(join(zdir, skill, 'SKILL.md'), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${skill}: missing frontmatter`);
  return parse(match[1]!);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === '__pycache__' ? [] : files(path)) : [path];
  });
}

test('all five loop skills ship with frontmatter whose name matches the directory', () => {
  for (const skill of BUNDLE) {
    expect(existsSync(join(zdir, skill, 'SKILL.md'))).toBe(true);
    const m = meta(skill);
    expect(m.name).toBe(skill);
    expect(typeof m.license).toBe('string');
    expect(m.metadata?.hermes?.tags?.length).toBeGreaterThan(0);
  }
});

test('related_skills within the bundle resolve to shipped skills', () => {
  for (const skill of BUNDLE) {
    for (const related of meta(skill).metadata?.hermes?.related_skills ?? []) {
      if (related.startsWith('zouroboros-loop') || related === 'zouroboros-platform-assessment') {
        expect(BUNDLE, `${skill} -> ${related}`).toContain(related);
      }
    }
  }
});

test('every cross-skill script path referenced by a loop script exists', () => {
  const ref = /(?:\.\.\/){1,2}(zouroboros-[a-z-]+)\/(scripts|heldout)\/([A-Za-z0-9_./-]+\.(?:py|sh|ts|json))/g;
  for (const skill of BUNDLE) {
    for (const file of files(join(zdir, skill)).filter((f) => /\.(py|sh|ts)$/.test(f))) {
      for (const m of readFileSync(file, 'utf8').matchAll(ref)) {
        expect(existsSync(join(zdir, m[1]!, m[2]!, m[3]!)), `${file.slice(repo.length + 1)} -> ${m[0]}`).toBe(true);
      }
    }
  }
});

test('held-out catalog probes and harness scripts it names exist', () => {
  const catalog = JSON.parse(readFileSync(join(zdir, 'zouroboros-loop-verify/heldout/catalog.json'), 'utf8'));
  const cmds = Object.values(catalog.classes as Record<string, { checks: { cmd: string }[] }>).flatMap((c) => c.checks.map((x) => x.cmd));
  for (const cmd of cmds) {
    for (const m of cmd.matchAll(/\{skills\}\/zouroboros\/([A-Za-z0-9_./-]+)/g)) expect(existsSync(join(zdir, m[1]!)), m[0]).toBe(true);
    for (const m of cmd.matchAll(/\$P\/([A-Za-z0-9_.-]+)/g)) expect(existsSync(join(zdir, 'zouroboros-loop-verify/heldout/probes', m[1]!)), m[0]).toBe(true);
  }
  expect(Object.keys(catalog.classes)).toEqual(expect.arrayContaining(['concurrency', 'shell-injection', 'cancellation', 'mcp-contract']));
});

test('loop shell scripts are syntactically valid', () => {
  for (const skill of BUNDLE) {
    for (const file of files(join(zdir, skill)).filter((f) => f.endsWith('.sh'))) {
      const run = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(run.status, `${file}: ${run.stderr}`).toBe(0);
    }
  }
});

test('loop path resolution finds this checkout and never defaults into it', () => {
  const run = spawnSync('python3', ['-B', '-c', 'import loop_paths as p, json; print(json.dumps({"checkout": p.CHECKOUT, "loop": p.LOOP_HOME, "protected": p.PROTECTED}))'],
    { cwd: join(zdir, 'zouroboros-loop/scripts'), encoding: 'utf8', env: { ...process.env, ZO_LOOP_HOME: '', ZOUROBOROS_STATE_DIR: '/tmp/zo-state-test' } });
  expect(run.status, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout);
  expect(out.checkout).toBe(repo);
  expect(out.protected).toContain(repo);
  expect(out.loop.startsWith(repo)).toBe(false);
});

for (const [skill, suite] of [['zouroboros-loop', 'ledger, check runner'], ['zouroboros-loop-prescribe', 'governor, prescription validator'], ['zouroboros-loop-verify', 'tamper check']] as const) {
  test(`${skill} unit suite passes (${suite})`, () => {
    const run = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests'], { cwd: join(zdir, skill, 'scripts'), encoding: 'utf8', timeout: 120_000 });
    expect(run.status, run.stderr.slice(-2000)).toBe(0);
  }, 150_000);
}
