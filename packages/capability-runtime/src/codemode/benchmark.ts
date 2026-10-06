import type { ModelVisibleCapability } from "../contracts/capability.js";
import type {
  BenchmarkReport,
  CodeModeDelegates,
  CodeModeInvoker,
  GeneratedFacade,
  HeldOutTask,
} from "./contracts.js";
import { runInCodeModeSandbox } from "./sandbox.js";

/** Deterministic token estimate: ceil(length / 4), the common 4-chars-per-token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Render the direct (rollback) context: MCP-style JSON tool schemas for the
 * same capability projection the facade consumes. This is what a model sees
 * without Code Mode and remains the tested rollback path.
 */
export function renderDirectSchemaContext(capabilities: readonly ModelVisibleCapability[]): string {
  const tools = capabilities.map((capability) => ({
    name: capability.operation,
    description: capability.description ?? "",
    handle_id: capability.handle_id,
    resource: capability.resource,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        [...capability.required_arguments, ...capability.optional_arguments].map((name) => [
          name,
          { type: ["string", "number", "boolean"], description: `Argument ${name} for ${capability.operation}` },
        ]),
      ),
      required: [...capability.required_arguments],
      additionalProperties: false,
    },
    schema_digest: capability.schema_digest,
  }));
  return JSON.stringify({ tools }, null, 2);
}

export interface HeldOutBenchmarkInput {
  readonly tasks: readonly HeldOutTask[];
  readonly capabilities: readonly ModelVisibleCapability[];
  readonly facade: GeneratedFacade;
  readonly delegates: CodeModeDelegates;
  readonly invoker: CodeModeInvoker;
  readonly sandbox_timeout_ms: number;
}

/**
 * Run identical held-out tasks through both paths: the Code Mode facade
 * (generated code in the networkless sandbox) and the direct invoker path.
 * Both routes terminate in the same broker, so evaluation and production
 * exercise the same authority, journal, and evidence checks.
 */
export async function runHeldOutBenchmark(input: HeldOutBenchmarkInput): Promise<BenchmarkReport> {
  let facadeCompleted = 0;
  let directCompleted = 0;
  for (const task of input.tasks) {
    const sandboxResult = await runInCodeModeSandbox({
      code: task.facade_code,
      delegates: input.delegates,
      timeout_ms: input.sandbox_timeout_ms,
    });
    if (sandboxResult.ok && task.succeeded(sandboxResult.value)) facadeCompleted += 1;

    try {
      const directResult = await task.direct(input.invoker);
      if (task.succeeded(directResult)) directCompleted += 1;
    } catch {
      // direct path failure counts as incomplete
    }
  }
  const taskCount = input.tasks.length;
  const facadeCompletion = taskCount === 0 ? 0 : facadeCompleted / taskCount;
  const directCompletion = taskCount === 0 ? 0 : directCompleted / taskCount;
  const directTokens = estimateTokens(renderDirectSchemaContext(input.capabilities));
  const facadeTokens = estimateTokens(input.facade.declarations);
  return {
    task_count: taskCount,
    facade_completed: facadeCompleted,
    direct_completed: directCompleted,
    facade_completion: facadeCompletion,
    direct_completion: directCompletion,
    completion_gap_pp: Math.round((directCompletion - facadeCompletion) * 10000) / 100,
    direct_context_tokens: directTokens,
    facade_context_tokens: facadeTokens,
    token_reduction_pct:
      directTokens === 0 ? 0 : Math.round(((directTokens - facadeTokens) / directTokens) * 10000) / 100,
  };
}
