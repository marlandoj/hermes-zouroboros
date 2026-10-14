import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTasks } from './tasks.ts';
import { runtimeEnv, settings, paths } from './profile.ts';

if (process.env.HERMES_ZOUROBOROS_ALLOW_SWARM !== '1') throw new Error('Swarm execution is disabled');

// Cancellation (D-01): on SIGTERM/SIGINT stop every process this worker started and exit before
// the orchestrator can schedule another task. Bridges move children into their own process groups
// (timeout, setsid), so walk the process tree rather than signalling a group. The handler blocks
// the event loop on purpose: no task can start while it runs.
function descendants(root: number): number[] {
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe' }).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of ps.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  for (let queue = [root]; queue.length;) for (const pid of children.get(queue.shift()!) ?? []) { out.push(pid); queue.push(pid); }
  return out;
}
// Exited direct children stay as zombies until this (blocked) worker exits, so they do not count.
function running(pids: number[]): number[] {
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,stat='], { stdout: 'pipe' }).stdout.toString();
  const live = new Set(ps.split('\n').map(l => l.trim().split(/\s+/)).filter(([, stat]) => stat && !stat.startsWith('Z')).map(([pid]) => Number(pid)));
  return pids.filter(pid => live.has(pid));
}
let cancelling = false;
for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2]] as const) {
  process.on(signal, () => {
    if (cancelling) return;
    cancelling = true;
    const tree = descendants(process.pid);
    for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let waited = 0; waited < 5000 && running(tree).length; waited += 100) Bun.sleepSync(100);
    for (const pid of running(tree)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    console.error(`swarm cancelled by ${signal}; stopped ${tree.length} child process(es)`);
    process.exit(128 + number);
  });
}
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
