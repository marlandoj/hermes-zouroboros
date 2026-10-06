import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ActionApprovalV1, ActionResource, SignedActionApproval } from "../contracts/types.js";

export interface ExactActionPayload {
  readonly tool_id: string;
  readonly resource: ActionResource;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface TrustedActionRender {
  readonly title: string;
  readonly tool_id: string;
  readonly resource: ActionResource;
  readonly canonical_arguments: string;
  readonly canonical_payload: string;
  readonly canonical_payload_digest: string;
  readonly resource_digest: string;
  readonly renderer_id: "zcr.trusted-action-renderer";
  readonly renderer_version: 1;
  readonly renderer_digest: string;
}

export interface ActionApprovalBinding {
  readonly action_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly canonical_payload_digest: string;
  readonly tool_id: string;
  readonly resource_digest: string;
  readonly plan_decision?: ActionApprovalV1["plan_decision"];
}

export interface TrustedActionPublicKey {
  readonly public_key: string;
  readonly not_before: string;
  readonly not_after?: string;
  readonly revoked?: boolean;
}

export type TrustedActionKeys = Readonly<Record<string, TrustedActionPublicKey | string>>;

export function canonicalizeExactValue(value: unknown, path = "$", seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`non-canonical number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const canonical: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`sparse array at ${path}[${index}]`);
      canonical.push(canonicalizeExactValue(value[index], `${path}[${index}]`, seen));
    }
    seen.delete(value);
    return canonical;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`non-plain object at ${path}`);
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new Error(`unsupported value at ${path}.${key}`);
      }
      sorted[key] = canonicalizeExactValue(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return sorted;
  }
  throw new Error(`unsupported value at ${path}`);
}

export function canonicalizeExactAction(payload: ExactActionPayload): string {
  if (!payload.tool_id || !payload.resource.kind || !payload.resource.resource_id) {
    throw new Error("exact action requires tool and resource identifiers");
  }
  assertNoProjectedRefs(payload.arguments);
  return JSON.stringify(canonicalizeExactValue(payload));
}

export function assertNoProjectedRefs(value: unknown, path = "$.arguments", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
  seen.add(value);
  if (!Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "projected") throw new Error(`unresolved projected reference at ${path}`);
    for (const [key, child] of Object.entries(candidate)) assertNoProjectedRefs(child, `${path}.${key}`, seen);
  } else {
    for (let index = 0; index < value.length; index += 1) assertNoProjectedRefs(value[index], `${path}[${index}]`, seen);
  }
  seen.delete(value);
}

export function exactActionDigest(payload: ExactActionPayload): string {
  return createHash("sha256").update(canonicalizeExactAction(payload), "utf8").digest("hex");
}

export function parseCanonicalExactAction(canonicalPayload: string): ExactActionPayload {
  const parsed = JSON.parse(canonicalPayload) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("canonical exact action must be an object");
  }
  const candidate = parsed as Partial<ExactActionPayload>;
  if (typeof candidate.tool_id !== "string" || candidate.resource === undefined || candidate.arguments === undefined) {
    throw new Error("canonical exact action fields are missing");
  }
  const exact = candidate as ExactActionPayload;
  if (canonicalizeExactAction(exact) !== canonicalPayload) throw new Error("exact action bytes are not canonical");
  return exact;
}

export function renderTrustedAction(payload: ExactActionPayload): TrustedActionRender {
  const canonicalPayload = canonicalizeExactAction(payload);
  const resourceCanonical = JSON.stringify(canonicalizeExactValue(payload.resource));
  return {
    title: `${payload.tool_id} on ${payload.resource.kind}:${payload.resource.resource_id}`,
    tool_id: payload.tool_id,
    resource: structuredClone(payload.resource),
    canonical_arguments: JSON.stringify(canonicalizeExactValue(payload.arguments)),
    canonical_payload: canonicalPayload,
    canonical_payload_digest: createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
    resource_digest: createHash("sha256").update(resourceCanonical, "utf8").digest("hex"),
    renderer_id: "zcr.trusted-action-renderer",
    renderer_version: 1,
    renderer_digest: createHash("sha256").update(JSON.stringify({
      renderer_id: "zcr.trusted-action-renderer",
      renderer_version: 1,
      fields: ["title", "tool_id", "resource", "canonical_arguments", "canonical_payload", "canonical_payload_digest", "resource_digest"],
      escaping: "consumer-must-render-as-text",
    }), "utf8").digest("hex"),
  };
}

export function actionApprovalDigest(approval: Omit<ActionApprovalV1, "content_digest">): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeExactValue(approval)), "utf8").digest("hex");
}

export function actionRecordDigest(record: Readonly<Record<string, unknown>>): string {
  const { content_digest: _contentDigest, ...unsigned } = record;
  return createHash("sha256").update(JSON.stringify(canonicalizeExactValue(unsigned)), "utf8").digest("hex");
}

export function approvalSigningPayload(approval: ActionApprovalV1): string {
  return `zcr.action-approval\0v1\0${JSON.stringify(canonicalizeExactValue(approval))}`;
}

export function signActionApproval(
  approval: ActionApprovalV1,
  input: { readonly key_id: string; readonly private_key: string },
): SignedActionApproval {
  if (!input.key_id) throw new Error("action approval key_id is required");
  const signature = sign(
    null,
    Buffer.from(approvalSigningPayload(approval), "utf8"),
    createPrivateKey(input.private_key),
  ).toString("base64url");
  return { approval, key_id: input.key_id, algorithm: "Ed25519", signature };
}

export function verifySignedActionApproval(
  signed: SignedActionApproval,
  input: {
    readonly trusted_keys: TrustedActionKeys;
    readonly now: Date;
    readonly binding?: ActionApprovalBinding;
    readonly require_approval?: boolean;
  },
): { readonly valid: boolean; readonly reason?: string } {
  const approval = signed.approval;
  if (approval.schema_family !== "zcr.action-approval" || approval.schema_major !== 1) {
    return { valid: false, reason: "approval_schema_invalid" };
  }
  if (
    !approval.record_id || !approval.action_id || !approval.run_id || !approval.actor_id || !approval.session_id ||
    !approval.capability_handle_id || !approval.tool_id || !/^[a-f0-9]{64}$/.test(approval.resource_digest) ||
    !/^[a-f0-9]{64}$/.test(approval.canonical_payload_digest) || !/^[a-f0-9]{64}$/.test(approval.content_digest)
  ) {
    return { valid: false, reason: "approval_structure_invalid" };
  }
  const { content_digest: _contentDigest, ...unsigned } = approval;
  if (actionApprovalDigest(unsigned) !== approval.content_digest) {
    return { valid: false, reason: "approval_content_digest_invalid" };
  }
  const entry = input.trusted_keys[signed.key_id];
  if (signed.algorithm !== "Ed25519") return { valid: false, reason: "approval_algorithm_invalid" };
  if (entry === undefined) return { valid: false, reason: "approval_key_untrusted" };
  const normalized = typeof entry === "string" ? { public_key: entry, not_before: "1970-01-01T00:00:00Z" } : entry;
  const now = input.now.getTime();
  const decidedAt = Date.parse(approval.decided_at);
  const expiresAt = Date.parse(approval.expires_at);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(expiresAt) || expiresAt <= decidedAt) {
    return { valid: false, reason: "approval_time_invalid" };
  }
  if (decidedAt > now) return { valid: false, reason: "approval_not_yet_valid" };
  if (now >= expiresAt) return { valid: false, reason: "approval_expired" };
  if (input.require_approval !== false && approval.decision !== "approve") {
    return { valid: false, reason: "approval_decision_not_approve" };
  }
  if (normalized.revoked) return { valid: false, reason: "approval_key_revoked" };
  const keyNotBefore = Date.parse(normalized.not_before);
  const keyNotAfter = normalized.not_after === undefined ? undefined : Date.parse(normalized.not_after);
  if (!Number.isFinite(keyNotBefore) || (keyNotAfter !== undefined && !Number.isFinite(keyNotAfter))) {
    return { valid: false, reason: "approval_key_time_invalid" };
  }
  if (now < keyNotBefore) return { valid: false, reason: "approval_key_not_active" };
  if (keyNotAfter !== undefined && now >= keyNotAfter) {
    return { valid: false, reason: "approval_key_expired" };
  }
  const binding = input.binding;
  if (binding !== undefined) {
    const approvalPlan = approval.plan_decision === undefined ? undefined : JSON.stringify(canonicalizeExactValue(approval.plan_decision));
    const bindingPlan = binding.plan_decision === undefined ? undefined : JSON.stringify(canonicalizeExactValue(binding.plan_decision));
    const mismatched =
      approval.action_id !== binding.action_id ||
      approval.run_id !== binding.run_id ||
      approval.capability_handle_id !== binding.capability_handle_id ||
      approval.canonical_payload_digest !== binding.canonical_payload_digest ||
      approval.tool_id !== binding.tool_id ||
      approval.resource_digest !== binding.resource_digest ||
      approvalPlan !== bindingPlan;
    if (mismatched) return { valid: false, reason: "approval_binding_mismatch" };
  }
  try {
    return verify(
      null,
      Buffer.from(approvalSigningPayload(signed.approval), "utf8"),
      createPublicKey(normalized.public_key),
      Buffer.from(signed.signature, "base64url"),
    ) ? { valid: true } : { valid: false, reason: "approval_signature_invalid" };
  } catch {
    return { valid: false, reason: "approval_trust_material_invalid" };
  }
}
