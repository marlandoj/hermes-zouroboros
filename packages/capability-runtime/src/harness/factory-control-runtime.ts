import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Zou1059AuthorityVerifier, type AuthorityEnvelopeDocumentSource, type Zou1059OwnerContract } from "../adapters/zou-1059-authority.js";
import { CapabilityBroker } from "../broker/capability-broker.js";
import { InMemoryCapabilityStore } from "../broker/store.js";
import type { TrustedActionKeys } from "../action/exact-action.js";
import { FileSealedActionPayloadStore } from "../action/payload-store.js";
import type { CanonicalReceiptRef, CapabilityCatalogEntry } from "../contracts/capability.js";
import type { SignedActionApproval } from "../contracts/types.js";
import { canonicalPayloadDigest } from "../fingerprint.js";
import { GovernedActionRuntime, type ActionSnapshot } from "../journal/action-journal.js";
import {
  readFactoryControlScope,
  resolveFactoryControlConfig,
  verifyFactoryControlActivation,
} from "./factory-control-config.js";
import type {
  FactoryControlConfigV1,
  FactoryControlDecision,
  FactoryControlInput,
  FactoryControlOutcome,
  FactoryControlPreparation,
  FactoryControlVerdictRecordV1,
} from "./factory-control-contracts.js";

const CONTROL_SCHEMA_VERSION = 1;
const CONTROL_SCHEMA_DIGEST = sha256("zcr.factory-control-state/sqlite/v1");
const OPERATION = "factory.dispatch-ticket";

interface ProposalLike {
  readonly content_digest: string;
}

