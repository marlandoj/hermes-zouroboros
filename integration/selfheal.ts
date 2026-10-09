// Self-heal loop (introspect → prescribe → evolve) for Hermes, over packages/selfheal.
//
// Every run uses the distribution profile: the memory database is always the profile's
// memory.db (inherited ZO_MEMORY_DB / ZOUROBOROS_MEMORY_DB are overridden), scorecards,
// prescriptions and results live under ZOUROBOROS_STATE_DIR/selfheal, and invocation logs
// under ZOUROBOROS_LOG_DIR. Evolution that changes files is opt-in through
// HERMES_ZOUROBOROS_ALLOW_SWARM=1, the same switch as swarm and autoloop runs.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from 'zouroboros-core';
import { closeDatabase, initDatabase } from 'zouroboros-memory';
import { repoRoot, runtimeEnv } from './profile.ts';

export const AUTOLOOP_SKILL_SCRIPT = join(repoRoot, 'skills/zouroboros/autoloop/scripts/autoloop.ts');

/** Point this process at the profile, then make sure the memory schema exists. */
export function useProfile(): Record<string, string> {
  const env = runtimeEnv();
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  // Never inherit another host's self-heal or autoloop locations.
  delete process.env.ZOUROBOROS_SELFHEAL_DIR;
  process.env.ZOUROBOROS_AUTOLOOP_SCRIPT = AUTOLOOP_SKILL_SCRIPT;
  for (const dir of ['ZOUROBOROS_STATE_DIR', 'ZOUROBOROS_LOG_DIR']) mkdirSync(process.env[dir]!, { recursive: true, mode: 0o700 });
  initDatabase({ ...DEFAULT_CONFIG.memory, dbPath: process.env.ZOUROBOROS_MEMORY_DB!, vectorEnabled: false, autoCapture: false });
  closeDatabase();
  return {
    memoryDb: process.env.ZOUROBOROS_MEMORY_DB!,
    selfhealDir: join(process.env.ZOUROBOROS_STATE_DIR!, 'selfheal'),
  };
}

const usage = {
  introspect: 'introspect [--json] [--store] [--verbose]',
  prescribe: 'prescribe [--scorecard PATH] [--target METRIC] [--output DIR] [--dry-run]',
  evolve: 'evolve [--prescription PATH] [--dry-run] [--skip-governor]',
} as const;
export type SelfHealCommand = keyof typeof usage;

export async function main(command: SelfHealCommand, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      json: { type: 'boolean' }, store: { type: 'boolean' }, verbose: { type: 'boolean' },
      scorecard: { type: 'string' }, target: { type: 'string' }, output: { type: 'string' }, live: { type: 'boolean' },
      prescription: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'skip-governor': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(`usage: ${usage[command]}`); return 0; }
  if (command === 'evolve' && !values['dry-run'] && process.env.HERMES_ZOUROBOROS_ALLOW_SWARM !== '1') {
    console.error('Evolution changes files: review the prescription, then set HERMES_ZOUROBOROS_ALLOW_SWARM=1 (or use --dry-run).');
    return 2;
  }
  const where = useProfile();
  // Imported after the environment is set: some collectors resolve paths at module load.
  const selfheal = await import('../packages/selfheal/src/index.ts');

  if (command === 'introspect') {
    const scorecard = await selfheal.introspect({ json: !!values.json, store: !!values.store, verbose: !!values.verbose });
    if (!values.json && !values.verbose) console.log(selfheal.formatScorecard(scorecard));
    return 0;
  }
  if (command === 'prescribe') {
    const prescription = await selfheal.prescribe({ scorecard: values.scorecard, target: values.target, live: !values.scorecard });
    if (values['dry-run']) { console.log(JSON.stringify(prescription, null, 2)); return 0; }
    const outDir = values.output ?? join(where.selfhealDir, 'prescriptions');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `prescription-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(prescription, null, 2));
    console.log(JSON.stringify({
      path: outPath, metric: prescription.metric.name, score: prescription.metric.score,
      playbook: prescription.playbook.name, governor: prescription.governor.approved ? 'approved' : 'blocked',
      reason: prescription.governor.reason,
    }, null, 2));
    return 0;
  }
  const result = await selfheal.evolve({ prescription: values.prescription, dryRun: !!values['dry-run'], skipGovernor: !!values['skip-governor'] });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

export function run(command: SelfHealCommand): void {
  main(command, process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
