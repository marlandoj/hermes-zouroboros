import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(import.meta.dir, '../integration/cli.ts');
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(mode: 'success' | 'failure') {
  const root = mkdtempSync(join(tmpdir(), 'hermes-swarm-test-'));
  fixtures.push(root);
  const workspace = join(root, 'work space');
  const home = join(root, 'home');
  const data = join(root, 'data');
  const scratch = join(root, 'scratch');
  for (const directory of [workspace, home, scratch]) mkdirSync(directory);
  const capture = join(root, 'invocation');
  const hermes = join(root, 'hermes');
  writeFileSync(hermes, `#!/bin/bash
printf '%s\\n' called >> "$FAKE_CAPTURE.calls"
printf '%s\\0' "$@" > "$FAKE_CAPTURE.args"
printf '%s\\n' "$PWD" "$HOME" "$HERMES_HOME" "$ZO_MEMORY_DB" "$SWARM_EXECUTOR_REGISTRY" "$HERMES_ZOUROBOROS_ALLOW_SWARM" "$BASHPID" > "$FAKE_CAPTURE.context"
if [[ "$FAKE_MODE" == failure ]]; then
  printf 'fake-provider-private-diagnostic' >&2
  exit 7
fi
printf 'FAKE_HERMES_OK\\n'
`);
  chmodSync(hermes, 0o700);
  const env: Record<string, string> = {
    // Do not pass operator credentials, model settings, or the live profile.
    PATH: `${root}:/usr/bin:/bin`, HOME: home, TMPDIR: scratch,
    HERMES_BIN: hermes, FAKE_CAPTURE: capture, FAKE_MODE: mode,
    HERMES_ZOUROBOROS_HOME: data, HERMES_ZOUROBOROS_ALLOW_SWARM: '1',
  };
  const run = (args: string[], override: Record<string, string> = {}) => {
    const processResult = Bun.spawnSync([process.execPath, cli, ...args], {
      cwd: root, env: { ...env, ...override }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    return { code: processResult.exitCode, stdout: processResult.stdout.toString(), stderr: processResult.stderr.toString() };
  };
  const init = run(['init', '--workspace', workspace]);
  expect(init.code).toBe(0);
  writeFileSync(join(root, 'tasks.json'), JSON.stringify([{ id: 'probe', task: 'Reply with OK', timeoutSeconds: 10 }]));
  return { root, workspace, home, data, scratch, capture, run };
}

describe('CLI swarm execution through the real orchestrator', () => {
  test.each(['success', 'failure'] as const)('%s preserves isolation and does not select a model or retry', async mode => {
    const f = fixture(mode);
    // Relative input is resolved from the caller before worker cwd changes.
    const execution = f.run(['swarm', 'tasks.json']);
    expect(execution.code).toBe(mode === 'success' ? 0 : 1);
    const summary = JSON.parse(execution.stdout.trim().split('\n').at(-1)!);
    expect(summary.ok).toBe(mode === 'success');
    expect(summary.results).toHaveLength(1);
    const result = summary.results[0];
    expect(result.success).toBe(mode === 'success');
    expect(result.retries).toBe(0);
    expect(result.effectiveExecutor).toBe('hermes-vps');
    if (mode === 'success') expect(result.output).toBe('FAKE_HERMES_OK\n');
    else expect(result.error).toContain('exit 7');
    expect(execution.stdout + execution.stderr).not.toContain('fake-provider-private-diagnostic');

    expect(readFileSync(f.capture + '.args', 'utf8').split('\0')).toEqual(['-z', 'Reply with OK', '']);
    const context = readFileSync(f.capture + '.context', 'utf8').trim().split('\n');
    expect(context.slice(0, 6)).toEqual([
      f.workspace, f.home, join(f.data, 'hermes'), join(f.data, 'memory.db'), join(f.data, 'executors.json'), '0',
    ]);
    expect(existsSync(join(f.data, 'swarm.db'))).toBe(true);
    expect(existsSync(join(f.home, '.hermes'))).toBe(false);
    expect(readdirSync(f.scratch)).toEqual([]);
    // The fake executable has exited; no retries or delayed fake invocations
    // occur after the CLI reports completion.
    expect(() => process.kill(Number(context[6]), 0)).toThrow();
    expect(readFileSync(f.capture + '.calls', 'utf8')).toBe('called\n');
    await Bun.sleep(100);
    expect(readFileSync(f.capture + '.calls', 'utf8')).toBe('called\n');
  }, 20_000);

  test('rejects execution without opt-in before starting the fake agent', () => {
    const f = fixture('success');
    const execution = f.run(['swarm', 'tasks.json'], { HERMES_ZOUROBOROS_ALLOW_SWARM: '0' });
    expect(execution.code).toBe(1);
    expect(execution.stderr).toContain('Execution is opt-in');
    expect(existsSync(f.capture + '.calls')).toBe(false);
    expect(existsSync(join(f.data, 'swarm.db'))).toBe(false);
  });
});