interface ControlStoreStatus {
  readonly total_verdicts: number;
  readonly applied_effects: number;
  readonly claimed_or_unknown_effects: number;
  readonly latest_verdict: FactoryControlVerdictRecordV1 | null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createPrivateFileOnce(path: string, payload: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    linkSync(tempPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  chmodSync(path, 0o600);
}

function ensureSealKey(stateDir: string): Uint8Array {
  const path = join(stateDir, "seal.key");
  if (!existsSync(path)) createPrivateFileOnce(path, randomBytes(32).toString("base64"));
  chmodSync(path, 0o600);
  const key = Uint8Array.from(Buffer.from(readFileSync(path, "utf8").trim(), "base64"));
  if (key.byteLength !== 32) throw new Error("Factory control seal key must decode to 32 bytes");
  return key;
}

function parseTrustedKeys(payload: string): TrustedActionKeys {
  const parsed = JSON.parse(payload) as unknown;
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) throw new Error("Factory control trusted key set is invalid");
  return parsed as TrustedActionKeys;
}

function parseCatalog(payload: string): readonly CapabilityCatalogEntry[] {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Factory control capability catalog is invalid");
  const entries = parsed as CapabilityCatalogEntry[];
  const entry = entries.find((candidate) => candidate.operation === OPERATION);
  if (
    entry === undefined || entry.resource_kind !== "factory-ticket" || entry.effect !== "write" ||
    !entry.required_arguments.includes("dispatch_result_digest")
  ) {
    throw new Error("Factory control capability catalog lacks the exact Factory dispatch write");
  }
  return entries;
}

class FactoryControlEvidenceStore {
  private readonly db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "control.sqlite");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private immediate<R>(operation: () => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize(): void {
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS control_meta (schema_version INTEGER NOT NULL, schema_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_receipts (
        content_digest TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_verdicts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        verdict_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        prev_hash TEXT,
        event_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_budget (
        action_id TEXT PRIMARY KEY,
        ticket_identifier TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','applied','unknown','not_applied')),
        evidence_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS control_receipts_no_update BEFORE UPDATE ON control_receipts BEGIN SELECT RAISE(ABORT, 'control receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS control_receipts_no_delete BEFORE DELETE ON control_receipts BEGIN SELECT RAISE(ABORT, 'control receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS control_verdicts_no_update BEFORE UPDATE ON control_verdicts BEGIN SELECT RAISE(ABORT, 'control verdicts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS control_verdicts_no_delete BEFORE DELETE ON control_verdicts BEGIN SELECT RAISE(ABORT, 'control verdicts are immutable'); END;
    `);
    this.immediate(() => {
      const row = this.db.query("SELECT schema_version, schema_digest FROM control_meta LIMIT 1").get() as { schema_version: number; schema_digest: string } | null;
      if (row === null) {
        this.db.query("INSERT INTO control_meta(schema_version, schema_digest) VALUES (?, ?)").run(CONTROL_SCHEMA_VERSION, CONTROL_SCHEMA_DIGEST);
        this.db.exec(`PRAGMA user_version=${CONTROL_SCHEMA_VERSION}`);
      } else if (row.schema_version !== CONTROL_SCHEMA_VERSION || row.schema_digest !== CONTROL_SCHEMA_DIGEST) {
        throw new Error("Factory control state schema mismatch");
      }
      const userVersion = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (userVersion !== CONTROL_SCHEMA_VERSION) throw new Error("Factory control state user_version mismatch");
    });
    this.assertIntegrity();
  }

  appendReceipts(batch: readonly ProposalLike[]): readonly CanonicalReceiptRef[] {
    return this.immediate(() => batch.map((event) => {
      const receipt: CanonicalReceiptRef = {
        owner: "evidence-substrate/ZOU-1051",
        receipt_id: `zcr-control-${event.content_digest.slice(0, 24)}`,
        schema_major: 1,
        content_digest: event.content_digest,
      };
      const eventJson = JSON.stringify(event);
      const existing = this.db.query("SELECT receipt_id, event_json FROM control_receipts WHERE content_digest = ?").get(event.content_digest) as { receipt_id: string; event_json: string } | null;
      if (existing !== null) {
        if (existing.receipt_id !== receipt.receipt_id || existing.event_json !== eventJson) throw new Error("Factory control receipt conflict");
        return receipt;
      }
      this.db.query("INSERT INTO control_receipts(content_digest, receipt_id, event_json) VALUES (?, ?, ?)")
        .run(event.content_digest, receipt.receipt_id, eventJson);
      return receipt;
    }));
  }

  reserveEffect(actionId: string, ticketIdentifier: string, maxEffects: number, at: string): boolean {
    return this.immediate(() => {
      const existing = this.db.query("SELECT state FROM effect_budget WHERE action_id = ?").get(actionId) as { state: string } | null;
      if (existing !== null) return existing.state !== "not_applied";
      const active = (this.db.query("SELECT COUNT(*) AS count FROM effect_budget WHERE state IN ('claimed','applied','unknown')").get() as { count: number }).count;
      if (active >= maxEffects) return false;
      this.db.query("INSERT INTO effect_budget(action_id, ticket_identifier, state, evidence_digest, updated_at) VALUES (?, ?, 'claimed', ?, ?)")
        .run(actionId, ticketIdentifier, sha256(`zcr.factory-control-claim/v1\n${actionId}\n${ticketIdentifier}`), at);
      return true;
    });
  }

  markEffect(actionId: string, state: "applied" | "unknown" | "not_applied", evidenceDigest: string, at: string): void {
    this.immediate(() => {
      const row = this.db.query("SELECT state FROM effect_budget WHERE action_id = ?").get(actionId) as { state: string } | null;
      if (row === null) throw new Error("Factory control effect reservation is missing");
      if (row.state === "applied" && state !== "applied") throw new Error("Factory control applied effect is terminal");
      this.db.query("UPDATE effect_budget SET state = ?, evidence_digest = ?, updated_at = ? WHERE action_id = ?")
        .run(state, evidenceDigest, at, actionId);
    });
  }

  appendVerdict(base: Omit<FactoryControlVerdictRecordV1, "verdict_id" | "evidence_digest" | "content_digest">): FactoryControlVerdictRecordV1 {
    return this.immediate(() => {
      const previous = this.db.query("SELECT event_hash FROM control_verdicts ORDER BY sequence DESC LIMIT 1").get() as { event_hash: string } | null;
      const verdictId = `fcv-${randomUUID()}`;
      const evidenceDigest = sha256(`zcr.factory-control-evidence/v1\n${previous?.event_hash ?? ""}\n${canonicalPayloadDigest(base)}`);
      const unsigned = { ...base, verdict_id: verdictId, evidence_digest: evidenceDigest };
      const record: FactoryControlVerdictRecordV1 = { ...unsigned, content_digest: canonicalPayloadDigest(unsigned) };
      const recordJson = JSON.stringify(record);
      const eventHash = sha256(`zcr.factory-control-verdict/v1\n${previous?.event_hash ?? ""}\n${recordJson}`);
      this.db.query("INSERT INTO control_verdicts(verdict_id, record_json, prev_hash, event_hash) VALUES (?, ?, ?, ?)")
        .run(verdictId, recordJson, previous?.event_hash ?? null, eventHash);
      return record;
    });
  }

  status(): ControlStoreStatus {
    this.assertIntegrity();
    const counts = this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM control_verdicts) AS total_verdicts,
        (SELECT COUNT(*) FROM effect_budget WHERE state = 'applied') AS applied_effects,
        (SELECT COUNT(*) FROM effect_budget WHERE state IN ('claimed','unknown')) AS claimed_or_unknown_effects
    `).get() as Omit<ControlStoreStatus, "latest_verdict">;
    const latest = this.db.query("SELECT record_json FROM control_verdicts ORDER BY sequence DESC LIMIT 1").get() as { record_json: string } | null;
    return { ...counts, latest_verdict: latest === null ? null : JSON.parse(latest.record_json) as FactoryControlVerdictRecordV1 };
  }

  assertIntegrity(): void {
    const quickCheck = (this.db.query("PRAGMA quick_check").get() as { quick_check: string })["quick_check"];
    if (quickCheck !== "ok") throw new Error(`Factory control state integrity failure: ${quickCheck}`);
    const rows = this.db.query("SELECT record_json, prev_hash, event_hash FROM control_verdicts ORDER BY sequence").all() as Array<{ record_json: string; prev_hash: string | null; event_hash: string }>;
    let previous: string | null = null;
    for (const row of rows) {
      if (row.prev_hash !== previous) throw new Error("Factory control verdict hash-chain gap");
      if (sha256(`zcr.factory-control-verdict/v1\n${previous ?? ""}\n${row.record_json}`) !== row.event_hash) throw new Error("Factory control verdict hash mismatch");
      const record = JSON.parse(row.record_json) as FactoryControlVerdictRecordV1;
      const { content_digest, ...unsigned } = record;
      if (canonicalPayloadDigest(unsigned) !== content_digest) throw new Error("Factory control verdict content digest mismatch");
      previous = row.event_hash;
    }
  }
}

export class FactoryControlRuntime<T> {
  private readonly config: FactoryControlConfigV1;
  private readonly now: () => Date;
  private readonly sourceCommit: string | undefined;
  private readonly evidence: FactoryControlEvidenceStore;
  private readonly authority: Zou1059AuthorityVerifier;
  private readonly broker: CapabilityBroker;
  private readonly journal: GovernedActionRuntime<T>;
  private readonly catalogEntry: CapabilityCatalogEntry;
  private readonly envelopeRunId: string;
  private readonly envelopeSubjectId: string;
  private readonly environment: Readonly<Record<"runtime_root" | "isolation_mode" | "repository" | "state_dir", string>>;
  private readonly continuation: () => Promise<T>;
  private readonly handles = new Map<string, string>();

  constructor(input: {
    readonly config: FactoryControlConfigV1;
    readonly continuation: () => Promise<T> | T;
    readonly source_commit?: string;
    readonly now?: () => Date;
    readonly owner?: Zou1059OwnerContract;
  }) {
    this.config = input.config;
    this.now = input.now ?? (() => new Date());
    this.sourceCommit = input.source_commit;
    this.continuation = async () => input.continuation();
    this.evidence = new FactoryControlEvidenceStore(this.config.state_dir);
    const owner = input.owner ?? loadOwnerContract();
    const envelopePayload = readFileSync(this.config.authority_envelope_path, "utf8");
    const evidencePayload = readFileSync(this.config.authority_evidence_path, "utf8");
    const envelope = JSON.parse(envelopePayload) as { envelope_id?: unknown };
    if (typeof envelope.envelope_id !== "string") throw new Error("Factory control authority envelope id is invalid");
    const documents: AuthorityEnvelopeDocumentSource = {
      load: async (envelopeId) => envelopeId === envelope.envelope_id
        ? { canonical_payload: envelopePayload, enforcement_evidence_payload: evidencePayload }
        : null,
    };
    this.authority = new Zou1059AuthorityVerifier(documents, owner);
    const catalog = parseCatalog(readFileSync(this.config.capability_catalog_path, "utf8"));
    this.catalogEntry = catalog.find((entry) => entry.operation === OPERATION)!;
    const catalogIndex = new Map(catalog.map((entry) => [entry.operation, entry]));
    const trustedKeys = parseTrustedKeys(readFileSync(this.config.trusted_keys_path, "utf8"));
    const sealKey = ensureSealKey(this.config.state_dir);
    const parsedEnvelope = JSON.parse(envelopePayload) as {
      approval_binding?: { run_id?: unknown };
      principal?: { id?: unknown };
      environment?: unknown;
    };
    if (
      typeof parsedEnvelope.approval_binding?.run_id !== "string" ||
      typeof parsedEnvelope.principal?.id !== "string" ||
      !isRecord(parsedEnvelope.environment)
    ) throw new Error("Factory control authority bindings are invalid");
    this.envelopeRunId = parsedEnvelope.approval_binding.run_id;
    this.envelopeSubjectId = parsedEnvelope.principal.id;
    this.environment = parsedEnvelope.environment as typeof this.environment;
    let brokerCounter = 0;
    const idSeed = `${this.config.content_digest}/${this.envelopeRunId}/${this.envelopeSubjectId}`;
    this.broker = new CapabilityBroker({
      authority: this.authority,
      runState: { read: async () => ({ terminalized: false, terminal_outcome: null }) },
      catalog: { resolve: (operation) => catalogIndex.get(operation) ?? null },
      provider: { invoke: async () => { throw new Error("Factory control broker writes require the action journal"); } },
      receipts: { appendBatch: async (batch) => this.evidence.appendReceipts(batch) },
      store: new InMemoryCapabilityStore(),
      context: {
        now: () => this.now(),
        environment: () => this.environment,
        nextId: (prefix) => `${prefix}-factory-${sha256(`${idSeed}/${prefix}/${++brokerCounter}`).slice(0, 26)}`,
      },
    });
    this.journal = new GovernedActionRuntime<T>({
      path: join(this.config.state_dir, "journal.sqlite"),
      payloads: new FileSealedActionPayloadStore({ directory: join(this.config.state_dir, "payloads"), key: sealKey }),
      receipts: { appendBatch: async (batch) => this.evidence.appendReceipts(batch) },
      authority: { verify: async ({ action, payload }) => this.verifyForDispatch(action.capability_handle_id, payload.arguments) },
      actors: {
        authorize: async ({ actor_id, session_id }) => this.config.allowed_actors.some(
          (actor) => actor.actor_id === actor_id && actor.session_ids.includes(session_id),
        ),
      },
      provider: {
        invoke: async ({ action }) => {
          const at = this.now().toISOString();
          const reserved = this.evidence.reserveEffect(action.record_id, action.resource.resource_id, this.config.max_applied_effects, at);
          if (!reserved) {
            const digest = sha256(`zcr.factory-control-budget-denied/v1\n${action.record_id}`);
            return { status: "not_applied", provider_evidence_digest: digest };
          }
          try {
            const value = await this.continuation();
            const digest = canonicalPayloadDigest({ action_id: action.record_id, config_digest: this.config.content_digest, outcome: "applied" });
            this.evidence.markEffect(action.record_id, "applied", digest, this.now().toISOString());
            return { status: "applied", value, provider_evidence_digest: digest };
          } catch (error) {
            const digest = canonicalPayloadDigest({ action_id: action.record_id, config_digest: this.config.content_digest, outcome: "unknown" });
            this.evidence.markEffect(action.record_id, "unknown", digest, this.now().toISOString());
            throw error;
          }
        },
      },
      trusted_keys: trustedKeys,
      now: () => this.now(),
    });
  }

  close(): void {
    this.journal.close();
    this.evidence.close();
  }

  private activationReasons(): readonly string[] {
    return verifyFactoryControlActivation(this.config, { now: this.now(), source_commit: this.sourceCommit });
  }

  private async introduce(ticketIdentifier: string, dispatchResultDigest: string): Promise<string> {
    const reasons = this.activationReasons();
    if (reasons.length > 0) throw new Error(`Factory control activation invalid: ${reasons.join(",")}`);
    const cacheKey = `${ticketIdentifier}/${dispatchResultDigest}`;
    const cached = this.handles.get(cacheKey);
    if (cached !== undefined) return cached;
    const introduction = await this.broker.introduce({
      envelope: {
        owner: "evidence-substrate/ZOU-1059",
        envelope_id: (JSON.parse(readFileSync(this.config.authority_envelope_path, "utf8")) as { envelope_id: string }).envelope_id,
        schema_major: 1,
        content_digest: this.config.authority_envelope_digest,
      },
      run_id: this.envelopeRunId,
      subject_id: this.envelopeSubjectId,
      resource: { kind: "factory-ticket", resource_id: `factory-tickets/${ticketIdentifier}` },
      operations: [OPERATION],
      expires_at: new Date(Math.min(Date.parse(this.config.expires_at), this.now().getTime() + 10 * 60 * 1000)).toISOString(),
    });
    if (!introduction.ok) throw new Error(`Factory control capability denied: ${introduction.reason_codes.join(",")}`);
    const handleId = introduction.value.handle.record_id;
    if (!dispatchResultDigest) throw new Error("Factory control dispatch result digest is missing");
    this.handles.set(cacheKey, handleId);
    return handleId;
  }

  private async stage(input: FactoryControlInput<unknown>): Promise<ActionSnapshot> {
    const dispatchResultDigest = canonicalPayloadDigest(input.dispatch_result);
    const handleId = await this.introduce(input.ticket_identifier, dispatchResultDigest);
    const stageInput = {
      run_id: this.envelopeRunId,
      capability_handle_id: handleId,
      payload: {
        tool_id: OPERATION,
        resource: { kind: "factory-ticket", resource_id: `factory-tickets/${input.ticket_identifier}` },
        arguments: {
          ticket_identifier: input.ticket_identifier,
          dispatch_result_digest: dispatchResultDigest,
          config_digest: this.config.content_digest,
          source_commit: this.config.source_commit,
          runtime_digest: this.config.runtime_digest,
        },
      },
      effect_class: "reconcilable_write" as const,
      idempotency_scope: `zcr.factory-control/v1/${this.config.content_digest}`,
      idempotency_key: `${input.ticket_identifier}/${dispatchResultDigest}`,
      stable_business_key: `${this.config.content_digest}/${input.ticket_identifier}`,
      provider_idempotency_key: `${this.config.content_digest}/${input.ticket_identifier}/${dispatchResultDigest}`,
    };
    try {
      return await this.journal.stage(stageInput);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("action idempotency already reserved")) throw error;
      return this.journal.stage(stageInput);
    }
  }

  async prepare(input: FactoryControlInput<unknown>): Promise<FactoryControlPreparation> {
    let snapshot = await this.stage(input);
    if (snapshot.action.state === "staged") {
      const render = await this.journal.renderForApproval(snapshot.action.record_id);
      snapshot = this.journal.get(snapshot.action.record_id)!;
      return {
        action_id: snapshot.action.record_id,
        run_id: snapshot.action.run_id,
        capability_handle_id: snapshot.action.capability_handle_id,
        action_state: snapshot.action.state,
        dispatch_boundary: snapshot.action.dispatch_boundary,
        render,
      };
    }
    if (snapshot.action.state !== "awaiting_approval") throw new Error(`Factory control action is not awaiting approval: ${snapshot.action.state}`);
    return {
      action_id: snapshot.action.record_id,
      run_id: snapshot.action.run_id,
      capability_handle_id: snapshot.action.capability_handle_id,
      action_state: snapshot.action.state,
      dispatch_boundary: snapshot.action.dispatch_boundary,
      render: await this.journal.renderForApproval(snapshot.action.record_id),
    };
  }

  async importDecision(signed: SignedActionApproval): Promise<ActionSnapshot> {
    const reasons = this.activationReasons();
    if (reasons.length > 0) throw new Error(`Factory control activation invalid: ${reasons.join(",")}`);
    return this.journal.recordDecision(signed);
  }

  private async verifyForDispatch(handleId: string, argumentsValue: Readonly<Record<string, unknown>>): Promise<{ readonly permitted: boolean; readonly reasons: readonly string[] }> {
    const reasons = [...this.activationReasons()];
    if (
      argumentsValue.config_digest !== this.config.content_digest ||
      argumentsValue.source_commit !== this.config.source_commit ||
      argumentsValue.runtime_digest !== this.config.runtime_digest ||
      typeof argumentsValue.ticket_identifier !== "string" ||
      !this.config.allowlisted_ticket_identifiers.includes(argumentsValue.ticket_identifier)
    ) reasons.push("action_binding_mismatch");
    const snapshot = await this.authority.resolveAndVerify({
      owner: "evidence-substrate/ZOU-1059",
      envelope_id: (JSON.parse(readFileSync(this.config.authority_envelope_path, "utf8")) as { envelope_id: string }).envelope_id,
      schema_major: 1,
      content_digest: this.config.authority_envelope_digest,
    });
    if (snapshot === null) reasons.push("unverifiable_authority");
    if (snapshot !== null) {
      const decision = await this.authority.authorizeIntroduction(snapshot, {
        operations: [OPERATION],
        resource: `factory-tickets/${argumentsValue.ticket_identifier ?? "invalid"}`,
        credential_class: this.catalogEntry.credential_class,
        at: this.now(),
        environment: this.environment,
        receipt_terminalized: false,
        terminal_outcome: null,
      });
      if (decision.decision !== "PERMIT") reasons.push(...decision.reasons);
    }
    if (!handleId.startsWith("ch-factory-")) reasons.push("capability_handle_invalid");
    return { permitted: reasons.length === 0, reasons };
  }

  async evaluate(input: FactoryControlInput<unknown>): Promise<FactoryControlOutcome<T>> {
    const dispatchResultDigest = canonicalPayloadDigest(input.dispatch_result);
    const activationReasons = this.activationReasons();
    if (activationReasons.length > 0) {
      return this.finish(input.ticket_identifier, dispatchResultDigest, "deny", activationReasons, null, "not_performed");
    }
    let snapshot = await this.stage(input);
    if (snapshot.action.state === "staged") {
      await this.journal.renderForApproval(snapshot.action.record_id);
      snapshot = this.journal.get(snapshot.action.record_id)!;
    }
    if (snapshot.action.state === "applying") {
      await this.journal.recover(snapshot.action.record_id);
      snapshot = this.journal.get(snapshot.action.record_id)!;
    }
    let decision: FactoryControlDecision = "hold";
    let reasons: readonly string[] = ["exact_action_approval_required"];
    let hostEffect: FactoryControlOutcome<T>["host_effect"] = "not_performed";
    let value: T | undefined;
    if (snapshot.action.state === "rejected") {
      decision = "deny";
      reasons = ["exact_action_rejected"];
    } else if (snapshot.action.state === "approved") {
      decision = "permit";
      reasons = [];
      if (this.config.mode === "canary") {
        const dispatched = await this.journal.dispatch(snapshot.action.record_id);
        snapshot = dispatched.snapshot;
        if (dispatched.status === "applied") {
          hostEffect = "performed";
          value = dispatched.value;
        } else {
          decision = "hold";
          reasons = [dispatched.status === "failed_retryable" ? "effect_budget_unavailable" : "dispatch_outcome_unknown"];
        }
      }
    } else if (snapshot.action.state === "applied") {
      decision = "permit";
      reasons = ["already_applied"];
      hostEffect = "already_applied";
    } else if (snapshot.action.state === "outcome_unknown" || snapshot.action.state === "applying") {
      reasons = ["dispatch_outcome_unknown"];
    } else if (snapshot.action.state === "failed_retryable") {
      reasons = ["effect_not_applied"];
    }
    if (this.config.mode === "shadow") {
      value = await this.continuation();
      hostEffect = "performed";
    }
    return this.finish(
      input.ticket_identifier,
      dispatchResultDigest,
      decision,
      reasons,
      snapshot,
      hostEffect,
      value,
    );
  }

  private finish(
    ticketIdentifier: string,
    dispatchResultDigest: string,
    decision: FactoryControlDecision,
    reasons: readonly string[],
    snapshot: ActionSnapshot | null,
    hostEffect: FactoryControlOutcome<T>["host_effect"],
    value?: T,
  ): FactoryControlOutcome<T> {
    const enforced = this.config.mode === "canary";
    this.evidence.appendVerdict({
      schema_family: "zcr.factory-control-verdict",
      schema_major: 1,
      ticket_identifier: ticketIdentifier,
      mode: this.config.mode,
      decision,
      enforced,
      reason_codes: [...reasons],
      config_digest: this.config.content_digest,
      source_commit: this.config.source_commit,
      runtime_digest: this.config.runtime_digest,
      dispatch_result_digest: dispatchResultDigest,
      action_id: snapshot?.action.record_id ?? null,
      action_state: snapshot?.action.state ?? null,
      dispatch_boundary: snapshot?.action.dispatch_boundary ?? null,
      host_effect: hostEffect,
      observed_at: this.now().toISOString(),
    });
    return {
      mode: this.config.mode,
      decision,
      enforced,
      reason_codes: [...reasons],
      action_id: snapshot?.action.record_id ?? null,
      action_state: snapshot?.action.state ?? null,
      dispatch_boundary: snapshot?.action.dispatch_boundary ?? null,
      host_effect: hostEffect,
      ...(value === undefined ? {} : { value }),
    };
  }

  status(): ControlStoreStatus {
    return this.evidence.status();
  }
}

export async function runFactoryControlGate<T>(
  input: FactoryControlInput<T>,
  continuation: () => Promise<T> | T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FactoryControlOutcome<T>> {
  let continuationResult: Promise<T> | null = null;
  const continueOnce = (): Promise<T> => {
    continuationResult ??= Promise.resolve().then(continuation);
    return continuationResult;
  };
  const configPath = env.ZCR_FACTORY_CONTROL_CONFIG;
  if (configPath === undefined || configPath.length === 0) {
    return bypassFactoryControl(await continueOnce());
  }
  let config: FactoryControlConfigV1;
  try {
    config = resolveFactoryControlConfig(env)!;
  } catch {
    const scope = readFactoryControlScope(configPath);
    if (scope.mode === "canary" && scope.allowlisted_ticket_identifiers.includes(input.ticket_identifier)) {
      return unavailableFactoryControl("canary", true, "invalid_control_config");
    }
    return bypassFactoryControl(await continueOnce());
  }
  if (config.mode === "off" || !config.allowlisted_ticket_identifiers.includes(input.ticket_identifier)) {
    return bypassFactoryControl(await continueOnce(), config.mode);
  }
  let runtime: FactoryControlRuntime<T> | null = null;
  try {
    runtime = new FactoryControlRuntime({
      config,
      continuation: continueOnce,
      source_commit: env.ZCR_FACTORY_CONTROL_SOURCE_COMMIT,
    });
    return await runtime.evaluate(input);
  } catch {
    if (config.mode === "shadow") {
      return unavailableFactoryControl("shadow", false, "control_runtime_unavailable", await continueOnce());
    }
    return unavailableFactoryControl("canary", true, "control_runtime_unavailable");
  } finally {
    runtime?.close();
  }
}

function bypassFactoryControl<T>(value: T, mode: FactoryControlConfigV1["mode"] = "off"): FactoryControlOutcome<T> {
  return {
    mode,
    decision: "permit",
    enforced: false,
    reason_codes: [],
    action_id: null,
    action_state: null,
    dispatch_boundary: null,
    host_effect: "performed",
    value,
  };
}

function unavailableFactoryControl<T>(
  mode: FactoryControlConfigV1["mode"],
  enforced: boolean,
  reason: string,
  value?: T,
): FactoryControlOutcome<T> {
  return {
    mode,
    decision: "hold",
    enforced,
    reason_codes: [reason],
    action_id: null,
    action_state: null,
    dispatch_boundary: null,
    host_effect: value === undefined ? "not_performed" : "performed",
    ...(value === undefined ? {} : { value }),
  };
}

export function readFactoryControlStatus(stateDir: string): ControlStoreStatus {
  const store = new FactoryControlEvidenceStore(stateDir);
  try {
    return store.status();
  } finally {
    store.close();
  }
}

const ownerRequire = createRequire(import.meta.url);

function loadOwnerContract(): Zou1059OwnerContract {
  return ownerRequire(
    "../../../../Projects/zouroboros-software-factory/scripts/authority-envelope.ts",
  ) as Zou1059OwnerContract;
}
