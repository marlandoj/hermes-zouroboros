import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ux-laws (g1): run the skill's own offline suite; it writes only to its own temporary directories.
const repo = resolve(import.meta.dir, '..');

test('ux-laws ships with its own passing test suite', () => {
  const run = spawnSync('bun', ['test', join(repo, 'skills/software-development/ux-laws/scripts/ux-laws.test.ts')],
    { encoding: 'utf8', cwd: repo });
  expect(run.status).toBe(0);
  expect(`${run.stdout}${run.stderr}`).toContain(' 0 fail');
}, 120_000);

test('ux-laws carries no CC BY-NC-ND source line, no host paths and the MIT licence', () => {
  const dir = join(repo, 'skills/software-development/ux-laws');
  const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  expect(skillMd).toContain('\nlicense: MIT\n');
  expect(skillMd).not.toMatch(/^\s*author:/m);
  for (const rel of readdirSync(dir, { recursive: true }).map(String).filter((rel) => rel.includes('.'))) {
    const text = readFileSync(join(dir, rel), 'utf8');
    expect(`${rel}: ${text.match(/BY-NC-ND|lawsofux\.com|\/home\/workspace|\/home\/\.z\b|zo\.computer|zo\.space|\/dev\/shm\//)?.[0] ?? 'clean'}`).toBe(`${rel}: clean`);
  }
});
