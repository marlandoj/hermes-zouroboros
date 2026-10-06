import { createHash } from "node:crypto";
import type { ShadowConsumerEventV1, ShadowScalar } from "./shadow-contracts.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scalarize(input: Readonly<Record<string, ShadowScalar | undefined>>): Record<string, ShadowScalar> {
  const output: Record<string, ShadowScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export interface AutoloopShadowInput {
  readonly targetFile: string;
  readonly experiment: number;
  readonly commit?: string;
  readonly hypothesis?: string;
  readonly runId: string;
  readonly occurredAt?: string;
}

export function autoloopShadowEvent(input: AutoloopShadowInput): ShadowConsumerEventV1 {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    schema_family: "zcr.shadow-consumer-event",
    schema_major: 1,
    consumer: "autoloop",
    event_id: `autoloop/${input.runId}/exp-${input.experiment}`,
    operation: "autoloop.apply-candidate",
    effect: "write",
    effect_class: "reconcilable_write",
    resource: { kind: "autoloop-target", resource_id: `autoloop/${input.targetFile}` },
    arguments: scalarize({
      experiment: input.experiment,
      commit: input.commit,
      hypothesis_digest: input.hypothesis === undefined ? undefined : sha256(input.hypothesis),
    }),
    occurred_at: occurredAt,
    run_id: input.runId,
    subject_id: "autoloop",
  };
}

export interface SwarmShadowInput {
  readonly executionId: string;
  readonly ticketIdentifier: string;
  readonly gateDecision?: string;
  readonly stage?: string;
  readonly occurredAt?: string;
}

export function swarmShadowEvent(input: SwarmShadowInput): ShadowConsumerEventV1 {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    schema_family: "zcr.shadow-consumer-event",
    schema_major: 1,
    consumer: "swarm",
    event_id: `swarm/${input.executionId}`,
    operation: "swarm.enqueue-execution",
    effect: "write",
    effect_class: "reconcilable_write",
    resource: { kind: "swarm-campaign", resource_id: `swarm-campaigns/${input.executionId}` },
    arguments: scalarize({
      ticket: input.ticketIdentifier,
      gate_decision: input.gateDecision,
      stage: input.stage,
    }),
    occurred_at: occurredAt,
    run_id: input.executionId,
    subject_id: "swarm-exec",
  };
}

export interface FactoryShadowInput {
  readonly ticketIdentifier: string;
  readonly decision: string;
  readonly score?: number;
  readonly lane?: string;
  readonly dispatchId?: string;
  readonly occurredAt?: string;
}

export function factoryShadowEvent(input: FactoryShadowInput): ShadowConsumerEventV1 {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const dispatchId = input.dispatchId ?? `${input.ticketIdentifier}/${occurredAt}`;
  return {
    schema_family: "zcr.shadow-consumer-event",
    schema_major: 1,
    consumer: "factory",
    event_id: `factory/${dispatchId}`,
    operation: "factory.dispatch-ticket",
    effect: "write",
    effect_class: "reconcilable_write",
    resource: { kind: "factory-ticket", resource_id: `factory-tickets/${input.ticketIdentifier}` },
    arguments: scalarize({
      decision: input.decision,
      score: input.score,
      lane: input.lane,
    }),
    occurred_at: occurredAt,
    run_id: dispatchId,
    subject_id: "factory-dispatcher",
  };
}
