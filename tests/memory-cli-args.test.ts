import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../integration/profile.ts';

// Regression for assessment D-02: `zouroboros memory <subcommand> …` used to join its arguments
// into an execSync string, so shell metacharacters in an argument ran as commands. Arguments must
// reach the subcommand verbatim, without a shell.
const cli = join(repoRoot, 'packages/memory/dist/cli.js');

function run(dir: string, args: string[]) {
  return Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('memory CLI subcommand arguments', () => {
  for (const [name, payload] of [
    ['semicolon', 'x; touch MARK'],
    ['command substitution', '$(touch MARK)'],
    ['backticks', '`touch MARK`'],
  ] as const) {
    test(`${name} in an argument is not executed`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'hz-cli-args-'));
      try {
        const payloadAbs = payload.replace('MARK', join(dir, 'MARKER'));
        run(dir, ['defense', 'scan', '--text', payloadAbs]);
        expect(existsSync(join(dir, 'MARKER'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('an argument with spaces and quotes arrives intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-cli-args-'));
    try {
      const result = run(dir, ['defense', 'scan', '--text', `it's a "plain" note`]);
      expect(result.stderr.toString()).not.toContain('failed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('No findings.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
