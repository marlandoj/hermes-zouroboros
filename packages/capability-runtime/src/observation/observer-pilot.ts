import { canonicalPayloadDigest } from "../fingerprint.js";
import type { CanonicalReceiptRef } from "../contracts/capability.js";
import type {
  ConstraintClearance,
  DeclassificationRecordV1,
  DeclassificationStore,
  ObservationEventKind,
  ObservationEventProposalV1,
  ObservationPayloadVault,
  ObservationReceiptWriter,
  ObservationRecordV1,
  ObservationSource,
  ObservationStore,
  ObserverContext,
  PilotMetricsView,
  RecipientAccessVerifier,
  RecipientRef,
  ReleasedPayload,
  ShareDecisionRecordV1,
  ShareDecisionStore,
  ShareRequest,
  ShareResult,
} from "./contracts.js";

const RULE_DIGEST = canonicalPayloadDigest("zcr-006-observer-pilot/v1");

export interface ObserverPilotDependencies {
  readonly observations: ObservationStore;
  readonly decisions: ShareDecisionStore;
  readonly declassifications: DeclassificationStore;
  readonly vault: ObservationPayloadVault;
  readonly verifier: RecipientAccessVerifier;
  readonly receipts: ObservationReceiptWriter;
  readonly context: ObserverContext;
}

export interface CaptureInput {
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly source: ObservationSource;
  readonly payload: string;
  readonly access_constraints: readonly string[];
  readonly provenance_event_ids: readonly string[];
  readonly expires_at?: string;
}

export interface DeriveInput {
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly source_observation_ids: readonly string[];
  readonly payload: string;
  readonly expires_at?: string;
}

export interface DeclassifyInput {
  readonly run_id: string;
  readonly constraint: string;
  readonly observation_ids: readonly string[];
  readonly approval_kind: "human";
  readonly approved_by_actor_id: string;
  readonly reason: string;
  readonly expires_at?: string;
}

export type CaptureResult =
  | { readonly ok: true; readonly observation: ObservationRecordV1; readonly receipt: CanonicalReceiptRef }
  | { readonly ok: false; readonly reason_codes: readonly string[] };

export type DeclassifyResult =
  | { readonly ok: true; readonly declassification: DeclassificationRecordV1; readonly receipt: CanonicalReceiptRef }
  | { readonly ok: false; readonly reason_codes: readonly string[] };

export type ReleaseResult =
  | { readonly ok: true; readonly payloads: readonly ReleasedPayload[] }
  | { readonly ok: false; readonly reason_codes: readonly string[] };

export class ObserverPilot {
  constructor(private readonly deps: ObserverPilotDependencies) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const now = this.deps.context.now();
    const reasons: string[] = [];
    if (input.run_id.length === 0 || input.capability_handle_id.length === 0) reasons.push("malformed_capture");
    if (input.source.provider.length === 0 || input.source.resource_digest.length === 0) reasons.push("malformed_source");
    if (input.provenance_event_ids.length === 0) reasons.push("missing_provenance");
    if (new Set(input.access_constraints).size !== input.access_constraints.length) reasons.push("duplicate_constraints");
    if (reasons.length > 0) return { ok: false, reason_codes: reasons };

