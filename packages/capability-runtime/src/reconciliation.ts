import type { ActionState, ReconciliationRecordV1, ReconciliationResolution } from "./contracts/types.js";

export interface RecordReconciliationInput {
  readonly recordId: string;
  readonly actionId: string;
  readonly actionState: ActionState;
  readonly resolution: ReconciliationResolution;
  readonly reconciledBy: string;
  readonly reconciledAt: string;
  readonly providerQueryDigest: string;
  readonly providerEvidenceDigest?: string;
  readonly replacementActionId?: string;
  /** Prior unresolved reconciliation record for the same action, if this query supersedes one. Never mutated or deleted. */
  readonly supersedesRecordId?: string;
}

/**
 * STATE-MACHINES.md: `reconciled` is reachable only from `outcome_unknown`.
 * A reconciliation record for any other action state is a contract violation,
 * not a recoverable no-op — reconciliation is append-only and must never be
 * used to paper over a missing outcome_unknown transition.
 */
export function recordReconciliation(input: RecordReconciliationInput): ReconciliationRecordV1 {
  if (input.actionState !== "outcome_unknown") {
    throw new Error(
      `reconciliation requires an outcome_unknown action, got state=${input.actionState} for action=${input.actionId}`,
    );
  }
  return {
    schema_family: "zcr.reconciliation",
    schema_major: 1,
    record_id: input.recordId,
    action_id: input.actionId,
    provider_query_digest: input.providerQueryDigest,
    resolution: input.resolution,
    provider_evidence_digest: input.providerEvidenceDigest,
    reconciled_by: input.reconciledBy,
    reconciled_at: input.reconciledAt,
    replacement_action_id: input.replacementActionId,
    supersedes_record_id: input.supersedesRecordId,
  };
}

/**
 * Only a definitive resolution (applied, not_applied, partially_applied)
 * moves the action to `reconciled`. `unresolved` leaves it in outcome_unknown
 * so a later query can supersede it without an in-place history change.
 */
export function nextActionStateAfterReconciliation(resolution: ReconciliationResolution): ActionState {
  return resolution === "unresolved" ? "outcome_unknown" : "reconciled";
}

/**
 * ZCR-005 acceptance criterion: "Replacement cannot proceed until
 * reconciliation is recorded." STATE-MACHINES.md further narrows this to a
 * `not_applied` resolution — an `applied` or `partially_applied` action
 * already has a landed effect, so a caller needs a compensating action, not a
 * replacement dispatch.
 */
export function isReplacementDispatchAllowed(
  actionState: ActionState,
  reconciliation: ReconciliationRecordV1 | undefined,
): boolean {
  if (actionState !== "reconciled") return false;
  if (!reconciliation) return false;
  return reconciliation.resolution === "not_applied";
}
