import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGate } from '../scripts/ci/leak-gate.ts';
import { sha256 } from '../scripts/lib/leak-rules.ts';

// Fixtures are generated at runtime and assembled from fragments so this source file never holds
// a host path, secret-shaped value or denylisted token that the gate would (rightly) flag.
const repo = resolve(import.meta.dir, '..');
const hostPath = ['', 'home', 'work' + 'space', 'Skills', 'demo'].join('/');
const fakeAwsKey = 'AKIA' + 'FAKE'.repeat(4);
const cleanSkill = '---\nname: demo-skill\ndescription: "Demo skill fixture."\nversion: 0.0.1\nmetadata:\n  hermes:\n    tags: [test]\n---\n\n# Demo\n\nUse `$HERMES_ZOUROBOROS_HOME/state` for state.\n';
let root = '';

function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function provenance(paths: string[]) {
  const files = paths.map((path) => ({ path, skill: null, sourcePath: null, sourceRevision: null, sourceSha256: null,
    distributedSha256: sha256(readFileSync(join(root, path))), adaptation: 'Test fixture.' }));
  write('provenance/skills.json', JSON.stringify({ schema: 'hermes-zouroboros/skill-provenance/v1', source: 'test', sourceRevision: 'test', files }));
}
const gate = () => runGate({ root, gitleaks: false, baselinePath: false });
const rules = () => gate().findings.map((finding) => `${finding.rule} ${finding.file}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leak-gate-test-'));
  mkdirSync(join(root, 'provenance'));
  copyFileSync(join(repo, 'provenance/leak-gate.json'), join(root, 'provenance/leak-gate.json'));
  write('skills/testing/demo-skill/SKILL.md', cleanSkill);
  provenance(['skills/testing/demo-skill/SKILL.md']);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('passes a clean skill with matching provenance', () => {
  const result = gate();
  expect(result.findings).toEqual([]);
  expect(result.scanned).toBe(3);
});

test('blocks a fake JSONL data file even when provenance lists it', () => {
  write('skills/testing/demo-skill/data/feedback.jsonl', '{"route":"fixture","score":1}\n');
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/data/feedback.jsonl']);
  expect(rules()).toEqual(['blocked-path:extension skills/testing/demo-skill/data/feedback.jsonl']);
  write('skills/testing/demo-skill/.env', 'API_URL=\n');
  expect(rules()).toContain('blocked-path:file-name skills/testing/demo-skill/.env');
});

test('blocks a host path', () => {
  write('skills/testing/demo-skill/SKILL.md', `${cleanSkill}\nRun from ${hostPath}.\n`);
  provenance(['skills/testing/demo-skill/SKILL.md']);
  expect(gate().findings).toEqual([{ kind: 'host-path', rule: 'host-path:host-workspace', file: 'skills/testing/demo-skill/SKILL.md', line: 14 }]);
});

test('blocks a fake secret without echoing its value', () => {
  write('skills/testing/demo-skill/scripts/run.ts', `const key = "${fakeAwsKey}";\n`);
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/scripts/run.ts']);
  const findings = gate().findings;
  expect(findings.map((finding) => finding.rule)).toEqual(['secret:aws-access-key-id']);
  expect(JSON.stringify(findings)).not.toContain(fakeAwsKey);
});

test.skipIf(!process.env.GITLEAKS_BIN)('pinned gitleaks also flags a fake token', () => {
  write('skills/testing/demo-skill/scripts/run.ts', `const token = "${'ghp_' + 'Fx7Qz2Lm9Rk4Tw8Vb3Nc6Hy1Jd5Ps0Ga2Ke7U'}";\n`);
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/scripts/run.ts']);
  const result = runGate({ root, gitleaks: process.env.GITLEAKS_BIN!, baselinePath: false });
  expect(result.gitleaks).toBe('ran');
  expect(result.findings.some((finding) => finding.rule.startsWith('secret:gitleaks:'))).toBe(true);
});

test('blocks a missing provenance entry, a hash mismatch and a stale entry', () => {
  write('skills/testing/demo-skill/references/notes.md', '# Notes\n');
  expect(rules()).toEqual(['provenance:missing-entry skills/testing/demo-skill/references/notes.md']);
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/references/notes.md']);
  write('skills/testing/demo-skill/references/notes.md', '# Notes, edited after hashing\n');
  expect(rules()).toEqual(['provenance:sha256-mismatch skills/testing/demo-skill/references/notes.md']);
  rmSync(join(root, 'skills/testing/demo-skill/references'), { recursive: true });
  expect(rules()).toEqual(['provenance:stale-entry skills/testing/demo-skill/references/notes.md']);
});

test('flags hashed denylist tokens, personal email addresses and phone numbers', () => {
  const config = JSON.parse(readFileSync(join(root, 'provenance/leak-gate.json'), 'utf8'));
  config.personalData.hashes = [{ label: 'fixture-person', sha256: sha256(`${config.personalData.salt}zzfixtureperson`) }];
  write('provenance/leak-gate.json', JSON.stringify(config));
  write('docs/a.md', 'Owner: zzfixtureperson (see owner-zzfixtureperson-profile)\n');
  write('docs/b.md', `Contact ${'someone'}@${'mailbox.test'} or ${'602'}-${'555'}-${'0142'}\n`);
  write('docs/c.md', 'Contact user@example.com or noreply@anthropic.com.\n');
  expect(rules().sort()).toEqual(['personal-data:email-address docs/b.md', 'personal-data:fixture-person docs/a.md', 'personal-data:phone-number docs/b.md']);
});

test('reviewed exceptions are pinned to content', () => {
  write('skills/testing/demo-skill/.env.template', 'SERVICE_API_KEY=\n');
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/.env.template']);
  const config = JSON.parse(readFileSync(join(root, 'provenance/leak-gate.json'), 'utf8'));
  config.reviewedExceptions = [{ path: 'skills/testing/demo-skill/.env.template', sha256: sha256('SERVICE_API_KEY=\n'), rules: ['blocked-path'], reason: 'Empty placeholder template.' }];
  write('provenance/leak-gate.json', JSON.stringify(config));
  expect(gate().findings).toEqual([]);
  write('skills/testing/demo-skill/.env.template', 'SERVICE_API_KEY=filled-in-value\n');
  provenance(['skills/testing/demo-skill/SKILL.md', 'skills/testing/demo-skill/.env.template']);
  expect(rules()).toContain('blocked-path:file-name skills/testing/demo-skill/.env.template');
});

test('baseline grandfathers existing package occurrences by count but never skills/', () => {
  write('packages/legacy/run.sh', `cd ${hostPath}\n`);
  write('provenance/leak-gate-baseline.json', JSON.stringify({ schema: 'hermes-zouroboros/leak-gate-baseline/v1', note: '', entries: [{ file: 'packages/legacy/run.sh', rule: 'host-path:host-workspace', count: 1 }] }));
  expect(runGate({ root, gitleaks: false }).findings).toEqual([]);
  write('packages/legacy/run.sh', `cd ${hostPath}\nls ${hostPath}\n`);
  expect(runGate({ root, gitleaks: false }).findings.map((finding) => finding.rule)).toEqual(['host-path:host-workspace', 'host-path:host-workspace']);
  write('provenance/leak-gate-baseline.json', JSON.stringify({ schema: 'hermes-zouroboros/leak-gate-baseline/v1', note: '', entries: [{ file: 'skills/testing/demo-skill/SKILL.md', rule: 'host-path:host-workspace', count: 1 }] }));
  expect(() => runGate({ root, gitleaks: false })).toThrow('may not grandfather');
});

// Scanning the whole tree takes several seconds and grows with every ported skill; bun's 5 s
// default made this test flaky on a loaded host.
test('the repository tree passes its own gate', () => {
  const result = runGate({ gitleaks: false });
  expect(result.findings).toEqual([]);
}, 60_000);