    const record = this.#makeObservation(
      input.run_id,
      input.capability_handle_id,
      input.source,
      input.payload,
      [...input.access_constraints].sort(),
      [...input.provenance_event_ids].sort(),
      undefined,
      now,
      input.expires_at,
    );
    return this.#persistObservation(record, "captured", input.payload);
  }

  async derive(input: DeriveInput): Promise<CaptureResult> {
    const now = this.deps.context.now();
    if (input.source_observation_ids.length === 0) return { ok: false, reason_codes: ["missing_sources"] };
    const sources: ObservationRecordV1[] = [];
    for (const id of input.source_observation_ids) {
      const source = await this.deps.observations.get(id);
      if (source === null) return { ok: false, reason_codes: ["unknown_source_observation"] };
      sources.push(source);
    }
    const constraints = [...new Set(sources.flatMap((source) => source.access_constraints))].sort();
    const provenance = [
      ...new Set(sources.flatMap((source) => [...source.provenance_event_ids, source.record_id])),
    ].sort();
    const record = this.#makeObservation(
      input.run_id,
      input.capability_handle_id,
      { provider: "zcr.derivation", resource_digest: canonicalPayloadDigest([...input.source_observation_ids].sort()) },
      input.payload,
      constraints,
      provenance,
      [...input.source_observation_ids].sort(),
      now,
      input.expires_at,
    );
    return this.#persistObservation(record, "derived", input.payload);
  }

  async requestShare(request: ShareRequest): Promise<ShareResult> {
    const now = this.deps.context.now();
    if (request.observation_ids.length === 0) return { ok: false, reason_codes: ["missing_observations"] };
    if (!Number.isFinite(Date.parse(request.decision_deadline)) || now.getTime() >= Date.parse(request.decision_deadline)) {
      return { ok: false, reason_codes: ["invalid_decision_deadline"] };
    }
    if (request.reopen_of_decision_id !== undefined) {
      const prior = await this.deps.decisions.get(request.reopen_of_decision_id);
      if (prior === null) return { ok: false, reason_codes: ["unknown_reopened_decision"] };
    }
    const observations: ObservationRecordV1[] = [];
    for (const id of request.observation_ids) {
      const observation = await this.deps.observations.get(id);
      if (observation === null) return { ok: false, reason_codes: ["unknown_observation"] };
      if (observation.expires_at !== undefined && now.getTime() >= Date.parse(observation.expires_at)) {
        return { ok: false, reason_codes: ["observation_expired"] };
      }
      observations.push(observation);
    }

    const recipientDigest = canonicalPayloadDigest(request.recipient);
    const constraints = [...new Set(observations.flatMap((observation) => observation.access_constraints))].sort();
    const pending = this.#makeDecision(request, recipientDigest, constraints, now);
    if (!(await this.deps.decisions.createPending(pending))) {
      return { ok: false, reason_codes: ["decision_store_conflict"] };
    }

    if (constraints.length === 0) {
      return this.#finalize(pending, "authorized", { clearances: [] }, now);
    }

    const clearances: ConstraintClearance[] = [];
    const violated: string[] = [];
    for (const constraint of constraints) {
      const clearance = await this.#clearConstraint(constraint, request.recipient, observations, now);
      if (clearance === null) violated.push(constraint);
      else clearances.push(clearance);
    }
    if (violated.length > 0) {
      return this.#finalize(pending, "denied", { violated_constraints: violated }, now);
    }
    return this.#finalize(pending, "authorized", { clearances }, now);
  }

  async expireDecision(decisionId: string): Promise<ShareResult> {
    const now = this.deps.context.now();
    const decision = await this.deps.decisions.get(decisionId);
    if (decision === null) return { ok: false, reason_codes: ["unknown_decision"] };
    if (decision.state !== "pending") return { ok: false, reason_codes: ["decision_not_pending"] };
    if (now.getTime() < Date.parse(decision.expires_at)) return { ok: false, reason_codes: ["deadline_not_reached"] };
    return this.#finalize(decision, "expired", {}, now);
  }

  async declassify(input: DeclassifyInput): Promise<DeclassifyResult> {
    const now = this.deps.context.now();
    const reasons: string[] = [];
    if (input.approval_kind !== "human") reasons.push("declassification_requires_human_approval");
    if (input.approved_by_actor_id.length === 0) reasons.push("missing_approver");
    if (input.reason.length === 0) reasons.push("missing_reason");
    if (input.constraint.length === 0) reasons.push("missing_constraint");
    if (input.observation_ids.length === 0) reasons.push("missing_observations");
    if (reasons.length > 0) return { ok: false, reason_codes: reasons };
    for (const id of input.observation_ids) {
      if ((await this.deps.observations.get(id)) === null) return { ok: false, reason_codes: ["unknown_observation"] };
    }

    const unsigned = {
      schema_family: "zcr.declassification" as const,
      schema_major: 1 as const,
      record_id: this.deps.context.nextId("dc"),
      run_id: input.run_id,
      constraint: input.constraint,
      observation_ids: [...input.observation_ids].sort(),
      approval_kind: "human" as const,
      approved_by_actor_id: input.approved_by_actor_id,
      reason: input.reason,
      approved_at: now.toISOString(),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    };
    const record: DeclassificationRecordV1 = { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
    if (!(await this.deps.declassifications.create(record))) {
      return { ok: false, reason_codes: ["declassification_store_conflict"] };
    }
    const receipt = await this.#appendEvent({
      kind: "declassified",
      run_id: input.run_id,
      observation_ids: record.observation_ids,
      constraint_digest: canonicalPayloadDigest([input.constraint]),
      declassification_id: record.record_id,
      reason_codes: [],
      occurred_at: now,
    });
    if (receipt === null) return { ok: false, reason_codes: ["evidence_unavailable"] };
    return { ok: true, declassification: record, receipt };
  }

  /** Protected content leaves the vault only through an authorized, unexpired decision. */
  async release(decisionId: string): Promise<ReleaseResult> {
    const now = this.deps.context.now();
    const decision = await this.deps.decisions.get(decisionId);
    if (decision === null) return { ok: false, reason_codes: ["unknown_decision"] };
    if (decision.state !== "authorized") return { ok: false, reason_codes: ["decision_not_authorized"] };
    if (now.getTime() >= Date.parse(decision.expires_at)) return { ok: false, reason_codes: ["decision_expired"] };
    const payloads: ReleasedPayload[] = [];
    for (const id of decision.observation_ids) {
      const observation = await this.deps.observations.get(id);
      if (observation === null) return { ok: false, reason_codes: ["unknown_observation"] };
      const payload = this.deps.vault.get(observation.payload_ref);
      if (payload === null) return { ok: false, reason_codes: ["payload_unavailable"] };
      payloads.push({ observation_id: id, payload });
    }
    return { ok: true, payloads };
  }

  async metrics(): Promise<PilotMetricsView> {
    const decisions = await this.deps.decisions.listAll();
    const declassifications = await this.deps.declassifications.listAll();
    const observations = this.#capturedObservations;
    const labelComplete = observations.filter(
      (observation) => observation.provenance_event_ids.length > 0 && observation.source.resource_digest.length > 0,
    ).length;
    const authorized = decisions.filter((decision) => decision.state === "authorized");
    const denied = decisions.filter((decision) => decision.state === "denied");
    const expired = decisions.filter((decision) => decision.state === "expired");
    let falseBlocks = 0;
    for (const denial of denied) {
      const overturned = authorized.some(
        (grant) =>
          grant.recipient_digest === denial.recipient_digest &&
          grant.constraint_digest === denial.constraint_digest &&
          canonicalPayloadDigest(grant.observation_ids) === canonicalPayloadDigest(denial.observation_ids) &&
          Date.parse(grant.requested_at) >= Date.parse(denial.requested_at) &&
          (grant.clearances ?? []).some((clearance) => clearance.via === "declassification"),
      );
      if (overturned) falseBlocks += 1;
    }
    return {
      observations_total: observations.length,
      label_complete_observations: labelComplete,
      label_completeness: observations.length === 0 ? 1 : labelComplete / observations.length,
      decisions_total: decisions.length,
      authorized_decisions: authorized.length,
      denied_decisions: denied.length,
      expired_decisions: expired.length,
      false_blocks: falseBlocks,
      declassifications_total: declassifications.length,
      operator_burden: declassifications.length + denied.length,
    };
  }

  readonly #capturedObservations: ObservationRecordV1[] = [];
  #eventSequence = 0;

  async #clearConstraint(
    constraint: string,
    recipient: RecipientRef,
    observations: readonly ObservationRecordV1[],
    now: Date,
  ): Promise<ConstraintClearance | null> {
    const carriers = observations.filter((observation) => observation.access_constraints.includes(constraint));
    const carrierIds = carriers.map((carrier) => carrier.record_id).sort();
    const declassification = await this.deps.declassifications.findActive(constraint, carrierIds, now);
    if (declassification !== null) {
      return {
        constraint,
        via: "declassification",
        evidence_digest: declassification.content_digest,
        declassification_id: declassification.record_id,
      };
    }
    const evidenceDigests: string[] = [];
    for (const carrier of carriers) {
      let proof;
      try {
        proof = await this.deps.verifier.verifyIndependentAccess(recipient, carrier.source, constraint);
      } catch {
        return null;
      }
      if (!proof.ok) return null;
      evidenceDigests.push(proof.evidence_digest);
    }
    return {
      constraint,
      via: "independent_access",
      evidence_digest: canonicalPayloadDigest(evidenceDigests.sort()),
    };
  }

  async #finalize(
    pending: ShareDecisionRecordV1,
    state: "authorized" | "denied" | "expired",
    outcome: {
      readonly clearances?: readonly ConstraintClearance[];
      readonly violated_constraints?: readonly string[];
    },
    now: Date,
  ): Promise<ShareResult> {
    const reasonCodes =
      state === "denied"
        ? (outcome.violated_constraints ?? []).map((constraint) => `constraint_unsatisfied:${constraint}`)
        : state === "expired"
          ? ["decision_deadline_reached"]
          : [];
    const { content_digest: _previous, ...base } = pending;
    const unsigned = {
      ...base,
      state,
      decided_at: now.toISOString(),
      ...(outcome.clearances === undefined ? {} : { clearances: outcome.clearances }),
      ...(outcome.violated_constraints === undefined ? {} : { violated_constraints: outcome.violated_constraints }),
      ...(reasonCodes.length === 0 ? {} : { reason_codes: reasonCodes }),
    };
    const finalized: ShareDecisionRecordV1 = { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
    const kind: ObservationEventKind =
      state === "authorized" ? "share_authorized" : state === "denied" ? "share_denied" : "share_expired";
    const receipt = await this.#appendEvent({
      kind,
      run_id: finalized.run_id,
      observation_ids: finalized.observation_ids,
      constraint_digest: finalized.constraint_digest,
      recipient_digest: finalized.recipient_digest,
      decision_id: finalized.record_id,
      reason_codes: reasonCodes,
      occurred_at: now,
    });
    if (receipt === null) return { ok: false, reason_codes: ["evidence_unavailable"] };
    if (!(await this.deps.decisions.transition(pending.record_id, "pending", state, finalized))) {
      return { ok: false, reason_codes: ["decision_transition_conflict"] };
    }
    return {
      ok: state === "authorized",
      decision: finalized,
      decision_receipt: receipt,
      reason_codes: reasonCodes,
    };
  }

  #makeObservation(
    runId: string,
    capabilityHandleId: string,
    source: ObservationSource,
    payload: string,
    constraints: readonly string[],
    provenance: readonly string[],
    derivedFrom: readonly string[] | undefined,
    now: Date,
    expiresAt?: string,
  ): ObservationRecordV1 {
    const recordId = this.deps.context.nextId("ob");
    const unsigned = {
      schema_family: "zcr.observation" as const,
      schema_major: 1 as const,
      record_id: recordId,
      run_id: runId,
      capability_handle_id: capabilityHandleId,
      source: structuredClone(source),
      payload_ref: `vault:${recordId}`,
      payload_digest: canonicalPayloadDigest(payload),
      access_constraints: constraints,
      provenance_event_ids: provenance,
      ...(derivedFrom === undefined ? {} : { derived_from_observation_ids: derivedFrom }),
      observed_at: now.toISOString(),
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    };
    return { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
  }

  async #persistObservation(
    record: ObservationRecordV1,
    kind: "captured" | "derived",
    payload: string,
  ): Promise<CaptureResult> {
    if (!(await this.deps.observations.create(record))) {
      return { ok: false, reason_codes: ["observation_store_conflict"] };
    }
    this.deps.vault.put(record.payload_ref, payload);
    this.#capturedObservations.push(structuredClone(record));
    const receipt = await this.#appendEvent({
      kind,
      run_id: record.run_id,
      observation_ids: [record.record_id],
      constraint_digest: canonicalPayloadDigest(record.access_constraints),
      reason_codes: [],
      occurred_at: this.deps.context.now(),
    });
    if (receipt === null) return { ok: false, reason_codes: ["evidence_unavailable"] };
    return { ok: true, observation: record, receipt };
  }

  async #appendEvent(input: {
    readonly kind: ObservationEventKind;
    readonly run_id: string;
    readonly observation_ids: readonly string[];
    readonly constraint_digest: string;
    readonly recipient_digest?: string;
    readonly decision_id?: string;
    readonly declassification_id?: string;
    readonly reason_codes: readonly string[];
    readonly occurred_at: Date;
  }): Promise<CanonicalReceiptRef | null> {
    this.#eventSequence += 1;
    const unsigned = {
      schema_family: "zcr.observation-event-proposal" as const,
      schema_major: 1 as const,
      event_id: this.deps.context.nextId("oe"),
      sequence: this.#eventSequence,
      kind: input.kind,
      occurred_at: input.occurred_at.toISOString(),
      run_id: input.run_id,
      observation_ids: [...input.observation_ids].sort(),
      constraint_digest: input.constraint_digest,
      ...(input.recipient_digest === undefined ? {} : { recipient_digest: input.recipient_digest }),
      ...(input.decision_id === undefined ? {} : { decision_id: input.decision_id }),
      ...(input.declassification_id === undefined ? {} : { declassification_id: input.declassification_id }),
      reason_codes: input.reason_codes,
      rule_digest: RULE_DIGEST,
    };
    const event: ObservationEventProposalV1 = { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
    try {
      const receipts = await this.deps.receipts.appendBatch([event]);
      const receipt = receipts[0];
      if (receipts.length !== 1 || receipt === undefined || receipt.owner !== "evidence-substrate/ZOU-1051") {
        return null;
      }
      return receipt;
    } catch {
      return null;
    }
  }

  #makeDecision(
    request: ShareRequest,
    recipientDigest: string,
    constraints: readonly string[],
    now: Date,
  ): ShareDecisionRecordV1 {
    const unsigned = {
      schema_family: "zcr.share-decision" as const,
      schema_major: 1 as const,
      record_id: this.deps.context.nextId("sd"),
      run_id: request.run_id,
      observation_ids: [...request.observation_ids].sort(),
      recipient_digest: recipientDigest,
      constraints,
      constraint_digest: canonicalPayloadDigest(constraints),
      state: "pending" as const,
      requested_at: now.toISOString(),
      expires_at: request.decision_deadline,
      ...(request.reopen_of_decision_id === undefined ? {} : { reopen_of_decision_id: request.reopen_of_decision_id }),
    };
    return { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
  }
}
