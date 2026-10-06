import { canonicalPayloadDigest } from "../fingerprint.js";
import type {
  AuthorityVerifier,
  BrokerProviderInvoker,
  CanonicalReceiptRef,
  CanonicalReceiptWriter,
  CapabilityCatalog,
  CapabilityCatalogEntry,
  CapabilityDenial,
  CapabilityEventKind,
  CapabilityEventProposalV1,
  CapabilityHandleV1,
  CapabilityIntroductionRequest,
  CapabilityIntroductionValue,
  CapabilityInvocationRequest,
  CapabilityInvocationValue,
  CapabilityResult,
  CapabilityStore,
  ModelVisibleCapability,
  RunState,
  RunStateReader,
  StoredCapabilityHandle,
  TrustedBrokerContext,
  VerifiedAuthorityEnvelope,
} from "../contracts/capability.js";

const RULE_DIGEST = canonicalPayloadDigest("zcr-002-capability-broker/v1");
const SHA256 = /^[0-9a-f]{64}$/;

export interface CapabilityBrokerDependencies {
  readonly authority: AuthorityVerifier;
  readonly runState: RunStateReader;
  readonly catalog: CapabilityCatalog;
  readonly provider: BrokerProviderInvoker;
  readonly receipts: CanonicalReceiptWriter;
  readonly store: CapabilityStore;
  readonly context: TrustedBrokerContext;
}

export class CapabilityBroker {
  constructor(private readonly deps: CapabilityBrokerDependencies) {}

  async introduce(request: CapabilityIntroductionRequest): Promise<CapabilityResult<CapabilityIntroductionValue>> {
    const now = this.deps.context.now();
    const basicReasons = this.#validateIntroductionShape(request, now);
    if (basicReasons.length > 0) return this.#deny(request, basicReasons, now);

    let snapshot: VerifiedAuthorityEnvelope | null;
    try {
      snapshot = await this.deps.authority.resolveAndVerify(request.envelope);
    } catch {
      snapshot = null;
    }
    if (snapshot === null) return this.#deny(request, ["unverifiable_authority"], now);
    if (snapshot.run_id !== request.run_id || snapshot.subject_id !== request.subject_id) {
      return this.#deny(request, ["authority_binding_mismatch"], now);
    }

    const entries = request.operations.map((operation) => this.deps.catalog.resolve(operation));
    if (entries.some((entry) => entry === null)) return this.#deny(request, ["unknown_capability"], now);
    const catalogEntries = entries as CapabilityCatalogEntry[];
    if (!this.#catalogEntriesAgree(catalogEntries, request.resource.kind)) {
      return this.#deny(request, ["catalog_scope_mismatch"], now);
    }

    let runState: RunState;
    try {
      runState = await this.deps.runState.read(request.run_id);
    } catch {
      return this.#deny(request, ["run_state_unavailable"], now);
    }
    if (runState.terminalized) return this.#deny(request, ["terminal_grant_revoked"], now);

    const credentialClass = catalogEntries[0]!.credential_class;
    let introductionDecision;
    try {
      introductionDecision = await this.deps.authority.authorizeIntroduction(snapshot, {
        operations: request.operations,
        resource: request.resource.resource_id,
        credential_class: credentialClass,
        at: now,
        environment: this.deps.context.environment(),
        receipt_terminalized: runState.terminalized,
        terminal_outcome: runState.terminal_outcome,
      });
    } catch {
      return this.#deny(request, ["authority_verifier_unavailable"], now);
    }
    if (introductionDecision.decision !== "PERMIT") {
      return this.#deny(request, introductionDecision.reasons, now, introductionDecision.events_digest);
    }

    const notBefore = request.not_before ?? snapshot.not_before;
    if (
      Date.parse(notBefore) < Date.parse(snapshot.not_before) ||
      Date.parse(request.expires_at) > Date.parse(snapshot.expires_at)
    ) {
      return this.#deny(request, ["validity_scope_excess"], now);
    }

    let parent: StoredCapabilityHandle | null = null;
    let delegationDigest: string | undefined;
    if (request.parent_handle_id !== undefined) {
      parent = await this.deps.store.get(request.parent_handle_id);
      if (parent === null || parent.state !== "active") return this.#deny(request, ["invalid_parent_handle"], now);
      const parentSnapshot = await this.#resolveRecordAuthority(parent);
      if (parentSnapshot === null) return this.#deny(request, ["unverifiable_parent_authority"], now);
      let delegation;
      try {
        delegation = await this.deps.authority.verifyDelegation(parentSnapshot, snapshot);
      } catch {
        return this.#deny(request, ["delegation_verifier_unavailable"], now);
      }
      if (!delegation.ok || !this.#isScopeSubset(request, parent.handle)) {
        return this.#deny(request, ["delegation_excess", ...delegation.reasons], now, delegation.events_digest);
      }
      delegationDigest = delegation.events_digest;
    }

    const catalogDigest = canonicalPayloadDigest(
      catalogEntries.map(catalogEntryDigestView),
    );
    const handle = this.#makeHandle(
      request,
      catalogEntries[0]!.credential_ref,
      introductionDecision.argument_constraints_digest,
      snapshot.environment_digest,
      now,
    );
    const stored: StoredCapabilityHandle = { handle, state: "introduced", catalog_digest: catalogDigest };
    if (!(await this.deps.store.createIntroduced(stored))) return this.#deny(request, ["handle_store_conflict"], now);

