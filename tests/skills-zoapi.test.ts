import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// Offline end-to-end checks for the t4 Zo-API rewrites: a disposable profile, a fake `hermes`
// executable, and no provider credentials or live profile in the child environment.
const repo = resolve(import.meta.dir, '..');
const skill = (path: string) => join(repo, 'skills', path);
let root = '';
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-zoapi-'));
  for (const dir of ['work', 'home', 'scratch', 'bin']) mkdirSync(join(root, dir));
  env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), TMPDIR: join(root, 'scratch'),
    HERMES_ZOUROBOROS_HOME: join(root, 'data'),
  };
  expect(run(join(repo, 'integration/cli.ts'), ['init', '--workspace', join(root, 'work')]).code).toBe(0);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(script: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd, env: { ...env, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** A fake Hermes CLI. Each call appends its arguments (one line) to hermes.calls. */
function fakeHermes(body: string) {
  const file = join(root, 'bin', 'hermes');
  writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "$*" | tr '\\n' ' ' >> "${root}/hermes.calls"; echo >> "${root}/hermes.calls"\n${body}\n`);
  chmodSync(file, 0o700);
}
const calls = () => existsSync(join(root, 'hermes.calls')) ? readFileSync(join(root, 'hermes.calls'), 'utf8').trim().split('\n').map((line) => line.trim()) : [];

test('ask layer: model and provider reach Hermes, Zo credentials do not, failures are classified', async () => {
  fakeHermes(`if [[ -n "\${ZO_CLIENT_IDENTITY_TOKEN:-}\${ZO_API_KEY:-}" ]]; then echo LEAKED; else echo "clean:$HERMES_HOME"; fi`);
  const probe = join(root, 'probe.ts');
  writeFileSync(probe, `import { ask } from '${join(repo, 'integration/ask.ts')}';\nconsole.log(JSON.stringify(await ask(JSON.parse(process.argv[2]!))));\n`);
  const zo = { ZO_CLIENT_IDENTITY_TOKEN: 'dummy-zo-token', ZO_API_KEY: 'dummy-zo-key' };
  const ok = JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping', model: 'm-1', provider: 'p-1' })], zo).stdout);
  expect(ok).toMatchObject({ ok: true, output: `clean:${join(root, 'data', 'hermes')}`, model: 'm-1' });
  expect(calls().at(-1)).toMatch(/^--provider p-1 --model m-1 --usage-file \S+ -z ping$/);

  // A provider error Hermes prints as its final response (exit 0) is a failed run, not an answer.
  fakeHermes(`while [[ $# -gt 0 ]]; do [[ "$1" == --usage-file ]] && echo '{"failed": true}' > "$2"; shift; done; echo 'API error 402: insufficient balance'`);
  // An unfunded provider (HTTP 402) is classified as such: a quiet failure, never success.
  expect(JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping' })]).stdout)).toMatchObject({ ok: false, failure: 'unfunded', exitCode: 88, output: '' });

  fakeHermes('sleep 5');
  expect(JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping', timeoutSec: 1 })]).stdout)).toMatchObject({ ok: false, failure: 'timeout', exitCode: 124 });
  fakeHermes('exit 0');
  expect(JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping' })]).stdout)).toMatchObject({ ok: false, failure: 'failed' });
  expect(JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping' })], { HERMES_BIN: join(root, 'missing') }).stdout)).toMatchObject({ ok: false, failure: 'unavailable' });
  expect(JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping', provider: 'p' })]).stdout)).toMatchObject({ ok: false, failure: 'usage' });
}, 60_000);

test('ask-retry: retries transient failures, rotates the chain, and keeps the 0/1/2/3 exit contract', () => {
  const retry = skill('zouroboros/ask-retry/scripts/ask-retry.ts');
  fakeHermes(`n=$(wc -l < "${root}/hermes.calls"); if [[ $n -lt 2 ]]; then exit 1; fi; echo "answer"`);
  const first = run(retry, ['--input', 'q', '--base-delay-ms', '1', '--max-delay-ms', '2', '--json']);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, output: 'answer', outcome: 'success' });
  expect(JSON.parse(first.stdout).attempts).toHaveLength(2);

  rmSync(join(root, 'hermes.calls'));
  fakeHermes('exit 1');
  const exhausted = run(retry, ['--chain', 'model-a,model-b', '--same-model-retries', '1', '--max-attempts', '3', '--base-delay-ms', '1', '--input', 'q']);
  expect(exhausted.code).toBe(2);
  expect(calls().map((line) => line.match(/--model (\S+)/)?.[1])).toEqual(['model-a', 'model-b', 'model-b']);

  expect(run(retry, ['--input', 'q'], { HERMES_BIN: join(root, 'missing') }).code).toBe(1);
  expect(run(retry, []).code).toBe(3);
  expect(run(retry, ['--input', 'q', '--max-attempts', 'x']).code).toBe(3);
  expect(JSON.parse(run(retry, ['--input', 'q', '--dry-run']).stdout)).toMatchObject({ maxAttempts: 4, models: [''] });
});

test('ask-governor: own tests pass and state persists only under the profile state directory', () => {
  for (const file of ['zouroboros/ask-governor/scripts/governor.test.ts', 'zouroboros/agent-doctor/scripts/doctor.test.ts',
    'zouroboros/agent-model-healer/scripts/healer.test.ts', 'research/deep-research/scripts/wiring.test.ts']) {
    const result = Bun.spawnSync([process.execPath, 'test', skill(file)], { cwd: repo, env: { ...env }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, `${file}\n${result.stderr.toString().slice(-2000)}`).toBe(0);
  }
  const governor = skill('zouroboros/ask-governor/scripts/governor.ts');
  expect(run(governor, ['where']).stdout.trim()).toBe(join(root, 'data', 'state', 'ask-governor'));
  expect(JSON.parse(run(governor, ['health']).stdout)).toMatchObject({ ok: true, circuit: 'closed' });
}, 120_000);

test('ponytail-review: one governed call, parsed findings, advisory on failure', () => {
  const review = skill('software-development/ponytail-review/scripts/ponytail-review.ts');
  writeFileSync(join(root, 'code.ts'), 'export const x = 1;\n');
  fakeHermes(`echo '{"findings":[{"loc":"L1","tag":"delete","what":"unused export","replacement":"nothing"}],"net_lines":1}'`);
  const found = JSON.parse(run(review, ['--file', join(root, 'code.ts'), '--json']).stdout);
  expect(found).toMatchObject({ api: 'hermes', net_lines: 1, findings: [{ tag: 'delete', loc: 'L1' }] });
  expect(calls()).toHaveLength(1);
  fakeHermes('exit 1');
  const failed = run(review, ['--file', join(root, 'code.ts'), '--json']);
  expect(failed.code).toBe(0);
  expect(JSON.parse(failed.stdout)).toMatchObject({ api: 'none', findings: [] });
  expect(JSON.parse(failed.stdout).note).toContain('review error');
});

test('deep-research: full DAG through the governed ask layer, profile memory in and out', () => {
  const zmem = skill('zouroboros/zo-memory-system/scripts/zmem.ts');
  expect(run(zmem, ['store', '--entity', 'project.widgets', '--key', 'alloy', '--value', 'Copper widgets resist corrosion in our tests']).code).toBe(0);
  fakeHermes(`p="$*"
case "$p" in
  *"research planner"*) echo '{"subQuestions":["Do copper widgets corrode?","How long do they last?"],"domain":"scientific"}' ;;
  *"peer-reviewed papers on this question"*) echo '[{"title":"Copper corrosion study","authors":"A. Author","year":2024,"url":"https://example.org/paper","abstract":"Copper forms a protective patina."}]' ;;
  *"non-academic web sources"*) echo '[{"title":"Widget guide","url":"https://example.com/guide","snippet":"Copper widgets last decades."}]' ;;
  *"rigorous research analyst"*) printf '## Executive Summary\\n- Copper widgets resist corrosion [S1].\\n## Findings\\n### Corrosion\\nPatina protects copper [S1] [S2].\\n## Gaps & Open Questions\\n- Long-term data.\\n' ;;
  *"assess whether peer-reviewed evidence"*) echo '{"verdict":"supported","note":"Patina studies agree."}' ;;
  *) exit 1 ;;
esac`);
  const runDir = join(root, 'run');
  const result = run(skill('research/deep-research/scripts/research.ts'), ['Do copper widgets corrode?', '--run-dir', runDir],
    { ZO_API_KEY: 'dummy-zo-key', OPENAI_API_KEY: 'dummy-openai-key' });
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  expect(report).toContain('## Claim Validation');
  expect(report).toContain('[Copper corrosion study](https://example.org/paper)');
  expect(report).toContain('### Internal memory (profile)');
  expect(report).toContain('project.widgets.alloy');
  const gathered = JSON.parse(readFileSync(join(runDir, '01-gather.json'), 'utf8')).sources;
  expect(new Set(gathered.map((s: { type: string }) => s.type))).toEqual(new Set(['literature', 'web', 'internal']));
  expect(JSON.parse(run(zmem, ['search', 'Deep research run']).stdout).some((f: { entity: string }) => f.entity === 'deep-research')).toBe(true);

  // Idempotent: a rerun reuses every artifact and calls no model.
  const before = calls().length;
  expect(run(skill('research/deep-research/scripts/research.ts'), ['Do copper widgets corrode?', '--run-dir', runDir, '--no-persist']).code).toBe(0);
  expect(calls().length).toBe(before);
}, 120_000);

test('deep-research: internal memory is searched by the query keywords, not only the sub-questions', () => {
  const zmem = skill('zouroboros/zo-memory-system/scripts/zmem.ts');
  expect(run(zmem, ['store', '--entity', 'demo', '--key', 'choice', '--value', 'Use copper widgets']).code).toBe(0);
  // Verbose sub-questions whose four longest words never include "copper" or "widgets".
  fakeHermes(`p="$*"
case "$p" in
  *"research planner"*) echo '{"subQuestions":["Which alternative manufacturing materials distinguish functional performance characteristics?"],"domain":"technical"}' ;;
  *"rigorous research analyst"*) printf '## Executive Summary\\n- Copper was chosen [S1].\\n' ;;
  *) exit 1 ;;
esac`);
  const runDir = join(root, 'run-internal');
  const result = run(skill('research/deep-research/scripts/research.ts'), ['Why use copper widgets?', '--run-dir', runDir, '--no-external', '--no-persist']);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const gathered = JSON.parse(readFileSync(join(runDir, '01-gather.json'), 'utf8')).sources;
  expect(gathered.map((s: { title: string }) => s.title)).toEqual(['demo.choice']);
  expect(calls()).toHaveLength(2);
}, 60_000);

const hasFfmpeg = Boolean(Bun.which('ffmpeg') && Bun.which('ffprobe'));

test('broll-injector: the planning call goes through Hermes; dry-run renders end to end', () => {
  writeFileSync(join(root, 'talk.srt'), '1\n00:00:00,000 --> 00:00:03,000\nCopper is a great conductor.\n\n2\n00:00:03,000 --> 00:00:06,000\nIt turns green over time.\n');
  fakeHermes(`echo '\`\`\`json'; echo '[{"start":1,"hold":2,"trigger_phrase":"great conductor","prompt":"Macro shot of copper wire, warm light"}]'; echo '\`\`\`'`);
  const plan = join(root, 'plan.json');
  const planned = run(skill('media/broll-injector/scripts/extract-plan.ts'), ['--srt', join(root, 'talk.srt'), '--out', plan, '--count', '1', '--plan-model', 'm-plan']);
  expect(planned.code, planned.stderr).toBe(0);
  expect(JSON.parse(readFileSync(plan, 'utf8')).moments).toEqual([expect.objectContaining({ id: 'm1', start: 1, hold: 2.5, source: 't2v', mode: 'fullframe' })]);
  expect(calls().at(-1)).toMatch(/--model m-plan --usage-file \S+ -z/);
  if (!hasFfmpeg) return;
  const spine = join(root, 'spine.mp4');
  const made = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', spine]);
  expect(made.exitCode).toBe(0);
  const injected = run(skill('media/broll-injector/scripts/inject.ts'), ['--base', spine, '--plan', plan, '--dry-run']);
  expect(injected.code, injected.stderr + injected.stdout).toBe(0);
  expect(existsSync(join(root, 'broll-spine', 'spine-broll.mp4'))).toBe(true);
  // Without fal-ai-media installed, a real render fails loud instead of guessing a host path.
  const missing = run(skill('media/broll-injector/scripts/gen-broll.ts'), ['--plan', plan, '--out-dir', join(root, 'real'), '--force'],
    { FAL_MEDIA_SCRIPT: join(root, 'absent/fal-media.ts') });
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('fal-ai-media is not installed');
  // With the sibling fal-ai-media skill (t6) but no FAL_KEY, the render reaches it and fails loud.
  const real = run(skill('media/broll-injector/scripts/gen-broll.ts'), ['--plan', plan, '--out-dir', join(root, 'real'), '--force']);
  expect(real.code).toBe(1);
  expect(real.stderr).toContain('FAL_KEY not set');
}, 120_000);

function writeJobs(jobs: unknown[]) {
  mkdirSync(join(root, 'data', 'hermes', 'cron'), { recursive: true });
  writeFileSync(join(root, 'data', 'hermes', 'cron', 'jobs.json'), JSON.stringify({ jobs, updated_at: 'now' }));
}
const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Job ${id}`, prompt: `Task ${id}`, enabled: true, state: 'scheduled', next_run_at: '2099-01-01T00:00:00Z',
  schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, deliver: 'local', ...extra,
});

test('agent-doctor: audits the profile cron jobs and applies only safe fixes through hermes cron', () => {
  fakeHermes('exit 0');
  const same = 'Reindex the knowledge base embeddings verify vector coverage reconcile failures publish metrics';
  writeJobs([
    job('zombie', { next_run_at: null }),
    job('self', { name: 'agent-doctor weekly', next_run_at: null, no_agent: true, script: 'doctor.sh' }),
    job('dup-a', { prompt: same }), job('dup-b', { prompt: `${same} daily` }),
    job('stale', { script: 'missing.py', prompt: 'Read /nonexistent-root-dir/notes.md and summarize' }),
    job('chatty', { prompt: 'Run the index backfill', deliver: 'telegram' }),
    job('off', { enabled: false, next_run_at: null }),
  ]);
  mkdirSync(join(root, 'data', 'hermes', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'data', 'hermes', 'scripts', 'doctor.sh'), '#!/bin/sh\n');
  const doctor = skill('zouroboros/agent-doctor/scripts/doctor.ts');
  const report = run(doctor, ['--json']);
  expect(report.code).toBe(2);
  const { findings, tiers } = JSON.parse(report.stdout);
  expect(tiers).toBe('example');
  const checks = (id: string) => findings.filter((f: { agentId: string }) => f.agentId === id).map((f: { check: string }) => f.check);
  expect(checks('zombie')).toContain('zombie-agents');
  expect(checks('dup-a')).toContain('duplicates');
  expect(checks('stale')).toEqual(['instruction-hygiene']);
  expect(checks('chatty')).toContain('delivery-method');
  expect(checks('off')).toEqual([]);
  expect(calls()).toEqual([]);

  const planned = JSON.parse(run(doctor, ['apply', '--dry-run', '--json']).stdout).changes.map((c: { args: string[] }) => c.args.join(' '));
  expect(planned.sort()).toEqual(['edit chatty --deliver local', 'pause zombie']);
  expect(calls()).toEqual([]);
  expect(run(doctor, ['apply']).code).toBe(2);
  expect(calls().sort()).toEqual(['cron edit chatty --deliver local', 'cron pause zombie']);
});

/** Fake Hermes that answers every model except those named in UNFUNDED_MODELS, which get a 402. */
const unfundedHermes = (models: string[]) => fakeHermes(`[[ "$1" == cron ]] && exit 0
usage=''; model=''; prev=''
for a in "$@"; do [[ "$prev" == --usage-file ]] && usage="$a"; [[ "$prev" == --model ]] && model="$a"; prev="$a"; done
case " ${models.join(' ')} " in *" $model "*) [[ -z "$usage" ]] || echo '{"failed": true}' > "$usage"; echo 'API error 402: Insufficient Balance'; exit 0 ;; esac
echo "HEALTH_CHECK_PASS from $model"`);

test('unfunded providers fail quietly: no retry, silent fallback, never success (fake 402, no live calls)', () => {
  unfundedHermes(['broke/model']);
  const probe = join(root, 'probe.ts');
  writeFileSync(probe, `import { ask } from '${join(repo, 'integration/ask.ts')}';\nconsole.log(JSON.stringify(await ask(JSON.parse(process.argv[2]!))));\n`);
  // ask(): falls through to the next model, silently, and records the skip.
  const fell = run(probe, [JSON.stringify({ prompt: 'ping', model: 'broke/model', fallbacks: [{ model: 'funded/model' }] })]);
  expect(JSON.parse(fell.stdout)).toMatchObject({ ok: true, model: 'funded/model', output: 'HEALTH_CHECK_PASS from funded/model', skippedUnfunded: ['broke/model'] });
  expect(fell.stderr).toBe('');
  const alone = JSON.parse(run(probe, [JSON.stringify({ prompt: 'ping', model: 'broke/model' })]).stdout);
  expect(alone).toMatchObject({ ok: false, failure: 'unfunded', output: '' });
  expect(run(probe, [JSON.stringify({ prompt: 'ping', model: 'broke/model' })], { HERMES_ZOUROBOROS_DEBUG: '1' }).stderr).toContain('[debug] ask: broke/model is unfunded');

  // ask-retry: one call on the unfunded model (no retry, no backoff), then the next chain model; nothing on stderr.
  rmSync(join(root, 'hermes.calls'));
  const retry = skill('zouroboros/ask-retry/scripts/ask-retry.ts');
  const chained = run(retry, ['--chain', 'broke/model,funded/model', '--max-attempts', '1', '--base-delay-ms', '60000', '--input', 'q', '--json']);
  expect(chained.code).toBe(0);
  expect(chained.stderr).toBe('');
  expect(JSON.parse(chained.stdout)).toMatchObject({ ok: true, model: 'funded/model', outcome: 'success' });
  expect(calls().map((line) => line.match(/--model (\S+)/)?.[1])).toEqual(['broke/model', 'funded/model']);
  const none = run(retry, ['--model', 'broke/model', '--max-attempts', '4', '--input', 'q', '--json']);
  expect(none.code).toBe(1);
  expect(none.stderr).toBe('');
  expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, outcome: 'unfunded', attempts: [expect.objectContaining({ failure: 'unfunded' })] });
  expect(JSON.parse(none.stdout).attempts).toHaveLength(1);

  // Healer: the unfunded model reports "unfunded (skipped)", is not an alarm, is never a fallback target.
  const healer = skill('zouroboros/agent-model-healer/scripts/healer.ts');
  const config = JSON.parse(readFileSync(skill('zouroboros/agent-model-healer/assets/fallback-chain.example.json'), 'utf8'));
  Object.assign(config, { healingEnabled: true, hysteresis: { consecutiveUnhealthyToHeal: 1, consecutiveHealthyToRestore: 1 } });
  config.probeConfig.retries = 2;
  mkdirSync(join(root, 'data', 'config', 'agent-model-healer'), { recursive: true });
  writeFileSync(join(root, 'data', 'config', 'agent-model-healer', 'fallback-chain.json'), JSON.stringify(config));
  writeJobs([job('j1', { model: 'example/claude-sonnet' }), job('j2', { model: 'example/gpt-oss-120b' })]);
  unfundedHermes(['example/gpt-oss-120b']);
  rmSync(join(root, 'hermes.calls'), { force: true });
  const result = run(healer, ['auto']);
  expect(result.code).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json).toMatchObject({ phase: 'complete', healActions: [], exhaustedAlerts: [], unhealthy: [], unfunded: ['example/gpt-oss-120b'],
    unfundedJobs: [{ agentId: 'j2', agentTitle: 'Job j2', model: 'example/gpt-oss-120b', status: 'unfunded (skipped)' }] });
  expect(result.stderr).toContain('unfunded (skipped)');
  expect(result.stderr).not.toMatch(/❌|EXHAUSTED/);
  // Probed once, not retried.
  expect(calls().filter((line) => line.includes('--model example/gpt-oss-120b'))).toHaveLength(1);
  const status = JSON.parse(run(healer, ['status']).stdout);
  expect(status.lastProbe['example/gpt-oss-120b']).toMatchObject({ healthy: false, health: 'unfunded', failureCategory: 'unfunded', warning: 'unfunded (skipped)' });

  // With the proprietary model down, the healer never moves a job onto the unfunded fallback.
  unfundedHermes(['example/gpt-oss-120b']);
  fakeHermes(`[[ "$1" == cron ]] && exit 0
usage=''; model=''; prev=''
for a in "$@"; do [[ "$prev" == --usage-file ]] && usage="$a"; [[ "$prev" == --model ]] && model="$a"; prev="$a"; done
[[ "$model" == example/claude-sonnet || "$model" == example/gemini-pro ]] && exit 1
[[ -z "$usage" ]] || echo '{"failed": true}' > "$usage"; echo 'API error 402: Insufficient Balance'`);
  const down = run(healer, ['auto']);
  const downJson = JSON.parse(down.stdout);
  expect(downJson.healActions).toEqual([]);
  expect(downJson.exhaustedAlerts).toEqual([expect.objectContaining({ agentId: 'j1', model: 'example/claude-sonnet' })]);
  expect(calls().filter((line) => line.startsWith('cron '))).toEqual([]);
}, 120_000);

test('agent-model-healer: probes through Hermes, heals with hysteresis via hermes cron edit, restores', () => {
  const healer = skill('zouroboros/agent-model-healer/scripts/healer.ts');
  expect(run(healer, ['auto']).stderr).toContain('No fallback chain');
  const config = JSON.parse(readFileSync(skill('zouroboros/agent-model-healer/assets/fallback-chain.example.json'), 'utf8'));
  config.probeConfig.retries = 0;
  const configFile = join(root, 'data', 'config', 'agent-model-healer', 'fallback-chain.json');
  mkdirSync(join(root, 'data', 'config', 'agent-model-healer'), { recursive: true });
  const save = () => writeFileSync(configFile, JSON.stringify(config));
  save();
  expect(run(healer, ['validate']).code).toBe(0);
  writeJobs([job('j1', { model: 'example/claude-sonnet', provider: 'prov-a' }), job('j2'), job('healer', { name: 'model healer', model: 'example/claude-sonnet', no_agent: true })]);
  // The proprietary model is down; the open-weight fallback answers.
  fakeHermes(`[[ "$1" == cron ]] && exit 0; case "$*" in *"--model example/claude-sonnet"*) [[ -f "${root}/up" ]] && echo HEALTH_CHECK_PASS && exit 0; exit 1 ;; esac; echo HEALTH_CHECK_PASS`);
  const auto = () => { const r = run(healer, ['auto']); return { ...r, json: JSON.parse(r.stdout) }; };
  const cronCalls = () => calls().filter((line) => line.startsWith('cron '));

  const dry = auto();
  expect(dry.json).toMatchObject({ phase: 'complete', dryRun: true, healActions: [] }); // hysteresis: 1/2
  expect(auto().json.healActions).toEqual([expect.objectContaining({ agentId: 'j1', to: 'example/gpt-oss-120b', applied: false })]);
  expect(cronCalls()).toEqual([]);

  config.healingEnabled = true; save();
  const healed = auto();
  expect(healed.code).toBe(0);
  expect(cronCalls()).toEqual(['cron edit j1 --model example/gpt-oss-120b']);
  expect(JSON.parse(run(healer, ['status']).stdout).switches).toEqual([expect.objectContaining({ agentId: 'j1', originalModel: 'example/claude-sonnet', originalProvider: 'prov-a' })]);

  // Simulate Hermes applying the edit, then recovery: restore needs 3 healthy samples.
  writeJobs([job('j1', { model: 'example/gpt-oss-120b', provider: 'prov-a' }), job('j2')]);
  writeFileSync(join(root, 'up'), '');
  auto(); auto();
  expect(cronCalls()).toHaveLength(1);
  expect(auto().json.restoreActions).toEqual([expect.objectContaining({ agentId: 'j1', to: 'example/claude-sonnet', applied: true })]);
  expect(cronCalls().at(-1)).toBe('cron edit j1 --model example/claude-sonnet --provider prov-a');
  expect(existsSync(join(root, 'data', 'state', 'agent-model-healer', 'state.json'))).toBe(true);
  expect(existsSync(join(root, 'data', 'logs', 'agent-model-healer.log'))).toBe(true);

  // A missing Hermes CLI aborts the run rather than declaring every model unhealthy.
  const blind = run(healer, ['auto'], { HERMES_BIN: join(root, 'missing') });
  expect(blind.code).toBe(2);
  expect(JSON.parse(blind.stdout).phase).toBe('probe_unavailable');
}, 120_000);

test('persona-creator: generates into the state dir and installs a Hermes personality without selecting it', () => {
  const persona = skill('zouroboros/persona-creator/scripts/persona.ts');
  const created = run(persona, ['create', '--name', 'Health Coach', '--domain', 'healthcare', '--rules', 'Never diagnose|Refer symptoms to a clinician']);
  expect(created.code, created.stderr).toBe(0);
  const dir = join(root, 'data', 'state', 'personas', 'health-coach');
  for (const file of ['SOUL.md', 'SAFETY.md', 'PROMPT.md', 'IDENTITY/health-coach.md']) expect(existsSync(join(dir, file))).toBe(true);
  expect(readFileSync(join(dir, 'PROMPT.md'), 'utf8')).not.toMatch(/\bZo\b/);
  expect(run(persona, ['validate', 'health-coach']).code).toBe(0);
  expect(run(persona, ['create', '--name', 'Health Coach', '--domain', 'healthcare']).code).toBe(1);

  const configFile = join(root, 'data', 'hermes', 'config.yaml');
  writeFileSync(configFile, `# operator comment\n${readFileSync(configFile, 'utf8')}`);
  expect(run(persona, ['install', 'health-coach']).code).toBe(0);
  const text = readFileSync(configFile, 'utf8');
  expect(text).toContain('# operator comment');
  const config = parse(text);
  expect(config.agent.personalities['health-coach'].system_prompt).toContain('Never diagnose');
  expect(config.display?.personality).toBeUndefined();
  expect(config.skills.external_dirs).toEqual([join(repo, 'skills')]);
  expect(run(persona, ['install', 'health-coach']).code).toBe(1);

  expect(run(persona, ['create', '--name', 'Concise', '--domain', 'writing']).code).toBe(0);
  expect(run(persona, ['install', 'concise']).stderr).toContain('Hermes built-in');
});
