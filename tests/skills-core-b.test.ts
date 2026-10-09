import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bypassRequestFingerprint } from '../skills/zouroboros/zouroboros-governance/scripts/governance.ts';

// Offline end-to-end checks for the t3 core skills (zouroboros umbrella, zouroboros-governance,
// unstuck-lateral): a disposable profile, a fake `hermes`, and no provider credentials or live profile.
const repo = resolve(import.meta.dir, '..');
const skillDir = (name: string) => join(repo, 'skills/zouroboros', name);
const governance = (file: string) => join(skillDir('zouroboros-governance'), 'scripts', file);
const umbrella = join(skillDir('zouroboros'), 'scripts/zouroboros.ts');
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-core-b-'));
  for (const dir of ['work', 'home', 'scratch', 'bin']) mkdirSync(join(root, dir));
  env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'),
  };
  writeFileSync(join(root, 'bin', 'hermes'), '#!/bin/bash\necho "Hermes Agent v0.0.0-test"\n');
  chmodSync(join(root, 'bin', 'hermes'), 0o700);
  expect(run(join(repo, 'integration/cli.ts'), ['init', '--workspace', join(root, 'work')]).code).toBe(0);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(script: string, args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: root, env: { ...env, ...extra }, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const change = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  operation: 'evolve-routing-policy', description: 'Replace one routing rule', targetFiles: ['config/routing.json'],
  modifiesModelWeights: false, reversible: true, rollbackPlan: 'Revert the commit', blastRadius: 'local', humanApproved: false,
  provenance: { rationale: 'Lower failure rate', evidence: ['eval/report.json'], actor: 'autoloop' },
  budgetBounded: true, layerIntegrity: true, failClosed: true, ...overrides,
});

test('zouroboros-governance verifies the shipped documents and an optional workspace mirror', () => {
  const docs = run(governance('constitution-gate.ts'), ['verify-docs']);
  expect(docs.code).toBe(0);
  const report = JSON.parse(docs.stdout);
  expect(report.canonicalRoot).toBe(join(skillDir('zouroboros-governance'), 'references'));
  expect(report.documents.map((d: { mirrorMode: string }) => d.mirrorMode)).toEqual(['not-configured', 'not-configured']);

  const mirror = join(root, 'work');
  for (const name of ['ZOUROBOROS.md', 'CONSTITUTION.md']) symlinkSync(join(report.canonicalRoot, name), join(mirror, name));
  expect(run(governance('constitution-gate.ts'), ['verify-docs'], { ZOUROBOROS_GOVERNANCE_MIRROR_DIR: mirror }).code).toBe(0);
  rmSync(join(mirror, 'CONSTITUTION.md'));
  writeFileSync(join(mirror, 'CONSTITUTION.md'), 'drift');
  const drift = run(governance('constitution-gate.ts'), ['verify-docs', '--mirror-root', mirror]);
  expect(drift.code).toBe(2);
  expect(JSON.parse(drift.stdout).violations.map((v: { code: string }) => v.code)).toEqual(['X-DOCUMENT-DRIFT']);
});

