#!/usr/bin/env bun
// Zouroboros swarm for Hermes: decide, validate, prepare and (opt-in) run a bounded task DAG.
// Everything here delegates to the distribution: the decision gate in zouroboros-swarm,
// the task contract in integration/tasks.ts, and execution through `integration/cli.ts swarm`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths, repoRoot, settings } from '../../../../integration/profile.ts';
import { validateTasks } from '../../../../integration/tasks.ts';

const gateScript = join(repoRoot, 'packages/swarm/src/routing/swarm-decision-gate.ts');
const usage = `swarm — Zouroboros swarm orchestration (hermes-zouroboros)
  gate "<scoped plan>"     score a plan: SWARM / SUGGEST / DIRECT / FORCE_SWARM (JSON)
  validate <tasks.json>    check the task contract and dependency DAG
  prepare <tasks.json>     save a reviewable campaign in the profile (prints its path)
  run <campaign.json>      execute (requires HERMES_ZOUROBOROS_ALLOW_SWARM=1)`;

function readTasks(file: string | undefined) {
  if (!file) throw new Error('A tasks.json path is required.');
  return validateTasks(JSON.parse(readFileSync(resolve(file), 'utf8')));
}

export function gate(plan: string): { decision: string; score: number; override: string | null } {
  const run = Bun.spawnSync([process.execPath, gateScript, '--json', plan], { stdout: 'pipe', stderr: 'pipe' });
  // The gate signals its decision through the exit code (0 SWARM, 2 DIRECT, 3 SUGGEST); 1 is an error.
  if (run.exitCode === 1) throw new Error('Decision gate failed.');
  return JSON.parse(run.stdout.toString());
}

/** Writes the validated input (as submitted) under the profile's campaigns dir, never elsewhere. */
export function prepare(file: string): { taskFile: string; taskCount: number } {
  readTasks(file);
  settings();
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const directory = join(paths().data, 'campaigns');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const taskFile = join(directory, `${randomUUID()}.json`);
  writeFileSync(taskFile, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { taskFile, taskCount: raw.length };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'gate': {
      const plan = rest.join(' ').trim();
      if (!plan) throw new Error('gate requires a plan description');
      console.log(JSON.stringify(gate(plan)));
      return 0;
    }
    case 'validate': {
      const tasks = readTasks(rest[0]);
      console.log(JSON.stringify({ ok: true, taskCount: tasks.length, ids: tasks.map((task) => task.id) }));
      return 0;
    }
    case 'prepare':
      console.log(JSON.stringify(prepare(rest[0]!)));
      return 0;
    case 'run': {
      if (!rest[0]) throw new Error('run requires a campaign file');
      // The CLI enforces the opt-in, isolation and timeout contract; do not bypass it.
      const child = Bun.spawn([process.execPath, join(repoRoot, 'integration/cli.ts'), 'swarm', resolve(rest[0])],
        { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      return await child.exited;
    }
    case undefined: case 'help': case '--help': case '-h':
      console.log(usage);
      return command ? 0 : 2;
    default:
      console.error(usage);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : 'swarm failed');
    process.exitCode = 1;
  });
}
