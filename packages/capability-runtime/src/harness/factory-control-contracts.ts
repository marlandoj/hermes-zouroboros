import type { ActionState, DispatchBoundary } from "../contracts/types.js";
import type { TrustedActionRender } from "../action/exact-action.js";

export const FACTORY_CONTROL_MODES = ["off", "shadow", "canary"] as const;
export const FACTORY_CONTROL_DECISIONS = ["permit", "hold", "deny"] as const;

export type FactoryControlMode = (typeof FACTORY_CONTROL_MODES)[number];
export type FactoryControlDecision = (typeof FACTORY_CONTROL_DECISIONS)[number];

export interface FactoryControlActorV1 {
  readonly actor_id: string;
  readonly session_ids: readonly string[];
}

export interface FactoryControlConfigV1 {
  readonly schema_family: "zcr.factory-control-config";
  readonly schema_major: 1;
  readonly config_version: 1;
  readonly mode: FactoryControlMode;
  readonly allowlisted_ticket_identifiers: readonly string[];
  readonly source_commit: string;
  readonly runtime_entrypoint: string;
  readonly runtime_digest: string;
  readonly expires_at: string;
  readonly max_applied_effects: 1;
  readonly state_dir: string;
  readonly authority_envelope_path: string;
  readonly authority_envelope_digest: string;
  readonly authority_evidence_path: string;
  readonly authority_evidence_digest: string;
  readonly capability_catalog_path: string;
  readonly capability_catalog_digest: string;
  readonly trusted_keys_path: string;
  readonly trusted_keys_digest: string;
  readonly allowed_actors: readonly FactoryControlActorV1[];
  readonly content_digest: string;
}

export interface FactoryControlInput<T> {
  readonly ticket_identifier: string;
  readonly dispatch_result: T;
}

export type FactoryControlHostEffect = "performed" | "not_performed" | "already_applied";

export interface FactoryControlOutcome<T> {
  readonly mode: FactoryControlMode;
  readonly decision: FactoryControlDecision;
  readonly enforced: boolean;
  readonly reason_codes: readonly string[];
  readonly action_id: string | null;
  readonly action_state: ActionState | null;
  readonly dispatch_boundary: DispatchBoundary | null;
  readonly host_effect: FactoryControlHostEffect;
  readonly value?: T;
}

export interface FactoryControlPreparation {
  readonly action_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly action_state: ActionState;
  readonly dispatch_boundary: DispatchBoundary;
  readonly render: TrustedActionRender & { readonly action_id: string };
}

export interface FactoryControlVerdictRecordV1 {
  readonly schema_family: "zcr.factory-control-verdict";
  readonly schema_major: 1;
  readonly verdict_id: string;
  readonly ticket_identifier: string;
  readonly mode: FactoryControlMode;
  readonly decision: FactoryControlDecision;
  readonly enforced: boolean;
  readonly reason_codes: readonly string[];
  readonly config_digest: string;
  readonly source_commit: string;
  readonly runtime_digest: string;
  readonly dispatch_result_digest: string;
  readonly action_id: string | null;
  readonly action_state: ActionState | null;
  readonly dispatch_boundary: DispatchBoundary | null;
  readonly host_effect: FactoryControlHostEffect;
  readonly observed_at: string;
  readonly evidence_digest: string;
  readonly content_digest: string;
}
