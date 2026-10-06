import type { ExecutionOutcome, ExecutorPort, TaskRecord } from "../contracts.js";

export interface DispatchableTaskResult {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: readonly string[];
}

export interface DispatcherSurface<T = unknown> {
  dispatch(task: T): Promise<DispatchableTaskResult>;
}

export function fromDispatcherSurface<T>(
  name: string,
  surface: DispatcherSurface<T>,
  toDispatchTask: (task: TaskRecord) => T,
): ExecutorPort {
  return {
    name,
    async execute(task: TaskRecord): Promise<ExecutionOutcome> {
      const result = await surface.dispatch(toDispatchTask(task));
      if (result.success) {
        return {
          status: "applied",
          result_json: JSON.stringify({ output: result.output ?? null, artifacts: result.artifacts ?? [] }),
        };
      }
      return { status: "failed_retryable", error: result.error ?? "dispatch failed without error detail" };
    },
  };
}

export class ExecutorRegistry {
  private readonly executors = new Map<string, ExecutorPort>();

  register(kind: string, executor: ExecutorPort): void {
    if (this.executors.has(kind)) {
      throw new Error(`executor already registered for kind ${kind}`);
    }
    this.executors.set(kind, executor);
  }

  resolve(kind: string): ExecutorPort | undefined {
    return this.executors.get(kind);
  }

  status(): readonly { kind: string; executor: string }[] {
    return [...this.executors.entries()].map(([kind, executor]) => ({ kind, executor: executor.name }));
  }
}
