#!/usr/bin/env bun
// Inspect and health-check the executors in this profile's generated registry
// ($HERMES_ZOUROBOROS_HOME/executors.json, written by `bun integration/cli.ts init`).
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { paths, runtimeEnv } from '../../../../integration/profile.ts';

interface Executor {
  id: string; name?: string; executor?: string; transport?: string; bridge?: string;
  healthCheck?: { command?: string; expectedPattern?: string };
}

export function loadRegistry(file = paths().registry): Executor[] {
  if (!existsSync(file)) throw new Error('No executor registry; run: bun integration/cli.ts init --workspace PATH');
  const registry = JSON.parse(readFileSync(file, 'utf8')) as { executors?: Executor[] };
  if (!Array.isArray(registry.executors)) throw new Error('Registry has no executors array.');
  return registry.executors;
}

/** Bridge present and executable, health command matches. Never prints command output (it may hold provider details). */
export function doctor(executors: Executor[], env: Record<string, string | undefined> = runtimeEnv()) {
  return executors.map((entry) => {
    const checks: Record<string, boolean> = {};
    if (entry.transport === 'bridge' || entry.bridge) {
      checks.bridge = Boolean(entry.bridge && existsSync(entry.bridge) && (() => {
        try { accessSync(entry.bridge!, constants.R_OK); return true; } catch { return false; }
      })());
    }
    const command = entry.healthCheck?.command?.trim().split(/\s+/);
    if (command?.length) {
      // The health check names a binary on PATH (e.g. `hermes --version`); HERMES_BIN overrides it like the bridge does.
      const binary = command[0] === 'hermes' && env.HERMES_BIN ? env.HERMES_BIN : command[0]!;
      const run = (Bun.which(binary, { PATH: env.PATH ?? '' }) || binary.startsWith('/'))
        ? Bun.spawnSync([binary, ...command.slice(1)], { env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
        : null;
      const pattern = entry.healthCheck?.expectedPattern ? new RegExp(entry.healthCheck.expectedPattern) : null;
      checks.health = Boolean(run && run.exitCode === 0 && (!pattern || pattern.test(run.stdout.toString())));
    }
    return { id: entry.id, ok: Object.values(checks).every(Boolean), checks };
  });
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === 'list') {
    console.log(JSON.stringify(loadRegistry().map(({ id, name, executor, transport, bridge }) => ({ id, name, executor, transport, bridge }))));
    return 0;
  }
  if (command === 'doctor') {
    const report = doctor(loadRegistry());
    console.log(JSON.stringify(report));
    return report.every((entry) => entry.ok) ? 0 : 1;
  }
  console.log('executors — list | doctor   (profile registry: $HERMES_ZOUROBOROS_HOME/executors.json)');
  return command && ['help', '--help', '-h'].includes(command) ? 0 : 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : 'executors failed');
    process.exitCode = 1;
  });
}
