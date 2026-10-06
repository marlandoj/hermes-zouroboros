import type {
  CanonicalReceiptRef,
  CapabilityHandleState,
  CapabilityStore,
  StoredCapabilityHandle,
} from "../contracts/capability.js";

const TRANSITIONS: Readonly<Record<CapabilityHandleState, readonly CapabilityHandleState[]>> = {
  introduced: ["active", "expired", "revoked", "closed"],
  active: ["expired", "revoked", "closed"],
  expired: [],
  revoked: [],
  closed: [],
};

export class InMemoryCapabilityStore implements CapabilityStore {
  readonly #records = new Map<string, StoredCapabilityHandle>();

  async get(handleId: string): Promise<StoredCapabilityHandle | null> {
    const record = this.#records.get(handleId);
    return record === undefined ? null : structuredClone(record);
  }

  async list(runId: string, subjectId: string): Promise<readonly StoredCapabilityHandle[]> {
    return [...this.#records.values()]
      .filter((record) => record.handle.run_id === runId && record.handle.subject_id === subjectId)
      .map((record) => structuredClone(record));
  }

  async createIntroduced(record: StoredCapabilityHandle): Promise<boolean> {
    if (record.state !== "introduced" || this.#records.has(record.handle.record_id)) return false;
    this.#records.set(record.handle.record_id, structuredClone(record));
    return true;
  }

  async transition(
    handleId: string,
    from: CapabilityHandleState,
    to: CapabilityHandleState,
    introductionReceipt?: CanonicalReceiptRef,
  ): Promise<boolean> {
    const current = this.#records.get(handleId);
    if (current === undefined || current.state !== from || !TRANSITIONS[from].includes(to)) return false;
    this.#records.set(handleId, {
      ...current,
      state: to,
      introduction_receipt: introductionReceipt ?? current.introduction_receipt,
    });
    return true;
  }
}
