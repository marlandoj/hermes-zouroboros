import type {
  DeclassificationRecordV1,
  DeclassificationStore,
  ObservationPayloadVault,
  ObservationRecordV1,
  ObservationStore,
  ShareDecisionRecordV1,
  ShareDecisionState,
  ShareDecisionStore,
} from "./contracts.js";

const DECISION_TRANSITIONS: Readonly<Record<ShareDecisionState, readonly ShareDecisionState[]>> = {
  pending: ["authorized", "denied", "expired"],
  authorized: [],
  denied: [],
  expired: [],
};

/** Observation records are immutable after capture; creation is append-only. */
export class InMemoryObservationStore implements ObservationStore {
  readonly #records = new Map<string, ObservationRecordV1>();

  async get(observationId: string): Promise<ObservationRecordV1 | null> {
    const record = this.#records.get(observationId);
    return record === undefined ? null : structuredClone(record);
  }

  async create(record: ObservationRecordV1): Promise<boolean> {
    if (this.#records.has(record.record_id)) return false;
    this.#records.set(record.record_id, structuredClone(record));
    return true;
  }
}

export class InMemoryShareDecisionStore implements ShareDecisionStore {
  readonly #records = new Map<string, ShareDecisionRecordV1>();

  async get(decisionId: string): Promise<ShareDecisionRecordV1 | null> {
    const record = this.#records.get(decisionId);
    return record === undefined ? null : structuredClone(record);
  }

  async createPending(record: ShareDecisionRecordV1): Promise<boolean> {
    if (record.state !== "pending" || this.#records.has(record.record_id)) return false;
    this.#records.set(record.record_id, structuredClone(record));
    return true;
  }

  async transition(
    decisionId: string,
    from: ShareDecisionState,
    to: ShareDecisionState,
    finalized: ShareDecisionRecordV1,
  ): Promise<boolean> {
    const current = this.#records.get(decisionId);
    if (
      current === undefined ||
      current.state !== from ||
      !DECISION_TRANSITIONS[from].includes(to) ||
      finalized.record_id !== decisionId ||
      finalized.state !== to
    ) {
      return false;
    }
    this.#records.set(decisionId, structuredClone(finalized));
    return true;
  }

  async listByRecipient(recipientDigest: string): Promise<readonly ShareDecisionRecordV1[]> {
    return [...this.#records.values()]
      .filter((record) => record.recipient_digest === recipientDigest)
      .map((record) => structuredClone(record));
  }

  async listAll(): Promise<readonly ShareDecisionRecordV1[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export class InMemoryDeclassificationStore implements DeclassificationStore {
  readonly #records = new Map<string, DeclassificationRecordV1>();

  async create(record: DeclassificationRecordV1): Promise<boolean> {
    if (this.#records.has(record.record_id)) return false;
    this.#records.set(record.record_id, structuredClone(record));
    return true;
  }

  async findActive(
    constraint: string,
    observationIds: readonly string[],
    at: Date,
  ): Promise<DeclassificationRecordV1 | null> {
    for (const record of this.#records.values()) {
      if (record.constraint !== constraint) continue;
      if (record.expires_at !== undefined && at.getTime() >= Date.parse(record.expires_at)) continue;
      const covered = new Set(record.observation_ids);
      if (observationIds.every((id) => covered.has(id))) return structuredClone(record);
    }
    return null;
  }

  async listAll(): Promise<readonly DeclassificationRecordV1[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export class InMemoryObservationPayloadVault implements ObservationPayloadVault {
  readonly #payloads = new Map<string, string>();

  put(ref: string, content: string): void {
    this.#payloads.set(ref, content);
  }

  get(ref: string): string | null {
    return this.#payloads.get(ref) ?? null;
  }
}
