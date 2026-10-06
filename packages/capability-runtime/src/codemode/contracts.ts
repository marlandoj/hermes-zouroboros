import type {
  CapabilityInvocationValue,
  CapabilityResult,
  ModelVisibleCapability,
} from "../contracts/capability.js";

// ZCR-007 (ZOU-1156): broker-filtered typed Code Mode facade. The facade is a
// projection convenience only — every runtime call routes through the
// capability broker, which owns authority, approval, journal, observation,
// and evidence checks. No new authority path is introduced here.

export type ScalarType = "string" | "number" | "boolean";

export interface ArgumentSchemaNode {
  readonly type?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly properties?: Readonly<Record<string, ArgumentSchemaNode>>;
  readonly items?: ArgumentSchemaNode;
  readonly required?: readonly string[];
  readonly $ref?: string;
  readonly description?: string;
}

export interface CapabilityArgumentSchema {
  readonly schema_digest: string;
  readonly arguments: Readonly<Record<string, ArgumentSchemaNode>>;
}

/**
 * Optional richer-schema port. When absent, or when the returned digest does
 * not match the catalog digest recorded on the capability (schema drift), the
 * generator degrades the affected parameters to `unknown` and marks the entry
 * as requiring runtime validation.
 */
export interface CapabilitySchemaSource {
  resolve(operation: string, schemaDigest: string): CapabilityArgumentSchema | null;
}

export interface FacadeParameter {
  readonly name: string;
  readonly rendered_type: string;
  readonly required: boolean;
  readonly degraded_to_unknown: boolean;
}

export interface FacadeEntry {
  readonly identifier: string;
  readonly operation: string;
  readonly handle_id: string;
  readonly parameters: readonly FacadeParameter[];
  readonly requires_validation: boolean;
  readonly description?: string;
}

export interface GeneratedFacade {
  readonly entries: readonly FacadeEntry[];
  readonly declarations: string;
  readonly source_capability_count: number;
}

export type CodeModeDelegate = (
  args: Readonly<Record<string, unknown>>,
) => Promise<CapabilityResult<CapabilityInvocationValue>>;

export type CodeModeDelegates = Readonly<Record<string, CodeModeDelegate>>;

export interface CodeModeInvoker {
  invoke(request: {
    readonly handle_id: string;
    readonly operation: string;
    readonly arguments: Readonly<Record<string, string | number | boolean>>;
  }): Promise<CapabilityResult<CapabilityInvocationValue>>;
}

export interface SandboxRunInput {
  readonly code: string;
  readonly delegates: CodeModeDelegates;
  readonly timeout_ms: number;
}

export type SandboxRunResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error_code: "sandbox_timeout" | "sandbox_error" | "sandbox_unavailable"; readonly detail?: string };

export interface HeldOutTask {
  readonly task_id: string;
  readonly facade_code: string;
  readonly direct: (invoker: CodeModeInvoker) => Promise<unknown>;
  readonly succeeded: (result: unknown) => boolean;
}

export interface BenchmarkReport {
  readonly task_count: number;
  readonly facade_completed: number;
  readonly direct_completed: number;
  readonly facade_completion: number;
  readonly direct_completion: number;
  readonly completion_gap_pp: number;
  readonly direct_context_tokens: number;
  readonly facade_context_tokens: number;
  readonly token_reduction_pct: number;
}

export interface FacadeGenerationInput {
  readonly capabilities: readonly ModelVisibleCapability[];
  readonly schemas?: CapabilitySchemaSource;
}
