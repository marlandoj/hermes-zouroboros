import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTasks } from './tasks.ts';
import { runtimeEnv, settings, paths } from './profile.ts';

if (process.env.HERMES_ZOUROBOROS_ALLOW_SWARM !== '1') throw new Error('Swarm execution is disabled');
Object.assign(process.env, runtimeEnv());
// The orchestrator enforces each task's requested timeout. Keep the bridge's
// independent process-tree timeout at the maximum accepted task budget.
process.env.HERMES_TIMEOUT = '600';
process.chdir(settings().workspace);
const { SwarmOrchestrator } = await import('zouroboros-swarm');
const tasks = validateTasks(JSON.parse(readFileSync(process.argv[2]!, 'utf8')));
// This distribution validates its bounded task contract above. The upstream
// seed/gap gates audit the full production installation (including seeded
// agency roles), which this local executor intentionally does not provision.
// Post-flight result evaluation remains active; this is not Factory certification.
const orchestrator = new SwarmOrchestrator({
  localConcurrency: 2, maxRetries: 0, routingStrategy: 'reliable',
  dbPath: join(paths().data, 'swarm.db'), enableMemory: false,
  pipelineGates: { seedValidation: false, gapAuditLoop: false, postFlightEval: true },
});
const results = await orchestrator.run(tasks);
console.log(JSON.stringify({ ok: results.length === tasks.length && results.every(r => r.success), results }));
process.exitCode = results.length === tasks.length && results.every(r => r.success) ? 0 : 1;
