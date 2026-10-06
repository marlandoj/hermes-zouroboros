import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CapabilityBroker } from "../broker/capability-broker.js";
import { InMemoryCapabilityStore } from "../broker/store.js";
import { Zou1059AuthorityVerifier, type AuthorityEnvelopeDocumentSource, type Zou1059OwnerContract } from "../adapters/zou-1059-authority.js";
import type { CanonicalReceiptRef, CapabilityEventProposalV1 } from "../contracts/capability.js";
import type { ActionEventProposalV1 } from "../journal/action-journal.js";
import { GovernedActionRuntime } from "../journal/action-journal.js";
import { FileSealedActionPayloadStore } from "../action/payload-store.js";
import { canonicalPayloadDigest } from "../fingerprint.js";
import type {
  ShadowConsumerEventV1,
  ShadowOutcome,
  ShadowRuntimeConfig,
  ShadowVerdictRecordV1,
} from "./shadow-contracts.js";
import { isShadowConsumerEvent } from "./shadow-contracts.js";
import { ensureShadowBootstrap, type ShadowBootstrap } from "./shadow-bootstrap.js";
import { ShadowEventReservationStore, ShadowVerdictStore } from "./shadow-store.js";

interface ProposalLike {
  readonly content_digest: string;
}

function receiptFor(event: ProposalLike, sequence: number): CanonicalReceiptRef {
  return {
    owner: "evidence-substrate/ZOU-1051",
    receipt_id: `zcr-shadow-${sequence}-${event.content_digest.slice(0, 12)}`,
    schema_major: 1,
    content_digest: event.content_digest,
  };
}

/**
 * Shadow-mode harness runtime for ZCR-008. Consumer events are evaluated
 * through the production CapabilityBroker (introduction + authority policy)
 * and write effects are staged in the production GovernedActionRuntime
 * journal. Nothing is ever approved or dispatched: the journal provider
 * fails closed, the approval authorizer denies every actor, and verdicts are
 * recorded without being applied to the host flow (enforcement off).
 */
export class ShadowHarnessRuntime {
  readonly bootstrap: ShadowBootstrap;
  readonly verdicts: ShadowVerdictStore;
  private readonly broker: CapabilityBroker;
  private readonly journal: GovernedActionRuntime;
  private readonly reservations: ShadowEventReservationStore;
  private readonly now: () => Date;
  private readonly receiptsPath: string;
  private sequence = 0;

  constructor(config: ShadowRuntimeConfig, owner?: Zou1059OwnerContract) {
    this.now = config.now ?? (() => new Date());
    const verifierOwner = owner ?? loadOwnerContract();
    this.bootstrap = ensureShadowBootstrap({ stateDir: config.stateDir, owner: verifierOwner, now: this.now });
    this.verdicts = new ShadowVerdictStore(this.bootstrap.stateDir);
    this.reservations = new ShadowEventReservationStore(join(this.bootstrap.stateDir, "shadow-events.sqlite"));
    this.receiptsPath = join(this.bootstrap.stateDir, "receipts.jsonl");

    const documents: AuthorityEnvelopeDocumentSource = {
      load: async (envelopeId) =>
        envelopeId === this.bootstrap.envelopeRef.envelope_id
          ? {
              canonical_payload: this.bootstrap.envelopePayload,
              enforcement_evidence_payload: this.bootstrap.evidencePayload,
            }
          : null,
    };
    const authority = new Zou1059AuthorityVerifier(documents, verifierOwner);
    const catalogIndex = new Map(this.bootstrap.catalog.map((entry) => [entry.operation, entry]));

    this.broker = new CapabilityBroker({
      authority,
      runState: { read: async () => ({ terminalized: false, terminal_outcome: null }) },
      catalog: { resolve: (operation) => catalogIndex.get(operation) ?? null },
      provider: {
        invoke: async () => ({ observed: true, enforcement: "off" }),
      },
      receipts: { appendBatch: async (batch) => this.appendReceipts(batch) },
      store: new InMemoryCapabilityStore(),
      context: {
        now: () => this.now(),
        environment: () => ({ ...this.bootstrap.environment }),
        nextId: (prefix) => `${prefix}-shadow-${randomUUID()}`,
      },
    });

    this.journal = new GovernedActionRuntime({
      path: join(this.bootstrap.stateDir, "journal.sqlite"),
      payloads: new FileSealedActionPayloadStore({
        directory: join(this.bootstrap.stateDir, "payloads"),
        key: this.bootstrap.sealKey,
      }),
      receipts: { appendBatch: async (batch) => this.appendReceipts(batch) },
      authority: {
        verify: async () => ({ permitted: false, reasons: ["shadow_enforcement_off"] }),
      },
      actors: { authorize: async () => false },
      provider: {
        invoke: async () => {
          throw new Error("shadow_dispatch_forbidden: ZCR-008 shadow mode never dispatches provider effects");
        },
      },
      trusted_keys: {},
      now: () => this.now(),
      next_id: (prefix) => `${prefix}-shadow-${randomUUID()}`,
    });
  }

