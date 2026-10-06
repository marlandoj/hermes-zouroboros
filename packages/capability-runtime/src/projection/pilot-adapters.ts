import { createHash } from "node:crypto";
import type { ProjectionAdapter, ProjectionAdapterContext, ProjectionAdapterOutcome } from "./projection-runtime.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const RECORD_CREATE_INPUT_SCHEMA = sha256("zcr.pilot.record-create/input/v1");
const RECORD_CREATE_OUTPUT_SCHEMA = sha256("zcr.pilot.record-create/output/v1");
const NON_SIMULATABLE_SCHEMA = sha256("zcr.pilot.non-simulatable/v1");

export function createRecordCreateAdapter(input: {
  readonly reference_type: string;
  readonly adapter_version?: string;
}): ProjectionAdapter {
  if (!input.reference_type) throw new Error("record-create adapter requires a reference_type");
  const version = input.adapter_version ?? "1.0.0";
  return {
    adapter_id: `zcr.pilot.record-create.${input.reference_type}`,
    adapter_version: version,
    input_schema_digest: RECORD_CREATE_INPUT_SCHEMA,
    output_schema_digest: RECORD_CREATE_OUTPUT_SCHEMA,
    project(context: ProjectionAdapterContext): ProjectionAdapterOutcome {
      if (context.action.effect_class === "destructive_write") {
        return { status: "awaitDecision", reason: "record-create adapter cannot project destructive writes" };
      }
      return {
        status: "projected",
        projected_value: {
          provisional: true,
          reference_type: input.reference_type,
          tool_id: context.payload.tool_id,
          resource: context.payload.resource,
          input_digest: context.action.canonical_payload_digest,
        },
        provisional_refs: [{ reference_type: input.reference_type, local_key: "created" }],
      };
    },
  };
}

export function createNonSimulatableAdapter(input: { readonly adapter_id: string; readonly reason: string }): ProjectionAdapter {
  return {
    adapter_id: input.adapter_id,
    adapter_version: "1.0.0",
    input_schema_digest: NON_SIMULATABLE_SCHEMA,
    output_schema_digest: NON_SIMULATABLE_SCHEMA,
    project(): ProjectionAdapterOutcome {
      return { status: "awaitDecision", reason: input.reason };
    },
  };
}
