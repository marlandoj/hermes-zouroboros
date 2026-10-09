import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGate } from '../scripts/ci/leak-gate.ts';
import { loadConfig, personalHashes, scanText, sha256 } from '../scripts/lib/leak-rules.ts';

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

// --- Identity, brand and private-network rules (f2) --------------------------------------------
// No denylisted token or private address appears in this file. Real-data checks read the 0.1.0
// release from Git history (CI checks out with fetch-depth 0); fixtures use injected hashes or
// addresses assembled from fragments.
const RELEASE_0_1_0 = 'e8c2b2d';
const atRelease = (path: string) => {
  try { return execFileSync('git', ['-C', repo, 'show', `${RELEASE_0_1_0}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; }
};
const historyAvailable = atRelease('LICENSE') !== undefined;
if (!historyAvailable && process.env.CI) throw new Error('leak-gate tests need full Git history in CI (fetch-depth: 0)');
const realConfig = () => loadConfig(join(repo, 'provenance/leak-gate.json'));
const ruleIds = (text: string, config = realConfig()) => [...new Set(scanText('fixture.txt', text, config).map((finding) => finding.rule))].sort();

test('identity rules are stored as salted hashes, one per persona name and brand', () => {
  const config = realConfig();
  const labels = config.identityData!.hashes.map((entry) => entry.label).sort();
  expect(labels).toEqual(['brand-1', 'brand-2', 'brand-3', 'persona-name-1', 'persona-name-2']);
  for (const entry of config.identityData!.hashes) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(config.identityData!.hashes.map((entry) => entry.sha256)).size).toBe(5);
  // The rule file must not flag itself: it holds no plaintext token.
  expect(ruleIds(readFileSync(join(repo, 'provenance/leak-gate.json'), 'utf8'))).toEqual([]);
});

test.skipIf(!historyAvailable)('the 0.1.0 persona-name default is flagged by persona-name-1', () => {
  expect(ruleIds(atRelease('packages/swarm/src/client/executor-client.ts')!)).toContain('personal-data:persona-name-1');
  expect(ruleIds(atRelease('packages/memory/src/eval-heldout-recall.ts')!)).toContain('personal-data:persona-name-1');
});

test('a recorded source entry name carrying the brand is flagged outside provenance (brand-1)', () => {
  const config = realConfig();
  const brand = new Set(config.identityData!.hashes.filter((entry) => entry.label === 'brand-1').map((entry) => entry.sha256));
  const parity = JSON.parse(readFileSync(join(repo, 'provenance/skills-parity.json'), 'utf8')) as { entries: { name: string }[] };
  const branded = parity.entries.map((entry) => entry.name).filter((name) => personalHashes(name, config.personalData.salt).some((hash) => brand.has(hash)));
  expect(branded.length).toBeGreaterThan(0);
  for (const name of branded) expect(ruleIds(`See the ${name} skill.`)).toEqual(['personal-data:brand-1']);
});

test('injected identity hashes flag both persona and brand labels', () => {
  const config = realConfig();
  config.identityData = { hashes: [
    { label: 'persona-name-9', sha256: sha256(`${config.personalData.salt}zzfixturepersona`) },
    { label: 'brand-9', sha256: sha256(`${config.personalData.salt}zzfixturebrand`) },
  ] };
  expect(ruleIds('Ask Zzfixturepersona about the zzfixturebrand screener.', config)).toEqual(['personal-data:brand-9', 'personal-data:persona-name-9']);
  expect(ruleIds('Ask the default persona.', config)).toEqual([]);
});

test('private, CGNAT/tailnet and tailnet IPv6 addresses are flagged; documentation ranges are not', () => {
  const ip = (...parts: (string | number)[]) => parts.join('.');
  const cases: [string, string][] = [
    [ip(10, 20, 30, 40), 'private-network:rfc1918-ipv4'],
    [`${ip(172, 16, 0, 0)}/12`, 'private-network:rfc1918-ipv4'],
    [ip(172, 31, 255, 254), 'private-network:rfc1918-ipv4'],
    [`http://${ip(192, 168, 1, 10)}:8080`, 'private-network:rfc1918-ipv4'],
    [`QDRANT_URL=http://${ip(100, 64, 0, 1)}:6333`, 'private-network:cgnat-tailnet-ipv4'],
    [ip(100, 127, 255, 255), 'private-network:cgnat-tailnet-ipv4'],
    [['fd7a', '115c', 'a1e0', '', '53'].join(':'), 'private-network:tailnet-ipv6'],
    [['FD7A', '115C', 'A1E0', 'ab12', '1'].join(':'), 'private-network:tailnet-ipv6'],
  ];
  for (const [text, rule] of cases) expect(`${text} -> ${ruleIds(text).join(',')}`).toBe(`${text} -> ${rule}`);
  // Reserved documentation ranges (RFC 5737, RFC 3849) and public or loopback addresses pass.
  for (const text of [ip(192, 0, 2, 10), ip(198, 51, 100, 7), ip(203, 0, 113, 10), '2001:db8::1', ip(127, 0, 0, 1), ip(100, 128, 0, 1),
    ip(172, 32, 0, 1), ip(8, 8, 8, 8), 'v' + ip(10, 1, 2, 3), ip(1, 10, 1, 2, 3), 'fd7b:115c:a1e0::1']) {
    expect(`${text} -> ${ruleIds(text).join(',')}`).toBe(`${text} -> `);
  }
});

test.skipIf(!historyAvailable)('the 0.1.0 tailnet Qdrant default is flagged by cgnat-tailnet-ipv4', () => {
  expect(ruleIds(atRelease('packages/swarm/src/rag/enrichment.ts')!)).toContain('private-network:cgnat-tailnet-ipv4');
});

test('private-network findings are blocking and cannot be grandfathered by the baseline', () => {
  write('packages/legacy/config.ts', `export const url = 'http://${[192, 168, 0, 5].join('.')}';\n`);
  expect(rules()).toEqual(['private-network:rfc1918-ipv4 packages/legacy/config.ts']);
  write('provenance/leak-gate-baseline.json', JSON.stringify({ schema: 'hermes-zouroboros/leak-gate-baseline/v1', note: '', entries: [{ file: 'packages/legacy/config.ts', rule: 'private-network:rfc1918-ipv4', count: 1 }] }));
  expect(() => runGate({ root, gitleaks: false })).toThrow('may not grandfather');
});

test('context allowances mask only the recorded context, only in the listed files', () => {
  const config = JSON.parse(readFileSync(join(root, 'provenance/leak-gate.json'), 'utf8'));
  config.personalData.hashes.push({ label: 'operator-name-2', sha256: sha256(`${config.personalData.salt}zzfixtureowner`) });
  config.identityData.hashes.push({ label: 'brand-1', sha256: sha256(`${config.personalData.salt}zzbrand`) });
  write('provenance/leak-gate.json', JSON.stringify(config));
  write('provenance/skills-parity.json', JSON.stringify({ entries: [{ name: 'zzbrand-daily-report' }] }));
  write('README.md', 'Badge: https://github.com/zzfixtureowner/hermes-zouroboros/actions\n');
  write('docs/SKILLS-PARITY.md', '| `zzbrand-daily-report` | renamed |\n');
  expect(rules()).toEqual([]);
  write('README.md', 'Badge: https://github.com/zzfixtureowner/hermes-zouroboros/actions\nMaintained by zzfixtureowner.\n');
  write('docs/SKILLS-PARITY.md', '| `zzbrand-daily-report` | the zzbrand template |\n');
  write('docs/other.md', 'Source entry zzbrand-daily-report.\n');
  expect(rules().sort()).toEqual(['personal-data:brand-1 docs/SKILLS-PARITY.md', 'personal-data:brand-1 docs/other.md', 'personal-data:operator-name-2 README.md']);
});

// Scanning the whole tree takes several seconds and grows with every ported skill; bun's 5 s
// default made this test flaky on a loaded host.
test('the repository tree passes its own gate', () => {
  const result = runGate({ gitleaks: false });
  expect(result.findings).toEqual([]);
}, 60_000);
