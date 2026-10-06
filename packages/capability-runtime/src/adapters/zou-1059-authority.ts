import { createRequire } from "node:module";
import type {
  AuthorityEnvelopeRef,
  AuthorityEvaluation,
  AuthorityEvaluationInput,
  AuthorityVerifier,
  VerifiedAuthorityEnvelope,
} from "../contracts/capability.js";
import { canonicalPayloadDigest } from "../fingerprint.js";

interface ArgumentConstraint {
  readonly const?: string | number | boolean;
  readonly pattern?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly max_length?: number;
}

interface CapabilityGrant {
  readonly capability: string;
  readonly resources: readonly string[];
  readonly argument_constraints: Readonly<Record<string, ArgumentConstraint>>;
  readonly credential_classes: readonly string[];
  readonly revoked_at: string | null;
}

interface AuthorityEnvelope {
  readonly schema_version: number;
  readonly envelope_id: string;
  readonly principal: { readonly id: string };
  readonly capabilities: readonly CapabilityGrant[];
  readonly validity: { readonly not_before: string; readonly expires_at: string };
  readonly environment: AuthorityEvaluationInput["environment"];
  readonly approval_binding: { readonly run_id: string };
  readonly enforcement_evidence: { readonly kind: string; readonly evidence_ref: string; readonly sha256: string };
}

interface EvaluationResult {
  readonly decision: "PERMIT" | "DENY";
  readonly reasons: readonly string[];
  readonly events: readonly unknown[];
}

interface DelegationResult {
  readonly ok: boolean;
  readonly issues: readonly { readonly dimension: string; readonly message: string }[];
  readonly events: readonly unknown[];
}

export interface Zou1059OwnerContract {
  sha256Hex(payload: string): string;
  validateEnvelope(input: unknown): { readonly ok: boolean };
  resourceMatches(pattern: string, resource: string): boolean;
  evaluateRequest(envelope: unknown, request: unknown, context: unknown): EvaluationResult;
  validateDelegation(parent: unknown, child: unknown): DelegationResult;
}

export interface AuthorityEnvelopeDocument {
  readonly canonical_payload: string;
  readonly enforcement_evidence_payload: string;
}

export interface AuthorityEnvelopeDocumentSource {
  load(envelopeId: string): Promise<AuthorityEnvelopeDocument | null>;
}

interface ResolvedDocument {
  readonly envelope: AuthorityEnvelope;
  readonly evidencePayload: string;
}

const require = createRequire(import.meta.url);

function loadRepositoryOwner(): Zou1059OwnerContract {
  return require("../../../../Projects/zouroboros-software-factory/scripts/authority-envelope.ts") as Zou1059OwnerContract;
}

export class Zou1059AuthorityVerifier implements AuthorityVerifier {
  readonly #resolved = new WeakMap<VerifiedAuthorityEnvelope, ResolvedDocument>();

  constructor(
    private readonly source: AuthorityEnvelopeDocumentSource,
    private readonly owner: Zou1059OwnerContract = loadRepositoryOwner(),
  ) {}

  async resolveAndVerify(ref: AuthorityEnvelopeRef): Promise<VerifiedAuthorityEnvelope | null> {
    if (ref.owner !== "evidence-substrate/ZOU-1059" || ref.schema_major !== 1) return null;
    const document = await this.source.load(ref.envelope_id);
    if (document === null || this.owner.sha256Hex(document.canonical_payload) !== ref.content_digest) return null;
    let candidate: unknown;
    try {
      candidate = JSON.parse(document.canonical_payload);
    } catch {
      return null;
    }
    if (!this.owner.validateEnvelope(candidate).ok) return null;
    const envelope = candidate as AuthorityEnvelope;
    if (envelope.envelope_id !== ref.envelope_id || envelope.schema_version !== ref.schema_major) return null;
    if (this.owner.sha256Hex(document.enforcement_evidence_payload) !== envelope.enforcement_evidence.sha256) return null;
    const snapshot = Object.freeze({
      ref: structuredClone(ref),
      run_id: envelope.approval_binding.run_id,
      subject_id: envelope.principal.id,
      not_before: envelope.validity.not_before,
      expires_at: envelope.validity.expires_at,
      environment: structuredClone(envelope.environment),
      environment_digest: canonicalPayloadDigest(envelope.environment),
    }) as VerifiedAuthorityEnvelope;
    this.#resolved.set(snapshot, { envelope, evidencePayload: document.enforcement_evidence_payload });
    return snapshot;
  }

