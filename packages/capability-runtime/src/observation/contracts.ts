import type { CanonicalReceiptRef } from "../contracts/capability.js";

// Vocabulary is normative from Projects/zouroboros-capability-runtime/CONTRACTS.md
// ("Observation") and STATE-MACHINES.md ("Observation and sharing lifecycle").
// ZCR-006 (ZOU-1155) pilots observer-aware provenance and recipient authorization;
// it does not invent vocabulary beyond those documents.

export interface ObservationSource {
  readonly provider: string;
  readonly resource_digest: string;
}

export interface ObservationRecordV1 {
  readonly schema_family: "zcr.observation";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly source: ObservationSource;
  readonly payload_ref: string;
  readonly payload_digest: string;
  readonly access_constraints: readonly string[];
  readonly provenance_event_ids: readonly string[];
  readonly derived_from_observation_ids?: readonly string[];
  readonly observed_at: string;
  readonly expires_at?: string;
  readonly content_digest: string;
}

export type ShareDecisionState = "pending" | "authorized" | "denied" | "expired";

export interface ConstraintClearance {
  readonly constraint: string;
  readonly via: "independent_access" | "declassification";
  readonly evidence_digest: string;
  readonly declassification_id?: string;
}

export interface ShareDecisionRecordV1 {
  readonly schema_family: "zcr.share-decision";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly observation_ids: readonly string[];
  readonly recipient_digest: string;
  readonly constraints: readonly string[];
  readonly constraint_digest: string;
  readonly state: ShareDecisionState;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly decided_at?: string;
  readonly clearances?: readonly ConstraintClearance[];
  readonly violated_constraints?: readonly string[];
  readonly reason_codes?: readonly string[];
  readonly reopen_of_decision_id?: string;
  readonly content_digest: string;
}

export interface DeclassificationRecordV1 {
  readonly schema_family: "zcr.declassification";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly constraint: string;
  readonly observation_ids: readonly string[];
  readonly approval_kind: "human";
  readonly approved_by_actor_id: string;
  readonly reason: string;
  readonly approved_at: string;
  readonly expires_at?: string;
  readonly content_digest: string;
}

export type ObservationEventKind =
  | "captured"
  | "derived"
  | "share_authorized"
  | "share_denied"
  | "share_expired"
  | "declassified";

export interface ObservationEventProposalV1 {
  readonly schema_family: "zcr.observation-event-proposal";
  readonly schema_major: 1;
  readonly event_id: string;
  readonly sequence: number;
  readonly kind: ObservationEventKind;
  readonly occurred_at: string;
  readonly run_id: string;
  readonly observation_ids: readonly string[];
  readonly constraint_digest: string;
  readonly recipient_digest?: string;
  readonly decision_id?: string;
  readonly declassification_id?: string;
  readonly reason_codes: readonly string[];
  readonly rule_digest: string;
  readonly content_digest: string;
}

export interface ObservationReceiptWriter {
  appendBatch(events: readonly ObservationEventProposalV1[]): Promise<readonly CanonicalReceiptRef[]>;
}

export interface RecipientRef {
  readonly recipient_id: string;
  readonly channel: string;
}

export interface IndependentAccessProof {
  readonly ok: boolean;
  readonly evidence_digest: string;
}

/**
 * Port that proves a recipient can independently access the protected source
 * behind one constraint. Implementations must never echo payload content into
 * the proof; only digests and rule identifiers may appear.
 */
export interface RecipientAccessVerifier {
  verifyIndependentAccess(
    recipient: RecipientRef,
    source: ObservationSource,
    constraint: string,
  ): Promise<IndependentAccessProof>;
}

export interface ObservationStore {
  get(observationId: string): Promise<ObservationRecordV1 | null>;
  create(record: ObservationRecordV1): Promise<boolean>;
}

export interface ShareDecisionStore {
  get(decisionId: string): Promise<ShareDecisionRecordV1 | null>;
  createPending(record: ShareDecisionRecordV1): Promise<boolean>;
  transition(
    decisionId: string,
    from: ShareDecisionState,
    to: ShareDecisionState,
    finalized: ShareDecisionRecordV1,
  ): Promise<boolean>;
  listByRecipient(recipientDigest: string): Promise<readonly ShareDecisionRecordV1[]>;
  listAll(): Promise<readonly ShareDecisionRecordV1[]>;
}

export interface DeclassificationStore {
  create(record: DeclassificationRecordV1): Promise<boolean>;
  findActive(
    constraint: string,
    observationIds: readonly string[],
    at: Date,
  ): Promise<DeclassificationRecordV1 | null>;
  listAll(): Promise<readonly DeclassificationRecordV1[]>;
}

/** Opaque payload vault: records carry refs and digests only, never content. */
export interface ObservationPayloadVault {
  put(ref: string, content: string): void;
  get(ref: string): string | null;
}

export interface ObserverContext {
  now(): Date;
  nextId(prefix: "ob" | "sd" | "dc" | "oe"): string;
}

export interface ShareRequest {
  readonly run_id: string;
  readonly observation_ids: readonly string[];
  readonly recipient: RecipientRef;
  readonly decision_deadline: string;
  readonly reopen_of_decision_id?: string;
}

export interface ShareAuthorizedValue {
  readonly decision: ShareDecisionRecordV1;
  readonly decision_receipt: CanonicalReceiptRef;
}

export interface ShareResult {
  readonly ok: boolean;
  readonly decision?: ShareDecisionRecordV1;
  readonly decision_receipt?: CanonicalReceiptRef;
  readonly reason_codes: readonly string[];
}

export interface ReleasedPayload {
  readonly observation_id: string;
  readonly payload: string;
}

export interface PilotMetricsView {
  readonly observations_total: number;
  readonly label_complete_observations: number;
  readonly label_completeness: number;
  readonly decisions_total: number;
  readonly authorized_decisions: number;
  readonly denied_decisions: number;
  readonly expired_decisions: number;
  readonly false_blocks: number;
  readonly declassifications_total: number;
  readonly operator_burden: number;
}
