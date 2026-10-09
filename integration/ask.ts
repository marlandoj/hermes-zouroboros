import { existsSync, readFileSync } from 'node:fs';
import { paths, runtimeEnv, settings } from './profile.ts';

/**
 * One-shot model calls through the profile's executor registry: the Hermes provider/model
 * layer that replaces the source workspace's Zo /zo/ask endpoint. The default executor is
 * hermes-vps (integration/hermes-bridge.sh → `hermes -z`), so provider selection and
 * credentials stay in the Hermes profile; nothing here holds a token or an endpoint URL.
 */
export interface AskRequest {
  prompt: string;
  /** Model id for this call; empty means the Hermes profile's configured model. */
  model?: string;
  /** Hermes provider override; requires a model. */
  provider?: string;
  /** Per-call timeout in seconds (HERMES_TIMEOUT for the bridge). */
  timeoutSec?: number;
  /** Working directory for the agent; defaults to the profile workspace. */
  workdir?: string;
  /** Registry executor id; defaults to hermes-vps. */
  executor?: string;
}

export type AskFailure = 'usage' | 'unavailable' | 'timeout' | 'interrupted' | 'failed';

export interface AskOutcome {
  ok: boolean;
  output: string;
  exitCode: number;
  ms: number;
  model: string;
  failure?: AskFailure;
  /** Bridge diagnostic (its own messages only; provider stderr is never reflected). */
  detail?: string;
}

/** Transient failures are worth retrying; usage errors, a missing CLI and interrupts are not. */
export const TRANSIENT_FAILURES: ReadonlySet<AskFailure> = new Set(['timeout', 'failed']);

/** Map a bridge exit status to a failure class (see integration/hermes-bridge.sh). */
export function classifyExit(code: number): AskFailure | undefined {
  if (code === 0) return undefined;
  if (code === 2) return 'usage';
  if (code === 126 || code === 127) return 'unavailable';
  // GNU timeout: 124 on expiry, 137 when the kill-after grace period also expires.
  if (code === 124 || code === 137) return 'timeout';
  if (code === 130 || code === 143) return 'interrupted';
  return 'failed';
}

/** Credentials for the retired Zo endpoints are never passed to a model process. */
const STRIPPED_ENV = /^(ZO_CLIENT_IDENTITY_TOKEN|ZO_API_KEY|ZO_ASK_TOKEN|ZO_TOKEN)$/;

export function resolveBridge(executor = 'hermes-vps'): string {
  const registryPath = paths().registry;
  if (!existsSync(registryPath)) throw new Error('No executor registry; run: bun integration/cli.ts init --workspace PATH');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { executors?: { id: string; bridge?: string }[] };
  const entry = registry.executors?.find((candidate) => candidate.id === executor);
  if (!entry?.bridge) throw new Error(`Executor ${executor} has no bridge in the profile registry`);
  if (!existsSync(entry.bridge)) throw new Error(`Bridge not found for executor ${executor}`);
  return entry.bridge;
}

export function askEnv(request: Pick<AskRequest, 'model' | 'provider' | 'timeoutSec'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv())) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  delete env.SWARM_RESOLVED_MODEL;
  delete env.SWARM_PROVIDER;
  if (request.model) env.SWARM_RESOLVED_MODEL = request.model;
  if (request.provider) env.SWARM_PROVIDER = request.provider;
  if (request.timeoutSec !== undefined) env.HERMES_TIMEOUT = String(Math.max(1, Math.ceil(request.timeoutSec)));
  return env;
}

/** Run one prompt through the executor bridge. Never throws for model failures. */
export async function ask(request: AskRequest): Promise<AskOutcome> {
  const started = Date.now();
  const model = request.model ?? '';
  if (!request.prompt.trim()) return { ok: false, output: '', exitCode: 2, ms: 0, model, failure: 'usage', detail: 'empty prompt' };
  if (request.provider && !model) return { ok: false, output: '', exitCode: 2, ms: 0, model, failure: 'usage', detail: 'a provider override requires a model' };
  let bridge: string;
  let workdir: string;
  try {
    bridge = resolveBridge(request.executor);
    workdir = request.workdir ?? settings().workspace;
  } catch (error) {
    return { ok: false, output: '', exitCode: 127, ms: 0, model, failure: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  const child = Bun.spawn(['bash', bridge, request.prompt, workdir], {
    env: askEnv(request), cwd: workdir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const ms = Date.now() - started;
  const failure = classifyExit(exitCode);
  if (!failure) {
    const output = stdout.trim();
    return output ? { ok: true, output, exitCode, ms, model } : { ok: false, output: '', exitCode: 1, ms, model, failure: 'failed', detail: 'empty output' };
  }
  const detail = stderr.split('\n').find((line) => line.startsWith('hermes-zouroboros: '))?.slice(19).trim();
  return { ok: false, output: '', exitCode, ms, model, failure, detail };
}
