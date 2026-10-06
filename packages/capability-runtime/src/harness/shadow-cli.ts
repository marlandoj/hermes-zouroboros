import { existsSync } from "node:fs";
import { join } from "node:path";
import { ShadowHarnessRuntime } from "./shadow-runtime.js";
import { ShadowVerdictStore } from "./shadow-store.js";
import {
  autoloopShadowEvent,
  factoryShadowEvent,
  swarmShadowEvent,
  type AutoloopShadowInput,
  type FactoryShadowInput,
  type SwarmShadowInput,
} from "./shadow-adapters.js";

export const DEFAULT_SHADOW_STATE_DIR = "/home/workspace/.zouroboros/zcr-shadow";

export function resolveStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.ZCR_SHADOW_STATE_DIR ?? DEFAULT_SHADOW_STATE_DIR;
}

/**
 * Shadow observation is enabled by ZCR_SHADOW=1, disabled by ZCR_SHADOW=0,
 * and otherwise governed by the durable ENABLED sentinel in the state dir.
 * Default with no env and no sentinel is OFF (ships dark; the operator
 * starts the window by creating the sentinel).
 */
export function shadowEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.ZCR_SHADOW === "0") return false;
  if (env.ZCR_SHADOW === "1") return true;
  return existsSync(join(resolveStateDir(env), "ENABLED"));
}

export async function runShadowObserve(stdinPayload: string): Promise<{ exitCode: number; output: string }> {
  if (!shadowEnabled()) {
    return { exitCode: 0, output: JSON.stringify({ skipped: "shadow_disabled" }) };
  }
  let event: unknown;
  try {
    event = JSON.parse(stdinPayload);
  } catch {
    return { exitCode: 0, output: JSON.stringify({ skipped: "invalid_json" }) };
  }
  event = materializeAdapterPayload(event);
  try {
    const runtime = new ShadowHarnessRuntime({ stateDir: resolveStateDir() });
    const verdict = await runtime.observe(event);
    return { exitCode: 0, output: JSON.stringify({ outcome: verdict.outcome, verdict_id: verdict.verdict_id }) };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { exitCode: 0, output: JSON.stringify({ skipped: "runtime_unavailable", detail }) };
  }
}

/**
 * Consumers submit `{adapter, input}` so they never duplicate the event
 * schema; a fully-formed shadow event passes through unchanged.
 */
function materializeAdapterPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const wrapper = payload as { hook?: unknown; adapter?: unknown; input?: unknown; schema_family?: unknown };
  if (wrapper.schema_family === "zcr.shadow-consumer-event") return payload;
  if (wrapper.hook !== "zcr-008/v1") return payload;
  if (typeof wrapper.input !== "object" || wrapper.input === null) return payload;
  try {
    if (wrapper.adapter === "autoloop") return autoloopShadowEvent(wrapper.input as AutoloopShadowInput);
    if (wrapper.adapter === "swarm") return swarmShadowEvent(wrapper.input as SwarmShadowInput);
    if (wrapper.adapter === "factory") return factoryShadowEvent(wrapper.input as FactoryShadowInput);
  } catch {
    return payload;
  }
  return payload;
}

export function runShadowStatus(): { exitCode: number; output: string } {
  const stateDir = resolveStateDir();
  const store = new ShadowVerdictStore(stateDir);
  const status = store.windowStatus();
  return {
    exitCode: 0,
    output: JSON.stringify({ state_dir: stateDir, enabled: shadowEnabled(), ...status }, null, 2),
  };
}
