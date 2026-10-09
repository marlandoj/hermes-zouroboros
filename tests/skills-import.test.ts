import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { author, importFile, rehash, verify } from '../scripts/import-skill.ts';
import { checkParity, loadParity, renderParity, type ParityManifest } from '../scripts/ci/skills-parity.ts';
import { loadSkillsManifest } from '../scripts/lib/skill-provenance.ts';
import { sha256 } from '../scripts/lib/leak-rules.ts';

const repo = resolve(import.meta.dir, '..');
let scratch = '', source = '', root = '', revision = '';

function put(base: string, path: string, content: string) {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}
const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const add = (file: string, dest: string) => importFile({ root, source, skill: 'demo', file, dest });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'skill-import-test-'));
  source = join(scratch, 'source');
  root = join(scratch, 'dist');
  put(source, 'Skills/demo/SKILL.md', '---\nname: demo\ndescription: "Demo."\n---\n\n# Demo\n');
  put(source, 'Skills/demo/scripts/run.ts', 'console.log("demo");\n');
  put(source, 'Skills/demo/data/feedback.jsonl', '{"fixture":true}\n');
  put(source, 'Skills/other/SKILL.md', '---\nname: other\ndescription: "Other."\n---\n');
  symlinkSync('SKILL.md', join(source, 'Skills/demo/link.md'));
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'add', '-A');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
  revision = git('rev-parse', 'HEAD');
  put(source, 'Skills/demo/untracked.md', 'not committed\n');
  mkdirSync(join(root, 'provenance'), { recursive: true });
  copyFileSync(join(repo, 'provenance/leak-gate.json'), join(root, 'provenance/leak-gate.json'));
  put(root, 'provenance/skills.json', JSON.stringify({ schema: 'hermes-zouroboros/skill-provenance/v1', source: 'fixture', sourceRevision: revision, files: [] }));
  const entry = (name: string) => ({ name, nameSha256: sha256(name), trackedAtRevision: true, triage: 'portable', disposition: 'pending', plannedDisposition: 'portable', reason: 'Fixture.' });
  put(root, 'provenance/skills-parity.json', JSON.stringify({ schema: 'hermes-zouroboros/skills-parity/v1', sourceRevision: revision, sourceRoot: 'Skills', total: 2, entries: [entry('demo'), entry('other')] }));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test('imports one allowlisted file at the pinned revision and records both hashes', () => {
  const entry = add('SKILL.md', 'skills/testing/demo/SKILL.md');
  const content = readFileSync(join(root, 'skills/testing/demo/SKILL.md'));
  expect(entry).toEqual({ path: 'skills/testing/demo/SKILL.md', skill: 'demo', sourcePath: 'Skills/demo/SKILL.md', sourceRevision: revision,
    sourceSha256: sha256(content), distributedSha256: sha256(content), adaptation: 'verbatim' });
  expect(loadSkillsManifest(join(root, 'provenance/skills.json')).files).toEqual([entry]);
  expect(verify(root, loadSkillsManifest(join(root, 'provenance/skills.json')), source)).toEqual([]);
  expect(() => add('SKILL.md', 'skills/testing/demo/SKILL.md')).toThrow('already has a provenance entry');
});

test('refuses blocked, untracked, symlinked and escaping paths', () => {
  expect(() => add('data/feedback.jsonl', 'skills/testing/demo/data/feedback.jsonl')).toThrow('Refusing blocked');
  expect(() => add('untracked.md', 'skills/testing/demo/untracked.md')).toThrow('not tracked');
  expect(() => add('link.md', 'skills/testing/demo/link.md')).toThrow('not a regular file');
  expect(() => add('../other/SKILL.md', 'skills/testing/demo/x.md')).toThrow('must stay under');
  expect(() => add('SKILL.md', 'packages/demo/SKILL.md')).toThrow('must stay under skills/');
  expect(() => importFile({ root, source, skill: 'unknown', file: 'SKILL.md', dest: 'skills/testing/unknown/SKILL.md' })).toThrow('Unknown source skill');
  expect(loadSkillsManifest(join(root, 'provenance/skills.json')).files).toEqual([]);
});

test('adaptations need a note and verification catches tampering', () => {
  add('scripts/run.ts', 'skills/testing/demo/scripts/run.ts');
  put(root, 'skills/testing/demo/scripts/run.ts', 'console.log("adapted");\n');
  expect(verify(root, loadSkillsManifest(join(root, 'provenance/skills.json')))).toEqual(['skills/testing/demo/scripts/run.ts: distributed sha256 mismatch']);
  expect(() => rehash(root, 'skills/testing/demo/scripts/run.ts', 'verbatim')).toThrow('adaptation note');
  const entry = rehash(root, 'skills/testing/demo/scripts/run.ts', 'Print a portable message.');
  expect(entry.sourceSha256).not.toBe(entry.distributedSha256);
  expect(verify(root, loadSkillsManifest(join(root, 'provenance/skills.json')), source)).toEqual([]);
  put(root, 'skills/README.md', '# Skills\n');
  expect(author(root, 'skills/README.md', 'Distribution index.').sourcePath).toBeNull();
});

test('parity check fails when a source entry is missing and reports counts', () => {
  const manifestPath = join(root, 'provenance/skills-parity.json');
  const manifest = loadParity(manifestPath);
  put(root, 'docs/SKILLS-PARITY.md', renderParity(manifest));
  expect(checkParity(root, manifest, source).problems).toEqual([]);
  expect(checkParity(root, manifest, source).counts.pending).toBe(2);
  const missing: ParityManifest = { ...manifest, entries: manifest.entries.slice(0, 1) };
  put(root, 'docs/SKILLS-PARITY.md', renderParity(missing));
  expect(checkParity(root, missing, source).problems).toEqual([
    'manifest lists 1 entries but total is 2',
    'other: source entry missing from parity manifest',
  ]);
  const shipped: ParityManifest = { ...manifest, entries: manifest.entries.map((entry) => entry.name === 'demo' ? { ...entry, disposition: 'portable', distributedAs: ['skills/testing/demo'] } : entry) };
  put(root, 'docs/SKILLS-PARITY.md', renderParity(shipped));
  expect(checkParity(root, shipped).problems).toEqual(['demo: distributedAs skills/testing/demo has no SKILL.md']);
  expect(checkParity(root, manifest).problems).toEqual(['docs/SKILLS-PARITY.md is out of date; run: bun scripts/ci/skills-parity.ts render']);
});

test('repository parity manifest covers every source entry with a reason', () => {
  const manifest = loadParity();
  expect(manifest.entries.length).toBe(manifest.total);
  expect(checkParity(repo, manifest).problems).toEqual([]);
});