    const events = [
      this.#event("introduction", "PERMIT", request, now, [], handle.record_id, introductionDecision.events_digest),
    ];
    if (parent !== null) {
      events.push(this.#event("attenuation", "PERMIT", request, now, [], handle.record_id, delegationDigest));
    }
    const sequencedEvents = events.map((event, index) => resequenceEvent(event, index + 1));
    let receipts: readonly CanonicalReceiptRef[];
    try {
      receipts = await this.deps.receipts.appendBatch(sequencedEvents);
    } catch {
      await this.deps.store.transition(handle.record_id, "introduced", "closed");
      return { ok: false, reason_codes: ["evidence_unavailable"] };
    }
    if (receipts.length !== sequencedEvents.length || !receipts.every(isCanonicalReceiptRef)) {
      await this.deps.store.transition(handle.record_id, "introduced", "closed");
      return { ok: false, reason_codes: ["invalid_evidence_receipt"] };
    }
    if (!(await this.deps.store.transition(handle.record_id, "introduced", "active", receipts[0]))) {
      return { ok: false, reason_codes: ["handle_activation_conflict"] };
    }
    return { ok: true, value: { handle, introduction_receipt: receipts[0]! } };
  }

  async projectCatalog(runId: string, subjectId: string): Promise<readonly ModelVisibleCapability[]> {
    const records = await this.deps.store.list(runId, subjectId);
    const projected: ModelVisibleCapability[] = [];
    for (const record of records) {
      if (!(await this.#isCurrentlyAuthorized(record))) continue;
      for (const operation of record.handle.operations) {
        const entry = this.deps.catalog.resolve(operation);
        if (entry === null) continue;
        projected.push({
          handle_id: record.handle.record_id,
          operation,
          resource: record.handle.resource,
          required_arguments: [...entry.required_arguments],
          optional_arguments: [...entry.optional_arguments],
          schema_digest: entry.schema_digest,
          ...(entry.model_description === undefined ? {} : { description: sanitizeModelDescription(entry.model_description) }),
        });
      }
    }
    return projected;
  }

  async invoke(request: CapabilityInvocationRequest): Promise<CapabilityResult<CapabilityInvocationValue>> {
    const now = this.deps.context.now();
    const record = await this.deps.store.get(request.handle_id);
    if (record === null) return this.#denyInvocation(request, ["unknown_handle"], now);
    const integrityReasons = this.#validateStoredRecord(record);
    if (integrityReasons.length > 0) return this.#denyFromRecord(record, request, integrityReasons, now);
    if (!(await this.#isCurrentlyUsable(record))) return this.#denyFromRecord(record, request, ["inactive_handle"], now);
    if (!record.handle.operations.includes(request.operation)) {
      return this.#denyFromRecord(record, request, ["operation_not_introduced"], now);
    }
    const entry = this.deps.catalog.resolve(request.operation);
    if (entry === null || !this.#catalogMatchesRecord(entry, record)) {
      return this.#denyFromRecord(record, request, ["catalog_drift"], now);
    }
    const argumentReasons = validateCatalogArguments(entry, request.arguments);
    if (argumentReasons.length > 0) return this.#denyFromRecord(record, request, argumentReasons, now);
    if (entry.effect === "write") {
      return this.#denyFromRecord(record, request, ["action_journal_required"], now);
    }

    const snapshot = await this.#resolveRecordAuthority(record);
    if (snapshot === null) return this.#denyFromRecord(record, request, ["unverifiable_authority"], now);
    const chainReasons = await this.#verifyParentChain(record, snapshot);
    if (chainReasons.length > 0) return this.#denyFromRecord(record, request, chainReasons, now);
    let runState: RunState;
    try {
      runState = await this.deps.runState.read(record.handle.run_id);
    } catch {
      return this.#denyFromRecord(record, request, ["run_state_unavailable"], now);
    }
    let authorityDecision;
    try {
      authorityDecision = await this.deps.authority.evaluate(snapshot, {
        operation: request.operation,
        resource: record.handle.resource.resource_id,
        arguments: request.arguments,
        credential_class: entry.credential_class,
        at: now,
        environment: this.deps.context.environment(),
        receipt_terminalized: runState.terminalized,
        terminal_outcome: runState.terminal_outcome,
      });
    } catch {
      return this.#denyFromRecord(record, request, ["authority_verifier_unavailable"], now);
    }
    if (authorityDecision.decision !== "PERMIT") {
      return this.#denyFromRecord(record, request, authorityDecision.reasons, now, authorityDecision.events_digest);
    }

    const useEvent = this.#eventFromRecord("use", "PERMIT", record, request, now, [], authorityDecision.events_digest);
    let useReceipt: CanonicalReceiptRef;
    try {
      const receipts = await this.deps.receipts.appendBatch([useEvent]);
      if (receipts.length !== 1 || !isCanonicalReceiptRef(receipts[0])) {
        return { ok: false, reason_codes: ["invalid_evidence_receipt"] };
      }
      useReceipt = receipts[0];
    } catch {
      return { ok: false, reason_codes: ["evidence_unavailable"] };
    }

    let output: unknown;
    try {
      output = await this.deps.provider.invoke(
        {
          operation: request.operation,
          resource: record.handle.resource,
          arguments: request.arguments,
          authority: {
            envelope_id: record.handle.envelope.envelope_id,
            run_id: record.handle.run_id,
            handle_id: record.handle.record_id,
          },
        },
        record.handle.credential_ref,
      );
    } catch {
      return { ok: false, reason_codes: ["provider_error"] };
    }
    return {
      ok: true,
      value: {
        output,
        lineage: {
          envelope: record.handle.envelope,
          introduction_receipt: record.introduction_receipt!,
          use_receipt: useReceipt,
          handle_id: record.handle.record_id,
        },
      },
    };
  }

  #validateIntroductionShape(request: CapabilityIntroductionRequest, now: Date): string[] {
    const reasons: string[] = [];
    if (request.envelope.owner !== "evidence-substrate/ZOU-1059" || request.envelope.schema_major !== 1 || !SHA256.test(request.envelope.content_digest)) {
      reasons.push("invalid_authority_ref");
    }
    if (request.operations.length === 0 || new Set(request.operations).size !== request.operations.length) reasons.push("invalid_operations");
    if (
      request.run_id.length === 0 || request.subject_id.length === 0 ||
      request.resource.kind.length === 0 || request.resource.resource_id.length === 0 ||
      request.operations.some((operation) => operation.length === 0)
    ) reasons.push("malformed_introduction");
    const notBefore = Date.parse(request.not_before ?? now.toISOString());
    const expiresAt = Date.parse(request.expires_at);
    if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || now.getTime() < notBefore || now.getTime() >= expiresAt) {
      reasons.push("invalid_validity_window");
    }
    return reasons;
  }

  #catalogEntriesAgree(entries: readonly CapabilityCatalogEntry[], resourceKind: string): boolean {
    const first = entries[0];
    return first !== undefined && entries.every((entry) =>
      entry.resource_kind === resourceKind &&
      entry.credential_ref === first.credential_ref &&
      entry.credential_class === first.credential_class,
    );
  }

  #makeHandle(
    request: CapabilityIntroductionRequest,
    credentialRef: string,
    argumentConstraintsDigest: string,
    environmentDigest: string,
    now: Date,
  ): CapabilityHandleV1 {
    const unsigned = {
      schema_family: "zcr.capability-handle" as const,
      schema_major: 1 as const,
      record_id: this.deps.context.nextId("ch"),
      run_id: request.run_id,
      subject_id: request.subject_id,
      envelope: structuredClone(request.envelope),
      ...(request.parent_handle_id === undefined ? {} : { parent_handle_id: request.parent_handle_id }),
      resource: structuredClone(request.resource),
      operations: [...request.operations].sort(),
      argument_constraints_digest: argumentConstraintsDigest,
      credential_ref: credentialRef,
      environment_constraints_digest: environmentDigest,
      not_before: request.not_before ?? now.toISOString(),
      expires_at: request.expires_at,
      created_at: now.toISOString(),
    };
    return { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
  }

  #isScopeSubset(request: CapabilityIntroductionRequest, parent: CapabilityHandleV1): boolean {
    return request.resource.kind === parent.resource.kind &&
      request.resource.resource_id === parent.resource.resource_id &&
      request.operations.every((operation) => parent.operations.includes(operation)) &&
      Date.parse(request.not_before ?? parent.not_before) >= Date.parse(parent.not_before) &&
      Date.parse(request.expires_at) <= Date.parse(parent.expires_at);
  }

