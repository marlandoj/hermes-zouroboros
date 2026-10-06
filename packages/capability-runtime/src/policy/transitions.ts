import type { ActionState } from "../contracts/types.js";

// Mirrors the "Action lifecycle" table in STATE-MACHINES.md verbatim. Two edges
// carry a documented guard (approval expiry / continued validity); those guards
// are exposed as separate predicates below rather than folded into the edge set,
// since a durable journal (ZCR-003) — not this pure policy layer — is the
// transition owner responsible for evaluating them.
const ALLOWED_PREDECESSORS: Readonly<Record<ActionState, ReadonlySet<ActionState>>> = {
  staged: new Set([]),
  awaiting_approval: new Set(["staged", "failed_retryable"]),
  approved: new Set(["awaiting_approval", "failed_retryable"]),
  rejected: new Set(["awaiting_approval"]),
  canceled: new Set(["staged", "awaiting_approval", "approved"]),
  applying: new Set(["approved"]),
  applied: new Set(["applying"]),
  failed_retryable: new Set(["applying"]),
  outcome_unknown: new Set(["applying"]),
  reconciled: new Set(["outcome_unknown"]),
  compensated: new Set(["applied", "reconciled"]),
};

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ALLOWED_PREDECESSORS[to].has(from);
}

export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal action transition: ${from} -> ${to}`);
  }
}

// STATE-MACHINES.md: "awaiting_approval | staged, failed_retryable when approval expired"
export function canReturnToAwaitingApproval(from: ActionState, approvalExpired: boolean): boolean {
  if (from === "staged") return true;
  if (from === "failed_retryable") return approvalExpired;
  return false;
}

// STATE-MACHINES.md: "approved | awaiting_approval; failed_retryable with still-valid approval"
export function canReturnToApproved(from: ActionState, approvalStillValid: boolean): boolean {
  if (from === "awaiting_approval") return true;
  if (from === "failed_retryable") return approvalStillValid;
  return false;
}

// "canceled | staged, awaiting_approval, approved before dispatch"
export function canCancel(from: ActionState, dispatchBoundary: "not_dispatched" | "claimed" | "provider_confirmed"): boolean {
  if (dispatchBoundary !== "not_dispatched") return false;
  return from === "staged" || from === "awaiting_approval" || from === "approved";
}