  async authorizeIntroduction(
    snapshot: VerifiedAuthorityEnvelope,
    input: Omit<AuthorityEvaluationInput, "operation" | "arguments"> & { readonly operations: readonly string[] },
  ): Promise<AuthorityEvaluation & { readonly argument_constraints_digest: string }> {
    const resolved = this.#require(snapshot);
    const reasons: string[] = [];
    const at = input.at.getTime();
    if (at < Date.parse(resolved.envelope.validity.not_before)) reasons.push("validity_window_not_started");
    if (at >= Date.parse(resolved.envelope.validity.expires_at)) reasons.push("validity_window_expired");
    if (input.receipt_terminalized) reasons.push("terminal_grant_revoked");
    if (canonicalPayloadDigest(input.environment) !== snapshot.environment_digest) reasons.push("environment_mismatch");
    const constraints: unknown[] = [];
    for (const operation of input.operations) {
      const grant = resolved.envelope.capabilities.find((entry) => entry.capability === operation);
      if (grant === undefined) {
        reasons.push("unknown_capability");
        continue;
      }
      if (grant.revoked_at !== null) reasons.push("terminal_grant_revoked");
      if (!grant.resources.some((pattern) => this.owner.resourceMatches(pattern, input.resource))) reasons.push("resource_not_listed");
      if (!grant.credential_classes.includes(input.credential_class)) reasons.push("credential_class_not_granted");
      constraints.push({ operation, constraints: grant.argument_constraints });
    }
    const uniqueReasons = [...new Set(reasons)];
    return {
      decision: uniqueReasons.length === 0 ? "PERMIT" : "DENY",
      reasons: uniqueReasons,
      events_digest: canonicalPayloadDigest({ operations: input.operations, reasons: uniqueReasons, at: input.at.toISOString() }),
      argument_constraints_digest: canonicalPayloadDigest(constraints),
    };
  }

  async evaluate(snapshot: VerifiedAuthorityEnvelope, input: AuthorityEvaluationInput): Promise<AuthorityEvaluation> {
    const resolved = this.#require(snapshot);
    const result = this.owner.evaluateRequest(resolved.envelope, {
      capability: input.operation,
      resource: input.resource,
      arguments: { ...input.arguments },
      credential_class: input.credential_class,
      ts: input.at.toISOString(),
      environment: { ...input.environment },
      enforcement_evidence: {
        kind: resolved.envelope.enforcement_evidence.kind,
        evidence_ref: resolved.envelope.enforcement_evidence.evidence_ref,
        payload: resolved.evidencePayload,
      },
    }, {
      receipt_terminalized: input.receipt_terminalized,
      terminal_outcome: input.terminal_outcome,
    });
    return {
      decision: result.decision,
      reasons: result.reasons,
      events_digest: canonicalPayloadDigest(result.events),
    };
  }

  async verifyDelegation(
    parent: VerifiedAuthorityEnvelope,
    child: VerifiedAuthorityEnvelope,
  ): Promise<{ readonly ok: boolean; readonly reasons: readonly string[]; readonly events_digest: string }> {
    const result = this.owner.validateDelegation(this.#require(parent).envelope, this.#require(child).envelope);
    return {
      ok: result.ok,
      reasons: result.issues.map((issue) => `${issue.dimension}:${issue.message}`),
      events_digest: canonicalPayloadDigest(result.events),
    };
  }

  #require(snapshot: VerifiedAuthorityEnvelope): ResolvedDocument {
    const resolved = this.#resolved.get(snapshot);
    if (resolved === undefined) throw new Error("unverified authority snapshot");
    return resolved;
  }
}
