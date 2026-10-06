import type { CanonicalReceiptRef } from "./capability.js";

// Vocabulary is normative from Projects/zouroboros-capability-runtime/CONTRACTS.md
// and STATE-MACHINES.md (ZCR-001, ZOU-1150, approved 2026-08-08). ZCR-005 (ZOU-1154)
// implements the outcome_unknown / reconciled / compensated semantics that document
// already specifies; it does not invent new vocabulary.

export type EffectClass =
  | "provider_idempotent_write"
  | "reconcilable_write"
  | "non_idempotent_write"
  | "destructive_write"
  | "compensating_write";

export type ActionState =
  | "staged"
  | "awaiting_approval"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "canceled"
  | "failed_retryable"
  | "outcome_unknown"
  | "reconciled"
  | "compensated";

export type DispatchBoundary = "not_dispatched" | "claimed" | "provider_confirmed";

export interface PlanDecisionRef {
  readonly owner: "plan-gate";
  readonly decision_id: string;
  readonly artifact_digest: string;
  readonly receipt: CanonicalReceiptRef;
}

export interface ActionResource {
  readonly kind: string;
  readonly resource_id: string;
}

export interface ActionRecordV1 {
  readonly schema_family: "zcr.action";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly plan_decision?: PlanDecisionRef;
  readonly tool_id: string;
  readonly resource: ActionResource;
  readonly effect_class: EffectClass;
  readonly canonical_payload_digest: string;
  readonly canonical_payload_ciphertext_ref: string;
  readonly provider_idempotency_key?: string;
  readonly stable_business_key?: string;
  readonly compensates_action_id?: string;
  readonly state: ActionState;
  readonly attempt: number;
  readonly dispatch_boundary: DispatchBoundary;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sequence: number;
  readonly content_digest: string;
}

export interface ActionApprovalV1 {
  readonly schema_family: "zcr.action-approval";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly action_id: string;
  readonly run_id: string;
  readonly actor_id: string;
  readonly session_id: string;
  readonly capability_handle_id: string;
  readonly canonical_payload_digest: string;
  readonly tool_id: string;
  readonly resource_digest: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
  readonly decided_at: string;
  readonly expires_at: string;
  readonly plan_decision?: PlanDecisionRef;
  readonly content_digest: string;
}

export interface SignedActionApproval {
  readonly approval: ActionApprovalV1;
  readonly key_id: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

export interface ProjectedRef<K extends string = string> {
  readonly kind: "projected";
  readonly schema_major: 1;
  readonly reference_type: K;
  readonly projection_id: string;
  readonly local_key: string;
}

export interface CommittedRef<K extends string = string> {
  readonly kind: "committed";
  readonly schema_major: 1;
  readonly reference_type: K;
  readonly provider: string;
  readonly provider_id: string;
}

export interface RefBinding<K extends string = string> {
  readonly projected: ProjectedRef<K>;
  readonly committed: CommittedRef<K>;
}

export type ProjectionState = "projected" | "resolved" | "withdrawn" | "invalidated";

export interface ProjectionRecordV1 {
  readonly schema_family: "zcr.projection";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly adapter_digest: string;
  readonly input_digest: string;
  readonly input_schema_digest: string;
  readonly output_schema_digest: string;
  readonly dependency_graph_digest: string;
  readonly projected_value_ref: string;
  readonly projected_value_digest: string;
  readonly provisional_refs: readonly ProjectedRef[];
  readonly state: ProjectionState;
  readonly committed_refs?: readonly CommittedRef[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly sequence: number;
  readonly content_digest: string;
}

export type ReconciliationResolution =
  | "applied"
  | "not_applied"
  | "partially_applied"
  | "unresolved";

export interface ReconciliationRecordV1 {
  readonly schema_family: "zcr.reconciliation";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly action_id: string;
  readonly provider_query_digest: string;
  readonly resolution: ReconciliationResolution;
  readonly provider_evidence_digest?: string;
  readonly reconciled_by: string;
  readonly reconciled_at: string;
  readonly replacement_action_id?: string;
  readonly supersedes_record_id?: string;
}

export const TERMINAL_ACTION_STATES: ReadonlySet<ActionState> = new Set([
  "rejected",
  "canceled",
  "applied",
  "reconciled",
  "compensated",
]);

export function isTerminalActionState(state: ActionState): boolean {
  return TERMINAL_ACTION_STATES.has(state);
}