  async #resolveRecordAuthority(record: StoredCapabilityHandle): Promise<VerifiedAuthorityEnvelope | null> {
    try {
      return await this.deps.authority.resolveAndVerify(record.handle.envelope);
    } catch {
      return null;
    }
  }

  async #verifyParentChain(record: StoredCapabilityHandle, snapshot: VerifiedAuthorityEnvelope): Promise<string[]> {
    let childRecord = record;
    let childSnapshot = snapshot;
    const seen = new Set([record.handle.record_id]);
    while (childRecord.handle.parent_handle_id !== undefined) {
      const parentId = childRecord.handle.parent_handle_id;
      if (seen.has(parentId)) return ["delegation_cycle"];
      seen.add(parentId);
      const parent = await this.deps.store.get(parentId);
      if (parent === null || parent.state !== "active") return ["invalid_parent_handle"];
      const parentSnapshot = await this.#resolveRecordAuthority(parent);
      if (parentSnapshot === null) return ["unverifiable_parent_authority"];
      if (this.deps.context.now().getTime() >= Date.parse(parent.handle.expires_at)) return ["expired_parent_handle"];
      const parentEntry = this.deps.catalog.resolve(parent.handle.operations[0]!);
      if (parentEntry === null || !this.#catalogMatchesRecord(parentEntry, parent)) return ["parent_catalog_drift"];
      let parentRunState: RunState;
      try {
        parentRunState = await this.deps.runState.read(parent.handle.run_id);
      } catch {
        return ["parent_run_state_unavailable"];
      }
      if (parentRunState.terminalized) return ["terminal_parent_authority"];
      let delegation;
      let parentDecision;
      try {
        delegation = await this.deps.authority.verifyDelegation(parentSnapshot, childSnapshot);
        parentDecision = await this.deps.authority.authorizeIntroduction(parentSnapshot, {
          operations: parent.handle.operations,
          resource: parent.handle.resource.resource_id,
          credential_class: parentEntry.credential_class,
          at: this.deps.context.now(),
          environment: parentSnapshot.environment,
          receipt_terminalized: parentRunState.terminalized,
          terminal_outcome: parentRunState.terminal_outcome,
        });
      } catch {
        return ["parent_authority_verifier_unavailable"];
      }
      if (parentDecision.decision !== "PERMIT") return ["invalid_parent_authority", ...parentDecision.reasons];
      if (!delegation.ok) return ["delegation_excess", ...delegation.reasons];
      if (!this.#isStoredScopeSubset(childRecord.handle, parent.handle)) return ["delegation_excess"];
      childRecord = parent;
      childSnapshot = parentSnapshot;
    }
    return [];
  }

  #isStoredScopeSubset(child: CapabilityHandleV1, parent: CapabilityHandleV1): boolean {
    return child.resource.kind === parent.resource.kind &&
      child.resource.resource_id === parent.resource.resource_id &&
      child.operations.every((operation) => parent.operations.includes(operation)) &&
      Date.parse(child.not_before) >= Date.parse(parent.not_before) &&
      Date.parse(child.expires_at) <= Date.parse(parent.expires_at);
  }

  #validateStoredRecord(record: StoredCapabilityHandle): string[] {
    const { content_digest: _, ...unsigned } = record.handle;
    const reasons: string[] = [];
    if (canonicalPayloadDigest(unsigned) !== record.handle.content_digest) reasons.push("tampered_handle");
    if (record.state === "active" && record.introduction_receipt === undefined) reasons.push("missing_introduction_receipt");
    return reasons;
  }

  async #isCurrentlyUsable(record: StoredCapabilityHandle): Promise<boolean> {
    if (record.state !== "active") return false;
    const now = this.deps.context.now();
    if (now.getTime() >= Date.parse(record.handle.expires_at)) {
      if (await this.#recordFromRecord(record, "expiry", "DENY", ["validity_window_expired"], now)) {
        await this.deps.store.transition(record.handle.record_id, "active", "expired");
      }
      return false;
    }
    if (now.getTime() < Date.parse(record.handle.not_before)) return false;
    return true;
  }

  async #isCurrentlyAuthorized(record: StoredCapabilityHandle): Promise<boolean> {
    if (!(await this.#isCurrentlyUsable(record))) return false;
    if (this.#validateStoredRecord(record).length > 0) return false;
    const snapshot = await this.#resolveRecordAuthority(record);
    if (snapshot === null || (await this.#verifyParentChain(record, snapshot)).length > 0) return false;
    const entry = this.deps.catalog.resolve(record.handle.operations[0]!);
    if (entry === null || !this.#catalogMatchesRecord(entry, record)) return false;
    let runState: RunState;
    try {
      runState = await this.deps.runState.read(record.handle.run_id);
    } catch {
      return false;
    }
    if (runState.terminalized) return false;
    try {
      const decision = await this.deps.authority.authorizeIntroduction(snapshot, {
        operations: record.handle.operations,
        resource: record.handle.resource.resource_id,
        credential_class: entry.credential_class,
        at: this.deps.context.now(),
        environment: this.deps.context.environment(),
        receipt_terminalized: runState.terminalized,
        terminal_outcome: runState.terminal_outcome,
      });
      return decision.decision === "PERMIT";
    } catch {
      return false;
    }
  }

  #catalogMatchesRecord(entry: CapabilityCatalogEntry, record: StoredCapabilityHandle): boolean {
    const expected = canonicalPayloadDigest(
      record.handle.operations.map((operation) => {
        const current = this.deps.catalog.resolve(operation);
        return current === null ? null : catalogEntryDigestView(current);
      }),
    );
    return entry.resource_kind === record.handle.resource.kind &&
      entry.credential_ref === record.handle.credential_ref &&
      expected === record.catalog_digest;
  }

  async #deny(
    request: CapabilityIntroductionRequest,
    reasons: readonly string[],
    now: Date,
    authorityDigest?: string,
  ): Promise<CapabilityDenial> {
    const event = this.#event("denial", "DENY", request, now, reasons, undefined, authorityDigest);
    return this.#writeDenial(event, reasons);
  }

  async #denyInvocation(
    request: CapabilityInvocationRequest,
    reasons: readonly string[],
    now: Date,
  ): Promise<CapabilityDenial> {
    const seed: CapabilityIntroductionRequest = {
      envelope: { owner: "evidence-substrate/ZOU-1059", envelope_id: "unknown", schema_major: 1, content_digest: "0".repeat(64) },
      run_id: "unknown",
      subject_id: "unknown",
      resource: { kind: "unknown", resource_id: "unknown" },
      operations: [request.operation],
      expires_at: now.toISOString(),
    };
    const event = this.#event("denial", "DENY", seed, now, reasons, request.handle_id);
    return this.#writeDenial(event, reasons);
  }

  async #denyFromRecord(
    record: StoredCapabilityHandle,
    request: CapabilityInvocationRequest,
    reasons: readonly string[],
    now: Date,
    authorityDigest?: string,
  ): Promise<CapabilityDenial> {
    const event = this.#eventFromRecord("denial", "DENY", record, request, now, reasons, authorityDigest);
    return this.#writeDenial(event, reasons);
  }

  async #writeDenial(event: CapabilityEventProposalV1, reasons: readonly string[]): Promise<CapabilityDenial> {
    try {
      const receipts = await this.deps.receipts.appendBatch([event]);
      if (receipts.length !== 1 || !isCanonicalReceiptRef(receipts[0])) {
        return { ok: false, reason_codes: [...new Set([...reasons, "invalid_evidence_receipt"])] };
      }
    } catch {
      return { ok: false, reason_codes: [...new Set([...reasons, "evidence_unavailable"])] };
    }
    return { ok: false, reason_codes: [...new Set(reasons)] };
  }

  #event(
    kind: CapabilityEventKind,
    decision: "PERMIT" | "DENY",
    request: CapabilityIntroductionRequest,
    now: Date,
    reasons: readonly string[],
    handleId?: string,
    authorityDigest?: string,
  ): CapabilityEventProposalV1 {
    const base = {
      schema_family: "zcr.capability-event-proposal" as const,
      schema_major: 1 as const,
      event_id: this.deps.context.nextId("ce"),
      sequence: 1,
      kind,
      decision,
      occurred_at: now.toISOString(),
      run_id: request.run_id,
      subject_id: request.subject_id,
      ...(handleId === undefined ? {} : { handle_id: handleId }),
      ...(request.parent_handle_id === undefined ? {} : { parent_handle_id: request.parent_handle_id }),
      ...(request.operations.length === 0 ? {} : { operation: request.operations.join(",") }),
      resource_digest: canonicalPayloadDigest(request.resource),
      envelope: structuredClone(request.envelope),
      reason_codes: [...reasons],
      ...(authorityDigest === undefined ? {} : { authority_events_digest: authorityDigest }),
      rule_digest: RULE_DIGEST,
    };
    return { ...base, content_digest: canonicalPayloadDigest(base) };
  }

  #eventFromRecord(
    kind: CapabilityEventKind,
    decision: "PERMIT" | "DENY",
    record: StoredCapabilityHandle,
    request: CapabilityInvocationRequest,
    now: Date,
    reasons: readonly string[],
    authorityDigest?: string,
  ): CapabilityEventProposalV1 {
    const event = this.#event(kind, decision, {
      envelope: record.handle.envelope,
      run_id: record.handle.run_id,
      subject_id: record.handle.subject_id,
      ...(record.handle.parent_handle_id === undefined ? {} : { parent_handle_id: record.handle.parent_handle_id }),
      resource: record.handle.resource,
      operations: record.handle.operations,
      expires_at: record.handle.expires_at,
    }, now, reasons, record.handle.record_id, authorityDigest);
    const { content_digest: _, ...base } = event;
    const withOperation = { ...base, operation: request.operation };
    return { ...withOperation, content_digest: canonicalPayloadDigest(withOperation) };
  }

  async #recordFromRecord(
    record: StoredCapabilityHandle,
    kind: CapabilityEventKind,
    decision: "PERMIT" | "DENY",
    reasons: readonly string[],
    now: Date,
  ): Promise<boolean> {
    const request: CapabilityInvocationRequest = { handle_id: record.handle.record_id, operation: "lifecycle", arguments: {} };
    try {
      const receipts = await this.deps.receipts.appendBatch([this.#eventFromRecord(kind, decision, record, request, now, reasons)]);
      return receipts.length === 1 && isCanonicalReceiptRef(receipts[0]);
    } catch {
      return false;
    }
  }
}

function validateCatalogArguments(
  entry: CapabilityCatalogEntry,
  args: Readonly<Record<string, string | number | boolean>>,
): string[] {
  const reasons: string[] = [];
  const allowed = new Set([...entry.required_arguments, ...entry.optional_arguments]);
  if (Object.values(args).some((value) => !["string", "number", "boolean"].includes(typeof value))) {
    reasons.push("invalid_argument_type");
  }
  if (Object.keys(args).some((key) => !allowed.has(key))) reasons.push("unknown_argument");
  if (entry.required_arguments.some((key) => !(key in args))) reasons.push("missing_argument");
  if (Object.values(args).some((value) => typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))) {
    reasons.push("non_canonical_argument");
  }
  return reasons;
}

function isCanonicalReceiptRef(value: unknown): value is CanonicalReceiptRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Partial<CanonicalReceiptRef>;
  return ref.owner === "evidence-substrate/ZOU-1051" &&
    ref.schema_major === 1 &&
    typeof ref.receipt_id === "string" && ref.receipt_id.length > 0 &&
    typeof ref.content_digest === "string" && SHA256.test(ref.content_digest);
}

function resequenceEvent(event: CapabilityEventProposalV1, sequence: number): CapabilityEventProposalV1 {
  const { content_digest: _, ...base } = event;
  const sequenced = { ...base, sequence };
  return { ...sequenced, content_digest: canonicalPayloadDigest(sequenced) };
}

function catalogEntryDigestView(entry: CapabilityCatalogEntry): unknown {
  return {
    operation: entry.operation,
    resource_kind: entry.resource_kind,
    credential_ref: entry.credential_ref,
    credential_class: entry.credential_class,
    effect: entry.effect,
    required_arguments: [...entry.required_arguments].sort(),
    optional_arguments: [...entry.optional_arguments].sort(),
    schema_digest: entry.schema_digest,
  };
}

function sanitizeModelDescription(description: string): string {
  return description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
}