test('zouroboros-governance gates changes, fails promotion closed and keeps an anchored ledger in the profile state dir', () => {
  const gate = governance('constitution-gate.ts');
  const allow = run(gate, ['check', '--stdin', '--phase', 'preflight'], {}, change());
  expect(allow.code).toBe(0);
  expect(JSON.parse(allow.stdout).decision).toBe('ALLOW');

  const blocked = run(gate, ['check', '--stdin'], {}, change({ modifiesModelWeights: true, blastRadius: 'shared' }));
  expect(blocked.code).toBe(2);
  expect(JSON.parse(blocked.stdout).violations.map((v: { code: string }) => v.code)).toEqual(['I-FROZEN-WEIGHTS', 'V-HUMAN-AUTHORIZATION']);

  const promotion = run(gate, ['check', '--stdin', '--phase', 'promotion'], {},
    change({ humanApproved: true, verification: { mechanical: true, heldOut: true, consensus: true, regressionFree: true } }));
  expect(promotion.code).toBe(2);
  expect(JSON.parse(promotion.stdout).violations.map((v: { code: string }) => v.code)).toEqual(['IX-PROMOTION-AUTHORITY-UNAVAILABLE']);

  // Three audited decisions, all under the profile's state/config dirs and nowhere in HOME.
  const state = join(root, 'data/state/governance');
  expect(readdirSync(state).sort()).toEqual(['governance-anchor.log', 'governance-audit.log']);
  expect(existsSync(join(root, 'data/config/governance/governance-anchor.key'))).toBe(true);
  for (const dotfile of ['.zouroboros', '.config', '.local']) expect(existsSync(join(root, 'home', dotfile))).toBe(false);
  const verify = run(governance('governance.ts'), ['verify', '--json']);
  expect(verify.code).toBe(0);
  expect(JSON.parse(verify.stdout)).toMatchObject({ ok: true, verdict_count: 3 });

  const guard = run(governance('governance.ts'), ['test-guard']);
  expect(guard.stdout).toContain('Gate rejected write_file');
  expect(JSON.parse(run(governance('governance.ts'), ['blocked-tools', '--json']).stdout).blocked_tools).toContain('terminal');

  appendFileSync(join(state, 'governance-audit.log'), '{"ts":"x","kind":"verdict","payload":{},"prev_hash":"0","this_hash":"0"}\n');
  expect(run(governance('governance.ts'), ['verify']).code).toBe(1);
});

test('zouroboros-governance bypass needs an offline-signed, enrolled, single-use operator authorization', () => {
  const verdict = run(governance('governance.ts'), ['verdict', '--kind', 'manual', '--label', 'demo', '--verdict', 'BLOCK', '--json']);
  const verdictId = JSON.parse(verdict.stdout.split('\n')[0]!).verdict_id as string;
  const auth = governance('operator-authorization.ts');
  const operatorDevice = { HERMES_ZOUROBOROS_HOME: join(root, 'operator-device') };

  // Private-key operations refuse on the agent host and inside an agent session.
  expect(run(auth, ['generate', '--authority', 'operator-v1', '--output-dir', join(root, 'keys')]).stderr).toContain('prohibited on the agent host');
  expect(run(auth, ['generate', '--authority', 'operator-v1', '--output-dir', join(root, 'keys')], { ...operatorDevice, HERMES_SESSION_ID: 's' }).code).toBe(1);
  expect(run(auth, ['generate', '--authority', 'operator-v1', '--output-dir', join(root, 'keys')], operatorDevice).code).toBe(0);
  expect(run(auth, ['enroll', '--authority', 'operator-v1', '--public-key', join(root, 'keys/operator-v1.public.pem')], { HERMES_SESSION_ID: 's' }).code).toBe(1);
  const enrolled = run(auth, ['enroll', '--authority', 'operator-v1', '--public-key', join(root, 'keys/operator-v1.public.pem')]);
  expect(enrolled.stdout.trim()).toBe(join(root, 'data/config/governance/approval-authorities.json'));

  const reason = 'operator accepted the risk';
  const fingerprint = bypassRequestFingerprint(verdictId, reason);
  expect(run(auth, ['request', '--actor', 'agent', '--action', 'governance.bypass', '--resource', verdictId, '--fingerprint', fingerprint,
    '--scope', 'governance.bypass', '--authority', 'operator-v1', '--output', join(root, 'req.json')]).code).toBe(0);
  expect(run(auth, ['sign', '--request', join(root, 'req.json'), '--private-key', join(root, 'keys/operator-v1.private.pem'),
    '--output', join(root, 'auth.json')], operatorDevice).code).toBe(0);

  const bypass = ['bypass', '--target', verdictId, '--reason', reason, '--actor', 'agent', '--authorization', join(root, 'auth.json'), '--json'];
  expect(run(governance('governance.ts'), ['bypass', '--target', verdictId, '--reason', 'other', '--actor', 'agent', '--authorization', join(root, 'auth.json')]).code).toBe(1);
  expect(run(governance('governance.ts'), bypass).code).toBe(0);
  expect(run(governance('governance.ts'), bypass).code).toBe(1);
  expect(JSON.parse(run(governance('governance.ts'), ['verify', '--json']).stdout)).toMatchObject({ ok: true, bypass_count: 1 });
});