  /**
   * Observes one consumer event. Never throws: every failure path degrades to
   * a durable adapter_error verdict so the host consumer flow is never
   * blocked by observation.
   */
  async observe(event: unknown): Promise<ShadowVerdictRecordV1> {
    const observedAt = this.now().toISOString();
    if (!isShadowConsumerEvent(event)) {
      return this.record({
        consumer: "factory",
        event_id: "invalid",
        operation: "invalid",
        resource: { kind: "invalid", resource_id: "invalid" },
        occurred_at: observedAt,
        observed_at: observedAt,
        outcome: "adapter_error",
        reason_codes: ["invalid_shadow_event"],
        handle_id: null,
        action_id: null,
      });
    }
    try {
      const reservation = this.reservations.reserve({
        consumer: event.consumer,
        eventId: event.event_id,
        payloadDigest: canonicalPayloadDigest({
          operation: event.operation,
          resource: event.resource,
          arguments: event.arguments,
        }),
        createdAt: observedAt,
      });
      if (reservation.outcome === "existing") {
        return this.record(baseVerdict(event, observedAt, "duplicate_event", ["already_observed"]));
      }
      if (reservation.outcome === "idempotency_conflict") {
        return this.record(baseVerdict(event, observedAt, "adapter_error", ["idempotency_conflict"]));
      }

      const introduction = await this.broker.introduce({
        envelope: this.bootstrap.envelopeRef,
        run_id: "zcr-008-shadow-window",
        subject_id: "zcr-008-shadow-observer",
        resource: event.resource,
        operations: [event.operation],
        expires_at: new Date(this.now().getTime() + 10 * 60 * 1000).toISOString(),
      });
      if (!introduction.ok) {
        return this.record(baseVerdict(event, observedAt, "denied", introduction.reason_codes));
      }
      const handleId = introduction.value.handle.record_id;

      if (event.effect === "read") {
        const invocation = await this.broker.invoke({
          handle_id: handleId,
          operation: event.operation,
          arguments: event.arguments,
        });
        return this.record({
          ...baseVerdict(
            event,
            observedAt,
            invocation.ok ? "read_permitted" : "denied",
            invocation.ok ? [] : invocation.reason_codes,
          ),
          handle_id: handleId,
        });
      }

      const snapshot = await this.journal.stage({
        run_id: event.run_id,
        capability_handle_id: handleId,
        payload: {
          tool_id: event.operation,
          resource: event.resource,
          arguments: event.arguments,
        },
        effect_class: event.effect_class ?? "reconcilable_write",
        idempotency_scope: `zcr-shadow/${event.consumer}`,
        idempotency_key: event.event_id,
      });
      await this.journal.renderForApproval(snapshot.action.record_id);
      return this.record({
        ...baseVerdict(event, observedAt, "staged_awaiting_approval", []),
        handle_id: handleId,
        action_id: snapshot.action.record_id,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      return this.record(baseVerdict(event, observedAt, "adapter_error", ["observation_failed", detail]));
    }
  }

  windowStatus(): ReturnType<ShadowVerdictStore["windowStatus"]> {
    return this.verdicts.windowStatus();
  }

  private appendReceipts(
    batch: readonly (CapabilityEventProposalV1 | ActionEventProposalV1)[],
  ): CanonicalReceiptRef[] {
    const receipts = batch.map((event) => receiptFor(event, ++this.sequence));
    const lines = batch
      .map((event, index) => `${JSON.stringify({ receipt: receipts[index], event })}\n`)
      .join("");
    appendFileSync(this.receiptsPath, lines, { encoding: "utf8", mode: 0o600 });
    return receipts;
  }

  private record(
    fields: Omit<ShadowVerdictRecordV1, "schema_family" | "schema_major" | "verdict_id" | "enforcement" | "envelope_id" | "catalog_digest" | "content_digest">,
  ): ShadowVerdictRecordV1 {
    const unsigned = {
      schema_family: "zcr.shadow-verdict" as const,
      schema_major: 1 as const,
      verdict_id: `sv-shadow-${randomUUID()}`,
      ...fields,
      enforcement: "off" as const,
      envelope_id: this.bootstrap.envelopeRef.envelope_id,
      catalog_digest: this.bootstrap.catalogDigest,
    };
    const record: ShadowVerdictRecordV1 = { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
    this.verdicts.append(record);
    return record;
  }
}

function baseVerdict(
  event: ShadowConsumerEventV1,
  observedAt: string,
  outcome: ShadowOutcome,
  reasons: readonly string[],
): Omit<ShadowVerdictRecordV1, "schema_family" | "schema_major" | "verdict_id" | "enforcement" | "envelope_id" | "catalog_digest" | "content_digest"> {
  return {
    consumer: event.consumer,
    event_id: event.event_id,
    operation: event.operation,
    resource: event.resource,
    occurred_at: event.occurred_at,
    observed_at: observedAt,
    outcome,
    reason_codes: [...reasons],
    handle_id: null,
    action_id: null,
  };
}

const ownerRequire = createRequire(import.meta.url);

function loadOwnerContract(): Zou1059OwnerContract {
  return ownerRequire(
    "../../../../Projects/zouroboros-software-factory/scripts/authority-envelope.ts",
  ) as Zou1059OwnerContract;
}
