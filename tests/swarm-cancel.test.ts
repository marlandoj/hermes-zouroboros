import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from '../integration/profile.ts';

// Regression for assessment D-01: SIGTERM/SIGINT to `cli.ts swarm` must stop the swarm worker and
// every Hermes child it started, start no further task, and only then exit non-zero. A fake Hermes
// on PATH stands in for the real one, so no model is called.
function processesMentioning(tag: string): number[] {
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,args='], { stdout: 'pipe' }).stdout.toString();
  return ps.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    return m && m[2]!.includes(tag) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}

function taskStarts(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter(l => l.trim() && !l.includes('--version')).length;
}

describe('swarm cancellation', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} stops the worker and its Hermes children before the CLI exits`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'hz-swarm-cancel-'));
      const log = join(root, 'invocations.log');
      try {
        mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'data')); mkdirSync(join(root, 'work'));
        const fake = join(root, 'bin', 'hermes');
        writeFileSync(fake, `#!/usr/bin/env bash\necho "$$ $*" >> "${log}"\n[[ "$1" == "--version" ]] && { echo "Hermes Agent fake"; exit 0; }\nsleep 25; echo FAKE_DONE\n`);
        chmodSync(fake, 0o755);
        const env = {
          HOME: root,
          PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HERMES_ZOUROBOROS_HOME: join(root, 'data'),
          HERMES_ZOUROBOROS_ALLOW_SWARM: '1',
        };
        const init = Bun.spawnSync([process.execPath, join(repoRoot, 'integration/cli.ts'), 'init', '--workspace', join(root, 'work')], { env, stdout: 'pipe', stderr: 'pipe' });
        expect(init.exitCode).toBe(0);
        const tasks = join(root, 'work', 'tasks.json');
        writeFileSync(tasks, JSON.stringify([
          { id: 'a', task: 'step a', timeoutSeconds: 60 },
          { id: 'b', task: 'step b', dependsOn: ['a'], timeoutSeconds: 60 },
        ]));
        const cli = Bun.spawn([process.execPath, join(repoRoot, 'integration/cli.ts'), 'swarm', tasks], { env, stdout: 'pipe', stderr: 'pipe' });
        for (let i = 0; i < 300 && taskStarts(log) === 0; i++) await Bun.sleep(100);
        expect(taskStarts(log)).toBe(1);

        cli.kill(signal);
        const exit = await Promise.race([cli.exited, Bun.sleep(20000).then(() => 'timeout' as const)]);
        expect(exit).not.toBe('timeout');
        expect(exit).not.toBe(0);
        expect(processesMentioning(root)).toEqual([]);
        await Bun.sleep(2000);
        expect(processesMentioning(root)).toEqual([]);
        expect(taskStarts(log)).toBe(1);
      } finally {
        for (const pid of processesMentioning(root)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        rmSync(root, { recursive: true, force: true });
      }
    }, 60000);
  }
});
