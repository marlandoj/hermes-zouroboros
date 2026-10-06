import type { ActionResource, EffectClass } from "../contracts/types.js";

export const SHADOW_CONSUMERS = ["autoloop", "swarm", "factory"] as const;
export type ShadowConsumer = (typeof SHADOW_CONSUMERS)[number];

export type ShadowScalar = string | number | boolean;

const SHADOW_EFFECT_CLASSES: readonly EffectClass[] = [
  "provider_idempotent_write",
  "reconcilable_write",
  "non_idempotent_write",
  "destructive_write",
  "compensating_write",
];

export interface ShadowConsumerEventV1 {
  readonly schema_family: "zcr.shadow-consumer-event";
  readonly schema_major: 1;
  readonly consumer: ShadowConsumer;
  /** Consumer-scoped unique identifier; the durable idempotency key for replay-safe observation. */
  readonly event_id: string;
  readonly operation: string;
  readonly effect: "read" | "write";
  readonly effect_class?: EffectClass;
  readonly resource: ActionResource;
  readonly arguments: Readonly<Record<string, ShadowScalar>>;
  readonly occurred_at: string;
  readonly run_id: string;
  readonly subject_id: string;
}

export type ShadowOutcome =
  | "staged_awaiting_approval"
  | "read_permitted"
  | "denied"
  | "duplicate_event"
  | "adapter_error";

export interface ShadowVerdictRecordV1 {
  readonly schema_family: "zcr.shadow-verdict";
  readonly schema_major: 1;
  readonly verdict_id: string;
  readonly consumer: ShadowConsumer;
  readonly event_id: string;
  readonly operation: string;
  readonly resource: ActionResource;
  readonly occurred_at: string;
  readonly observed_at: string;
  readonly outcome: ShadowOutcome;
  readonly reason_codes: readonly string[];
  readonly handle_id: string | null;
  readonly action_id: string | null;
  /** Always "off" in ZCR-008: verdicts are recorded, never applied to the host flow. */
  readonly enforcement: "off";
  readonly envelope_id: string;
  readonly catalog_digest: string;
  readonly content_digest: string;
}

export interface ShadowWindowStatus {
  readonly total_verdicts: number;
  readonly eligible_events: number;
  readonly distinct_days: number;
  readonly first_at: string | null;
  readonly last_at: string | null;
  readonly by_consumer: Readonly<Record<ShadowConsumer, number>>;
  readonly by_outcome: Readonly<Partial<Record<ShadowOutcome, number>>>;
  readonly target_events: number;
  readonly target_days: number;
  readonly satisfied: boolean;
}

export interface ShadowRuntimeConfig {
  readonly stateDir: string;
  readonly now?: () => Date;
}

export function isShadowConsumerEvent(value: unknown): value is ShadowConsumerEventV1 {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<ShadowConsumerEventV1>;
  const scalarArgs =
    typeof event.arguments === "object" &&
    event.arguments !== null &&
    Object.values(event.arguments).every((entry) => ["string", "number", "boolean"].includes(typeof entry));
  return (
    event.schema_family === "zcr.shadow-consumer-event" &&
    event.schema_major === 1 &&
    SHADOW_CONSUMERS.includes(event.consumer as ShadowConsumer) &&
    typeof event.event_id === "string" && event.event_id.length > 0 && event.event_id.length <= 256 &&
    typeof event.operation === "string" && event.operation.length > 0 &&
    (event.effect === "read" || event.effect === "write") &&
    (event.effect_class === undefined || SHADOW_EFFECT_CLASSES.includes(event.effect_class)) &&
    typeof event.resource === "object" && event.resource !== null &&
    typeof event.resource.kind === "string" && event.resource.kind.length > 0 &&
    typeof event.resource.resource_id === "string" && event.resource.resource_id.length > 0 &&
    scalarArgs &&
    typeof event.occurred_at === "string" && Number.isFinite(Date.parse(event.occurred_at)) &&
    typeof event.run_id === "string" && event.run_id.length > 0 &&
    typeof event.subject_id === "string" && event.subject_id.length > 0
  );
}
