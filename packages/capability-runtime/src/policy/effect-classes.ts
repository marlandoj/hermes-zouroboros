import type { EffectClass } from "../contracts/types.js";

export interface EffectClassProfile {
  readonly effectClass: EffectClass;
  /** A definitive provider-side failure proof clears the effect for retry. Always true; kept explicit for readability at call sites. */
  readonly retryOnDefiniteFailure: boolean;
  /**
   * Whether a bare `provider_idempotency_key` may be trusted to retry-dispatch
   * without reconciliation after an ambiguous interruption. Only true for
   * provider_idempotent_write, and even then only when the caller also proves
   * the provider's idempotency semantics are documented and verified
   * (see canRetryOnProviderIdempotency in recovery.ts) — ADR-003: "Provider
   * idempotency is used only where its semantics are documented and verified."
   */
  readonly eligibleForVerifiedIdempotentRetry: boolean;
  /** Whether an `applied` or partially-applied record of this class may ever be undone by a compensating action. */
  readonly compensable: boolean;
}

const PROFILES: Readonly<Record<EffectClass, EffectClassProfile>> = {
  provider_idempotent_write: {
    effectClass: "provider_idempotent_write",
    retryOnDefiniteFailure: true,
    eligibleForVerifiedIdempotentRetry: true,
    compensable: true,
  },
  reconcilable_write: {
    effectClass: "reconcilable_write",
    retryOnDefiniteFailure: true,
    eligibleForVerifiedIdempotentRetry: false,
    compensable: true,
  },
  non_idempotent_write: {
    effectClass: "non_idempotent_write",
    retryOnDefiniteFailure: true,
    eligibleForVerifiedIdempotentRetry: false,
    compensable: true,
  },
  destructive_write: {
    effectClass: "destructive_write",
    retryOnDefiniteFailure: true,
    eligibleForVerifiedIdempotentRetry: false,
    compensable: false,
  },
  compensating_write: {
    effectClass: "compensating_write",
    retryOnDefiniteFailure: true,
    eligibleForVerifiedIdempotentRetry: false,
    compensable: false,
  },
};

export function classifyEffect(effectClass: EffectClass): EffectClassProfile {
  return PROFILES[effectClass];
}
