/**
 * EXEC-03 / EXEC-04 regression: uncooperative adapter cleanup.
 *
 * EXEC-03: the total/idle timers must escalate SIGTERM → SIGKILL, and the
 * awaited session race must carry an explicit deadline rejection, so an
 * adapter that ignores SIGTERM can never hold the session open forever.
 *
 * EXEC-04: adapters are registered in activeAdapters at spawn and removed
 * after cleanup, so shutdown() during a hung session actually stops work.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The transport merges process.env into every session env (buildEnv); a host
// harness exporting SWARM_* routing vars would flip the fail-closed
// model-selection check for an entry that declares none.
for (const key of ['SWARM_PROVIDER', 'SWARM_RESOLVED_MODEL']) delete process.env[key];

import { ACPTransport } from '../transport/acp-transport.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type { ExecutorRegistryEntry, Task } from '../types.js';

const HUNG_ADAPTER = `${import.meta.dir}/fixtures/mock-acp-hung-adapter.ts`;

const hungEntry = {
  id: 'hung-adapter',
  name: 'Hung Adapter',
  executor: 'local',
  bridge: 'none',
  description: 'test',
  expertise: [],
  bestFor: ['test'],
  config: { defaultTimeout: 600, model: null, envVars: {} },
  healthCheck: { command: 'true', expectedPattern: '', description: 'test' },
  transport: 'acp' as const,
  acp: { adapterBin: 'bun' },
} as ExecutorRegistryEntry;

function makeTransport() {
  return new ACPTransport(hungEntry, new CircuitBreaker({ id: 'test', cooldownMs: 0, failureThreshold: 5 }), {
    adapterBin: 'bun',
    adapterArgs: [HUNG_ADAPTER],
  });
}

function task(id: string): Task {
  return { id, persona: 'exec03-probe', task: 'hang forever', priority: 'low' };
}

function hermeticEnv(): Record<string, string> {
  return { SWARM_RESOLVED_MODEL: '', SWARM_PROVIDER: '' };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('EXEC-03: unresponsive adapter cannot hang the session', () => {
  test('SIGTERM-ignoring adapter is SIGKILLed and the race settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zo-hung-'));
    try {
      const transport = makeTransport();
      const start = Date.now();
      const result = await transport.execute(task('t-hung-1'), {
        timeoutMs: 800,
        killGraceMs: 400,
        workdir: dir,
        env: hermeticEnv(),
      });
      const elapsed = Date.now() - start;
      expect(result.success).toBe(false);
      expect(result.error ?? '').toMatch(/timed out/i);
      // Kill escalation lands ~timeoutMs + killGraceMs (1.2s). Far below the
      // 6.2s hard deadline — and infinitely below "hangs forever".
      expect(elapsed).toBeLessThan(8000);
      // …but not instantly: the timeout path actually ran.
      expect(elapsed).toBeGreaterThanOrEqual(700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('hard deadline rejects even if the process-death watchdog misfires', async () => {
    // killGraceMs of 0 arms SIGKILL immediately on timeout; the deadline slack
    // still bounds the race. This exercises the deadline timer wiring with a
    // very short total budget.
    const dir = mkdtempSync(join(tmpdir(), 'zo-hung-'));
    try {
      const transport = makeTransport();
      const start = Date.now();
      const result = await transport.execute(task('t-hung-2'), {
        timeoutMs: 500,
        killGraceMs: 0,
        workdir: dir,
        env: hermeticEnv(),
      });
      const elapsed = Date.now() - start;
      expect(result.success).toBe(false);
      expect(elapsed).toBeLessThan(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('EXEC-04: shutdown() stops adapters registered during execute', () => {
  test('active adapter is registered at spawn and removed after cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zo-hung-'));
    try {
      const transport = makeTransport();
      const active = (transport as unknown as { activeAdapters: Set<unknown> }).activeAdapters;
      const readyFile = join(dir, 'adapter-ready');
      const pending = transport.execute(task('t-hung-3'), {
        timeoutMs: 60_000,
        workdir: dir,
        env: { ...hermeticEnv(), ZO_HUNG_ADAPTER_READY: readyFile },
      });
      await waitFor(() => active.size === 1);
      expect(active.size).toBe(1);
      // Wait until the fixture has installed its SIGTERM-ignoring handlers;
      // otherwise shutdown() can catch bun mid-startup (default SIGTERM
      // disposition) and the test would pass without exercising the
      // uncooperative path.
      await waitFor(() => existsSync(readyFile));
      const adapter = [...active][0] as { exitCode: number | null };
      expect(adapter.exitCode).toBeNull(); // genuinely alive, not a zombie
      const start = Date.now();
      await transport.shutdown();
      const shutdownMs = Date.now() - start;
      expect(active.size).toBe(0);
      // The uncooperative adapter ignored SIGTERM: shutdown() must have taken
      // the ~500ms TERM wait before SIGKILL, proving the escalation path ran.
      expect(shutdownMs).toBeGreaterThanOrEqual(400);
      const result = await pending;
      expect(result.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
