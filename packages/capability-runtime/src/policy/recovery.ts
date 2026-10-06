import type { ActionState, DispatchBoundary, EffectClass } from "../contracts/types.js";
import { classifyEffect } from "./effect-classes.js";

export type ProviderEvidence =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly reason: string }
  | { readonly kind: "confirmed_applied"; readonly evidenceDigest: string }
  | { readonly kind: "confirmed_not_applied"; readonly evidenceDigest: string };

export interface InterruptedAction {
  readonly state: ActionState;
  readonly dispatchBoundary: DispatchBoundary;
}

/**
 * Crash invariant #2 (STATE-MACHINES.md): recovery treats every `applying`
 * record with uncertain provider confirmation as outcome_unknown, never
 * failed_retryable. failed_retryable requires positive proof of non-acceptance;
 * it is never inferred from a timeout or crash alone.
 */
export function recoverInterruptedAction(action: InterruptedAction, evidence: ProviderEvidence): ActionState {
  if (action.state !== "applying") {
    throw new Error(`recovery only applies to applying records, got state=${action.state}`);
  }
  if (action.dispatchBoundary !== "claimed") {
    throw new Error(`applying recovery requires a claimed dispatch boundary, got ${action.dispatchBoundary}`);
  }
  switch (evidence.kind) {
    case "confirmed_applied":
      return "applied";
    case "confirmed_not_applied":
      return "failed_retryable";
    case "none":
    case "ambiguous":
      return "outcome_unknown";
  }
}

export type RetryDecision =
  | { readonly kind: "retry_dispatch" }
  | { readonly kind: "require_reconciliation" };

export interface RetryContext {
  readonly effectClass: EffectClass;
  readonly providerIdempotencyKey: string | undefined;
  readonly providerIdempotencySemanticsVerified: boolean;
  readonly payloadDigestUnchanged: boolean;
}

/**
 * Crash invariant #3: a retry reuses a stable provider idempotency key only
 * for a provider whose semantics are verified and whose payload digest is
 * unchanged. Every other class — including an unverified claim of
 * provider_idempotent_write — must reconcile before any replacement dispatch.
 * This is the enforcement point for "provider idempotency is used only when
 * documented and verified."
 */
export function decideRetryAfterOutcomeUnknown(ctx: RetryContext): RetryDecision {
  const profile = classifyEffect(ctx.effectClass);
  const canReuseIdempotencyKey =
    profile.eligibleForVerifiedIdempotentRetry &&
    ctx.providerIdempotencyKey !== undefined &&
    ctx.providerIdempotencySemanticsVerified &&
    ctx.payloadDigestUnchanged;
  return canReuseIdempotencyKey ? { kind: "retry_dispatch" } : { kind: "require_reconciliation" };
}
