import { createContext, Script } from "node:vm";
import type { SandboxRunInput, SandboxRunResult } from "./contracts.js";

const MAX_ERROR_DETAIL = 200;

function sanitizeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_DETAIL);
}

/**
 * Run generated Code Mode source in a networkless sandbox. The vm context
 * exposes ONLY the frozen capability delegates (the restricted local broker
 * transport). Host globals — fetch, process, require, module, Bun, timers,
 * filesystem — are absent by construction, so the only effectful path out of
 * the sandbox is the broker, which owns authority, approval, journal,
 * observation, and evidence enforcement.
 */
export async function runInCodeModeSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  if (input.timeout_ms <= 0 || !Number.isFinite(input.timeout_ms)) {
    return { ok: false, error_code: "sandbox_unavailable", detail: "invalid timeout" };
  }
  // NOTE: vm's codeGeneration option segfaults Bun 1.2.21, so string-eval is
  // neutralized with the prelude below instead. Confinement does not depend on
  // blocking eval: the context has no host globals, so generated code — eval'd
  // or not — still has no path to network, filesystem, process, or providers.
  const context = createContext(Object.create(null));
  const bridgeKey = "__codemode_bridge__";
  const bridge = { capabilities: input.delegates, result: undefined as unknown };
  Object.defineProperty(bridge, "capabilities", {
    value: Object.freeze(input.delegates),
    writable: false,
    configurable: false,
  });
  (context as Record<string, unknown>)[bridgeKey] = bridge;

  const wrapped = [
    `"use strict";`,
    `Object.defineProperty(globalThis, "eval", { value: undefined, writable: false, configurable: false });`,
    `Object.defineProperty(globalThis, "Function", { value: undefined, writable: false, configurable: false });`,
    `const capabilities = ${bridgeKey}.capabilities;`,
    `${bridgeKey}.result = (async () => {`,
    input.code,
    `})();`,
  ].join("\n");

  let script: Script;
  try {
    script = new Script(wrapped, { filename: "codemode-task.js" });
  } catch (error) {
    return { ok: false, error_code: "sandbox_error", detail: sanitizeDetail(error) };
  }

  try {
    script.runInContext(context, { timeout: input.timeout_ms });
  } catch (error) {
    const detail = sanitizeDetail(error);
    if (detail.includes("timed out")) return { ok: false, error_code: "sandbox_timeout", detail };
    return { ok: false, error_code: "sandbox_error", detail };
  }

  const pending = bridge.result as Promise<unknown>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("sandbox task timed out")), input.timeout_ms);
  });
  try {
    const value = await Promise.race([Promise.resolve(pending), timeout]);
    return { ok: true, value };
  } catch (error) {
    const detail = sanitizeDetail(error);
    if (detail.includes("timed out")) return { ok: false, error_code: "sandbox_timeout", detail };
    return { ok: false, error_code: "sandbox_error", detail };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
