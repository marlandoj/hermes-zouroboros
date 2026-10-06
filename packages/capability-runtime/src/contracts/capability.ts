export interface AuthorityEnvelopeRef {
  readonly owner: "evidence-substrate/ZOU-1059";
  readonly envelope_id: string;
  readonly schema_major: number;
  readonly content_digest: string;
}

export interface CanonicalReceiptRef {
  readonly owner: "evidence-substrate/ZOU-1051";
  readonly receipt_id: string;
  readonly schema_major: number;
  readonly content_digest: string;
}

export interface CapabilityResource {
  readonly kind: string;
  readonly resource_id: string;
}

export interface CapabilityHandleV1 {
  readonly schema_family: "zcr.capability-handle";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly subject_id: string;
  readonly envelope: AuthorityEnvelopeRef;
  readonly parent_handle_id?: string;
  readonly resource: CapabilityResource;
  readonly operations: readonly string[];
  readonly argument_constraints_digest: string;
  readonly credential_ref: string;
  readonly environment_constraints_digest: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly content_digest: string;
}

export type CapabilityHandleState = "introduced" | "active" | "expired" | "revoked" | "closed";

export interface CapabilityIntroductionRequest {
  readonly envelope: AuthorityEnvelopeRef;
  readonly run_id: string;
  readonly subject_id: string;
  readonly parent_handle_id?: string;
  readonly resource: CapabilityResource;
  readonly operations: readonly string[];
  readonly not_before?: string;
  readonly expires_at: string;
}

export interface CapabilityInvocationRequest {
  readonly handle_id: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
}

export interface IntroducedCapability {
  readonly handle_id: string;
  readonly resource: CapabilityResource;
  readonly operations: readonly string[];
  readonly not_before: string;
  readonly expires_at: string;
  readonly argument_constraints_digest: string;
}

export type CapabilityEventKind = "introduction" | "use" | "denial" | "expiry" | "attenuation";

export interface CapabilityEventProposalV1 {
  readonly schema_family: "zcr.capability-event-proposal";
  readonly schema_major: 1;
  readonly event_id: string;
  readonly sequence: number;
  readonly kind: CapabilityEventKind;
  readonly decision: "PERMIT" | "DENY";
  readonly occurred_at: string;
  readonly run_id: string;
  readonly subject_id: string;
  readonly handle_id?: string;
  readonly parent_handle_id?: string;
  readonly operation?: string;
  readonly resource_digest: string;
  readonly envelope?: AuthorityEnvelopeRef;
  readonly reason_codes: readonly string[];
  readonly authority_events_digest?: string;
  readonly rule_digest: string;
  readonly content_digest: string;
}

export interface AuthorityEvaluationInput {
  readonly operation: string;
  readonly resource: string;
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
  readonly credential_class: string;
  readonly at: Date;
  readonly environment: Readonly<Record<"runtime_root" | "isolation_mode" | "repository" | "state_dir", string>>;
  readonly receipt_terminalized: boolean;
  readonly terminal_outcome: string | null;
}

export interface AuthorityEvaluation {
  readonly decision: "PERMIT" | "DENY";
  readonly reasons: readonly string[];
  readonly events_digest: string;
}

export declare const verifiedAuthorityBrand: unique symbol;

export interface VerifiedAuthorityEnvelope {
  readonly [verifiedAuthorityBrand]: true;
  readonly ref: AuthorityEnvelopeRef;
  readonly run_id: string;
  readonly subject_id: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly environment: AuthorityEvaluationInput["environment"];
  readonly environment_digest: string;
}

export interface AuthorityVerifier {
  resolveAndVerify(ref: AuthorityEnvelopeRef): Promise<VerifiedAuthorityEnvelope | null>;
  authorizeIntroduction(
    snapshot: VerifiedAuthorityEnvelope,
    input: Omit<AuthorityEvaluationInput, "operation" | "arguments"> & { readonly operations: readonly string[] },
  ): Promise<AuthorityEvaluation & { readonly argument_constraints_digest: string }>;
  evaluate(snapshot: VerifiedAuthorityEnvelope, input: AuthorityEvaluationInput): Promise<AuthorityEvaluation>;
  verifyDelegation(
    parent: VerifiedAuthorityEnvelope,
    child: VerifiedAuthorityEnvelope,
  ): Promise<{ readonly ok: boolean; readonly reasons: readonly string[]; readonly events_digest: string }>;
}

export interface RunState {
  readonly terminalized: boolean;
  readonly terminal_outcome: string | null;
}

export interface RunStateReader {
  read(runId: string): Promise<RunState>;
}

export interface CapabilityCatalogEntry {
  readonly operation: string;
  readonly resource_kind: string;
  readonly credential_ref: string;
  readonly credential_class: string;
  readonly effect: "read" | "write";
  readonly required_arguments: readonly string[];
  readonly optional_arguments: readonly string[];
  readonly schema_digest: string;
  readonly model_description?: string;
}

export interface CapabilityCatalog {
  resolve(operation: string): CapabilityCatalogEntry | null;
}

export interface ModelVisibleCapability {
  readonly handle_id: string;
  readonly operation: string;
  readonly resource: CapabilityResource;
  readonly required_arguments: readonly string[];
  readonly optional_arguments: readonly string[];
  readonly schema_digest: string;
  readonly description?: string;
}

export interface ProviderInvocation {
  readonly operation: string;
  readonly resource: CapabilityResource;
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
  readonly authority: {
    readonly envelope_id: string;
    readonly run_id: string;
    readonly handle_id: string;
  };
}

export interface BrokerProviderInvoker {
  invoke(request: ProviderInvocation, credentialRef: string): Promise<unknown>;
}

export interface CanonicalReceiptWriter {
  appendBatch(events: readonly CapabilityEventProposalV1[]): Promise<readonly CanonicalReceiptRef[]>;
}

export interface TrustedBrokerContext {
  now(): Date;
  environment(): AuthorityEvaluationInput["environment"];
  nextId(prefix: "ch" | "ce"): string;
}

export interface StoredCapabilityHandle {
  readonly handle: CapabilityHandleV1;
  readonly state: CapabilityHandleState;
  readonly introduction_receipt?: CanonicalReceiptRef;
  readonly catalog_digest: string;
}

export interface CapabilityStore {
  get(handleId: string): Promise<StoredCapabilityHandle | null>;
  list(runId: string, subjectId: string): Promise<readonly StoredCapabilityHandle[]>;
  createIntroduced(record: StoredCapabilityHandle): Promise<boolean>;
  transition(
    handleId: string,
    from: CapabilityHandleState,
    to: CapabilityHandleState,
    introductionReceipt?: CanonicalReceiptRef,
  ): Promise<boolean>;
}

export interface CapabilityPermit<T> {
  readonly ok: true;
  readonly value: T;
}

export interface CapabilityDenial {
  readonly ok: false;
  readonly reason_codes: readonly string[];
}

export type CapabilityResult<T> = CapabilityPermit<T> | CapabilityDenial;

export interface CapabilityInvocationValue {
  readonly output: unknown;
  readonly lineage: {
    readonly envelope: AuthorityEnvelopeRef;
    readonly introduction_receipt: CanonicalReceiptRef;
    readonly use_receipt: CanonicalReceiptRef;
    readonly handle_id: string;
  };
}

export interface CapabilityIntroductionValue {
  readonly handle: CapabilityHandleV1;
  readonly introduction_receipt: CanonicalReceiptRef;
}