test('zouroboros-governance own tests pass and capability-ethics scans the distribution tree', () => {
  const own = Bun.spawnSync(['bun', 'test', join(skillDir('zouroboros-governance'), 'scripts')], { cwd: repo, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  expect(own.exitCode).toBe(0);
  expect(own.stderr.toString()).toMatch(/\b15 pass\b/);
  const ethics = JSON.parse(run(governance('capability-ethics.ts'), []).stdout);
  expect(ethics.skills_dir).toBe(join(repo, 'skills'));
  expect(ethics.skills.find((s: { slug: string }) => s.slug === 'zouroboros-governance')).toMatchObject({ has_governance_md: true });
  expect(ethics.rollup.total).toBeGreaterThan(20);
});

test('zouroboros umbrella: doctor, skill index and exact read-only shortcuts against the profile', () => {
  const doctor = run(umbrella, ['doctor']);
  expect(doctor.code).toBe(0);
  expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, checks: { profile: true, governingDocuments: true, skills: true } });

  const names = JSON.parse(run(umbrella, ['skills', '--json']).stdout).map((s: { name: string }) => s.name);
  expect(names).toEqual(expect.arrayContaining(['zouroboros', 'zouroboros-governance', 'unstuck-lateral', 'zo-memory-system']));

  expect(JSON.parse(run(umbrella, ['shortcut', '/governance verify']).stdout).ok).toBe(true);
  const zmem = join(skillDir('zo-memory-system'), 'scripts/zmem.ts');
  // A hostile inherited memory DB is ignored: the shortcut reads the profile database only.
  const hostile = { ZO_MEMORY_DB: join(root, 'host.db'), ZOUROBOROS_MEMORY_DB: join(root, 'host2.db') };
  expect(run(zmem, ['store', '--entity', 'project.widgets', '--value', 'Use copper widgets']).code).toBe(0);
  expect(run(umbrella, ['shortcut', 'search memory for copper'], hostile).stdout).toContain('Use copper widgets');
  expect(existsSync(hostile.ZO_MEMORY_DB)).toBe(false);
  expect(JSON.parse(run(umbrella, ['shortcut', 'swarm status']).stdout)[0]).toMatchObject({ id: 'hermes-vps', ok: true });

  for (const phrase of ['/doctor --fix', 'fix everything', '/memory search']) {
    const refused = run(umbrella, ['shortcut', phrase]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).status).toBe('no-op');
  }
});

test('unstuck-lateral ships all five perspectives and no Zo persona switching', () => {
  const skill = readFileSync(join(skillDir('unstuck-lateral'), 'SKILL.md'), 'utf8');
  for (const name of ['hacker', 'researcher', 'simplifier', 'architect', 'contrarian']) {
    expect(skill).toContain(`references/${name}.md`);
    expect(existsSync(join(skillDir('unstuck-lateral'), 'references', `${name}.md`))).toBe(true);
  }
  expect(skill).not.toMatch(/\bZo\b|IDENTITY\//);
  expect(skill).toContain('## Limits');
});

test('autoloop program template parses with the intended units', () => {
  const project = join(root, 'work');
  const template = readFileSync(join(skillDir('autoloop'), 'templates/program.md'), 'utf8')
    .replace('{One sentence: what are we optimizing? e.g., "Minimize validation loss for the classifier prompt."}', 'Minimize x.')
    .replace(/- \*\*name\*\*: .*/, '- **name**: x').replace(/- \*\*direction\*\*: .*/, '- **direction**: lower_is_better')
    .replace(/- \*\*extract\*\*: .*/, '- **extract**: `cat x`')
    .replace(/## Target File\n.*\n/, '## Target File\nx.txt\n')
    // Non-default values prove the template's lines parse (the parser's fallbacks equal the template defaults).
    .replace('**Max experiments**: 100', '**Max experiments**: 42').replace('**Max duration**: 8 (hours)', '**Max duration**: 3 (hours)')
    .replace('**Max cost**: 10.00 (USD)', '**Max cost**: 7.5 (USD)');
  writeFileSync(join(project, 'program.md'), template);
  writeFileSync(join(project, 'x.txt'), '1');
  const dry = run(join(skillDir('autoloop'), 'scripts/autoloop.ts'), ['--program', join(project, 'program.md'), '--dry-run']);
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain('Limits: 42 experiments, 3h, $7.5');
});
