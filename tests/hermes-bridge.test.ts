import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHermesRegistry } from '../integration/hermes-executor';

const bridge = resolve(import.meta.dir, '../integration/hermes-bridge.sh');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-bridge-test-'));
  dirs.push(root);
  const workdir = join(root, 'work space');
  const scratch = join(root, 'scratch');
  mkdirSync(workdir); mkdirSync(scratch);
  const binary = join(root, 'fake hermes');
  writeFileSync(binary, `#!/usr/bin/env bash
printf '%s\\n' "$PWD" > "$FAKE_CAPTURE.cwd"
printf '%s\\n' "$@" > "$FAKE_CAPTURE.args"
printf '%s\\n' "$HOME" "$HERMES_HOME" > "$FAKE_CAPTURE.home"
printf '%s\\n' "$HERMES_ZOUROBOROS_ALLOW_SWARM" > "$FAKE_CAPTURE.swarm"
usage=''
while [[ $# -gt 0 ]]; do [[ "$1" == --usage-file ]] && usage="$2"; shift; done
failed=false
case "$FAKE_MODE" in provider-error|failed-empty) failed=true ;; esac
[[ -z "$usage" ]] || printf '{"failed": %s}\\n' "$failed" > "$usage"
case "$FAKE_MODE" in
 provider-error) printf 'API error 402: insufficient balance\\n' ;;
 unfunded-exit) printf 'HTTP 402 Payment Required credential-value-must-not-leak' >&2; exit 1 ;;
 answer-mentions-billing) printf 'Error code 402 means insufficient balance.\\n' ;;
 failed-empty) exit 2 ;;
 failure) printf 'credential-value-must-not-leak' >&2; exit 7 ;;
 empty) printf '  \\n\\t'; exit 0 ;;
 timeout) sleep 10 ;;
 *) printf 'Final response\\n' ;;
esac
`);
  chmodSync(binary, 0o700);
  const capture = join(root, 'capture');
  const env = { PATH: process.env.PATH!, HOME: root, HERMES_HOME: join(root, 'profile'), HERMES_BIN: binary, FAKE_CAPTURE: capture, TMPDIR: scratch };
  return { root, workdir, scratch, capture, env };
}

/** Captured argv without the bridge-private --usage-file pair (its path is random). */
function capturedArgs(capture: string): string {
  const lines = readFileSync(capture + '.args', 'utf8').split('\n');
  const at = lines.indexOf('--usage-file');
  expect(at).toBeGreaterThanOrEqual(0);
  lines.splice(at, 2);
  return lines.join('\n');
}

describe('portable Hermes bridge', () => {
  test('passes prompt literally, uses requested cwd and preserves profiles/model identifiers', async () => {
    const f = fixture();
    const prompt = 'two lines\n$(touch should-not-exist) `literal` "quoted"';
    const p = Bun.spawn(['bash', bridge, prompt, f.workdir], { cwd: f.root, env: { ...f.env, HERMES_MODEL: 'vendor/model-x', HERMES_PROVIDER: 'custom-provider' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe('Final response\n');
    expect(readFileSync(f.capture + '.cwd', 'utf8')).toBe(f.workdir + '\n');
    expect(capturedArgs(f.capture)).toBe('--provider\ncustom-provider\n--model\nvendor/model-x\n-z\n' + prompt + '\n');
    expect(readFileSync(f.capture + '.home', 'utf8')).toBe(f.root + '\n' + f.env.HERMES_HOME + '\n');
    expect(readFileSync(f.capture + '.swarm', 'utf8')).toBe('0\n');
    expect(existsSync(join(f.workdir, 'should-not-exist'))).toBe(false);
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  test('defaults to caller cwd and configured Hermes model', async () => {
    const f = fixture();
    const p = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: f.env, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(0);
    expect(readFileSync(f.capture + '.cwd', 'utf8')).toBe(f.workdir + '\n');
    expect(capturedArgs(f.capture)).toBe('-z\nhello\n');
  });

  test.each([['failure', 7], ['empty', 1], ['timeout', 124], ['failed-empty', 1]] as const)('fails closed for %s and removes scratch', async (mode, code) => {
    const f = fixture();
    const p = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: { ...f.env, FAKE_MODE: mode, HERMES_TIMEOUT: '1' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(code);
    expect(await new Response(p.stdout).text()).toBe('');
    const error = await new Response(p.stderr).text();
    expect(error).toContain('hermes-zouroboros:');
    expect(error).not.toContain('credential-value-must-not-leak');
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  test.each(['provider-error', 'unfunded-exit'] as const)('an unfunded provider (%s) exits 88 quietly; debug prints a diagnostic only', async (mode) => {
    const f = fixture();
    const quiet = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: { ...f.env, FAKE_MODE: mode }, stdout: 'pipe', stderr: 'pipe' });
    expect(await quiet.exited).toBe(88);
    expect(await new Response(quiet.stdout).text()).toBe('');
    expect(await new Response(quiet.stderr).text()).toBe('');
    const debug = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: { ...f.env, FAKE_MODE: mode, HERMES_ZOUROBOROS_DEBUG: '1' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await debug.exited).toBe(88);
    const error = await new Response(debug.stderr).text();
    expect(error).toContain('hermes-zouroboros: unfunded');
    expect(error).not.toContain('credential-value-must-not-leak');
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  test('a successful answer that merely mentions 402 or balance is still a success', async () => {
    const f = fixture();
    const p = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: { ...f.env, FAKE_MODE: 'answer-mentions-billing' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe('Error code 402 means insufficient balance.\n');
  });

  test('omits the usage report when HERMES_USAGE_REPORT=0', async () => {
    const f = fixture();
    const p = Bun.spawn(['bash', bridge, 'hello'], { cwd: f.workdir, env: { ...f.env, HERMES_USAGE_REPORT: '0' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(0);
    expect(readFileSync(f.capture + '.args', 'utf8')).toBe('-z\nhello\n');
  });

  test('rejects provider-only overrides before invoking the agent', async () => {
    const f = fixture();
    const p = Bun.spawn(['bash', bridge, 'hello'], { env: { ...f.env, HERMES_PROVIDER: 'custom' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(2);
    expect(existsSync(f.capture + '.args')).toBe(false);
  });

  test('generates a registry with an absolute bridge and no provider/model policy', () => {
    const registry = createHermesRegistry('/srv/hermes-zouroboros');
    expect(registry.$schema).toBe('executor-registry/v1');
    expect(registry.executors[0]!.bridge).toBe('/srv/hermes-zouroboros/integration/hermes-bridge.sh');
    expect(registry.executors[0]!.id).toBe('hermes-vps');
    expect(registry.executors[0]!).not.toHaveProperty('modelRouter');
    expect(registry.executors[0]!.config).toEqual({ defaultTimeout: 300 });
    expect(() => createHermesRegistry('relative')).toThrow('absolute');
  });
});
