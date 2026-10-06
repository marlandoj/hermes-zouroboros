import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  actionRecordDigest,
  canonicalizeExactAction,
  canonicalizeExactValue,
  exactActionDigest,
  parseCanonicalExactAction,
  renderTrustedAction,
  verifySignedActionApproval,
  type ExactActionPayload,
  type TrustedActionKeys,
  type TrustedActionRender,
} from "../action/exact-action.js";
import type { SealedActionPayloadStore } from "../action/payload-store.js";
import type { CanonicalReceiptRef } from "../contracts/capability.js";
import type {
  ActionApprovalV1,
  ActionRecordV1,
  ActionState,
  DispatchBoundary,
  EffectClass,
  PlanDecisionRef,
  SignedActionApproval,
} from "../contracts/types.js";
import { assertTransition } from "../policy/transitions.js";

const SCHEMA_VERSION = 1;
const SCHEMA_DIGEST = createHash("sha256").update("zcr.action-journal/sqlite/v1", "utf8").digest("hex");

export type ActionEventKind =
  | "staged"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "canceled"
  | "claimed"
  | "applied"
  | "failed_retryable"
  | "outcome_unknown";

export interface ActionEventProposalV1 {
  readonly schema_family: "zcr.action-event-proposal";
  readonly schema_major: 1;
  readonly event_id: string;
  readonly action_id: string;
  readonly run_id: string;
  readonly action_sequence: number;
  readonly kind: ActionEventKind;
  readonly from_state: ActionState | null;
  readonly to_state: ActionState;
  readonly action_content_digest: string;
  readonly payload_digest: string;
  readonly proof_digests: readonly string[];
  readonly occurred_at: string;
  readonly content_digest: string;
}

export interface ActionReceiptWriter {
  appendBatch(events: readonly ActionEventProposalV1[]): Promise<readonly CanonicalReceiptRef[]>;
}

export interface ActionAuthorityVerifier {
  verify(input: {
    readonly action: ActionRecordV1;
    readonly payload: ExactActionPayload;
    readonly approval: ActionApprovalV1;
    readonly at: Date;
  }): Promise<{ readonly permitted: boolean; readonly reasons: readonly string[] }>;
}

export interface ActionApprovalActorAuthorizer {
  authorize(input: {
    readonly actor_id: string;
    readonly session_id: string;
    readonly action: ActionRecordV1;
  }): Promise<boolean>;
}

export interface ActionProviderInvoker<T = unknown> {
  invoke(input: {
    readonly action: ActionRecordV1;
    readonly payload: ExactActionPayload;
  }): Promise<
    | { readonly status: "applied"; readonly value: T; readonly provider_evidence_digest: string }
    | { readonly status: "not_applied"; readonly provider_evidence_digest: string }
  >;
}

export interface StageActionInput {
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly payload: ExactActionPayload;
  readonly effect_class: EffectClass;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly plan_decision?: PlanDecisionRef;
  readonly stable_business_key?: string;
  readonly provider_idempotency_key?: string;
  readonly compensates_action_id?: string;
}

export interface ActionSnapshot {
  readonly action: ActionRecordV1;
  readonly receipts: readonly CanonicalReceiptRef[];
}

export type DispatchResult<T> =
  | { readonly status: "applied"; readonly value: T; readonly snapshot: ActionSnapshot }
  | { readonly status: "failed_retryable"; readonly snapshot: ActionSnapshot }
  | { readonly status: "outcome_unknown"; readonly snapshot: ActionSnapshot; readonly reason: string };

interface JournalRow {
  readonly snapshot_json: string;
  readonly event_json: string;
  readonly prev_event_hash: string | null;
  readonly event_hash: string;
  readonly action_sequence: number;
  readonly action_id: string;
}

interface ApprovalRow {
  readonly signed_json: string;
}

interface OutboxRow {
  readonly event_json: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeExactValue(value));
}

function assertStateBoundary(state: ActionState, boundary: DispatchBoundary): void {
  if (["staged", "awaiting_approval", "approved", "rejected", "canceled"].includes(state) && boundary !== "not_dispatched") {
    throw new Error(`invalid action state/boundary tuple: ${state}/${boundary}`);
  }
  if (["applying", "failed_retryable", "outcome_unknown"].includes(state) && boundary !== "claimed") {
    throw new Error(`invalid action state/boundary tuple: ${state}/${boundary}`);
  }
  if (["applied", "reconciled", "compensated"].includes(state) && boundary !== "provider_confirmed") {
    throw new Error(`invalid action state/boundary tuple: ${state}/${boundary}`);
  }
}

function isReceipt(value: CanonicalReceiptRef | undefined): value is CanonicalReceiptRef {
  return value?.owner === "evidence-substrate/ZOU-1051" && value.schema_major > 0 && value.receipt_id.length > 0 && /^[a-f0-9]{64}$/.test(value.content_digest);
}

export class GovernedActionRuntime<T = unknown> {
  private readonly db: Database;
  private readonly payloads: SealedActionPayloadStore;
  private readonly receipts: ActionReceiptWriter;
  private readonly authority: ActionAuthorityVerifier;
  private readonly actors: ActionApprovalActorAuthorizer;
  private readonly provider: ActionProviderInvoker<T>;
  private readonly trustedKeys: TrustedActionKeys;
  private readonly now: () => Date;
  private readonly nextId: (prefix: string) => string;

  constructor(input: {
    readonly path: string;
    readonly payloads: SealedActionPayloadStore;
    readonly receipts: ActionReceiptWriter;
    readonly authority: ActionAuthorityVerifier;
    readonly actors: ActionApprovalActorAuthorizer;
    readonly provider: ActionProviderInvoker<T>;
    readonly trusted_keys: TrustedActionKeys;
    readonly now?: () => Date;
    readonly next_id?: (prefix: string) => string;
  }) {
    if (!input.path.startsWith("/")) throw new Error("action journal path must be absolute");
    const path = resolve(input.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.payloads = input.payloads;
    this.receipts = input.receipts;
    this.authority = input.authority;
    this.actors = input.actors;
    this.provider = input.provider;
    this.trustedKeys = input.trusted_keys;
    this.now = input.now ?? (() => new Date());
    this.nextId = input.next_id ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta (schema_version INTEGER NOT NULL, schema_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        base_json TEXT NOT NULL,
        UNIQUE(idempotency_scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS action_approvals (
        record_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(action_id),
        content_digest TEXT NOT NULL,
        signed_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_events (
        commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        action_id TEXT NOT NULL REFERENCES actions(action_id),
        action_sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        event_json TEXT NOT NULL,
        prev_event_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE(action_id, action_sequence)
      );
      CREATE TABLE IF NOT EXISTS receipt_outbox (
        event_id TEXT PRIMARY KEY REFERENCES action_events(event_id),
        action_id TEXT NOT NULL REFERENCES actions(action_id),
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipt_acks (
        event_id TEXT PRIMARY KEY REFERENCES receipt_outbox(event_id),
        receipt_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS actions_no_update BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'actions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'actions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS approvals_no_update BEFORE UPDATE ON action_approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS approvals_no_delete BEFORE DELETE ON action_approvals BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON action_events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON action_events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outbox_no_update BEFORE UPDATE ON receipt_outbox BEGIN SELECT RAISE(ABORT, 'outbox is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outbox_no_delete BEFORE DELETE ON receipt_outbox BEGIN SELECT RAISE(ABORT, 'outbox is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS acks_no_update BEFORE UPDATE ON receipt_acks BEGIN SELECT RAISE(ABORT, 'receipt acknowledgements are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS acks_no_delete BEFORE DELETE ON receipt_acks BEGIN SELECT RAISE(ABORT, 'receipt acknowledgements are immutable'); END;
    `);
    this.immediate(() => {
      const metadata = this.db.query("SELECT schema_version, schema_digest FROM journal_meta LIMIT 1").get() as { schema_version: number; schema_digest: string } | null;
      if (metadata === null) {
        this.db.query("INSERT INTO journal_meta(schema_version, schema_digest) VALUES (?, ?)").run(SCHEMA_VERSION, SCHEMA_DIGEST);
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      } else if (metadata.schema_version !== SCHEMA_VERSION || metadata.schema_digest !== SCHEMA_DIGEST) {
        throw new Error("action journal schema mismatch");
      }
      const userVersion = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (userVersion !== SCHEMA_VERSION) throw new Error("action journal user_version mismatch");
    });
    const quickCheck = (this.db.query("PRAGMA quick_check").get() as { quick_check: string })["quick_check"];
    if (quickCheck !== "ok") throw new Error(`action journal quick_check failed: ${quickCheck}`);
    this.assertIntegrity();
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

  private latestRow(actionId: string): JournalRow | null {
    return this.db.query(`
      SELECT action_id, action_sequence, snapshot_json, event_json, prev_event_hash, event_hash
      FROM action_events WHERE action_id = ? ORDER BY action_sequence DESC LIMIT 1
    `).get(actionId) as JournalRow | null;
  }

  private latestAction(actionId: string): ActionRecordV1 | null {
    const row = this.latestRow(actionId);
    if (row === null) return null;
    const action = JSON.parse(row.snapshot_json) as ActionRecordV1;
    this.verifyAction(action);
    return action;
  }

  private verifyAction(action: ActionRecordV1): void {
    assertStateBoundary(action.state, action.dispatch_boundary);
    const actual = actionRecordDigest(action as unknown as Readonly<Record<string, unknown>>);
    if (actual !== action.content_digest) throw new Error(`action content digest mismatch: ${action.record_id}`);
  }

  assertIntegrity(): void {
    const quickCheck = (this.db.query("PRAGMA quick_check").get() as { quick_check: string })["quick_check"];
    if (quickCheck !== "ok") throw new Error(`action journal integrity failure: ${quickCheck}`);
    const rows = this.db.query(`
      SELECT action_id, action_sequence, snapshot_json, event_json, prev_event_hash, event_hash
      FROM action_events ORDER BY commit_sequence
    `).all() as JournalRow[];
    const previous = new Map<string, { sequence: number; hash: string }>();
    for (const row of rows) {
      const prior = previous.get(row.action_id);
      if (row.action_sequence !== (prior?.sequence ?? 0) + 1) throw new Error(`action sequence gap: ${row.action_id}`);
      if (row.prev_event_hash !== (prior?.hash ?? null)) throw new Error(`action hash chain gap: ${row.action_id}`);
      if (sha256(`zcr.action-event/v1\n${row.prev_event_hash ?? ""}\n${row.event_json}`) !== row.event_hash) {
        throw new Error(`action event hash mismatch: ${row.action_id}`);
      }
      this.verifyAction(JSON.parse(row.snapshot_json) as ActionRecordV1);
      previous.set(row.action_id, { sequence: row.action_sequence, hash: row.event_hash });
    }
  }

  private buildProposal(input: {
    readonly eventId: string;
    readonly action: ActionRecordV1;
    readonly kind: ActionEventKind;
    readonly fromState: ActionState | null;
    readonly proofDigests: readonly string[];
  }): ActionEventProposalV1 {
    const unsigned = {
      schema_family: "zcr.action-event-proposal" as const,
      schema_major: 1 as const,
      event_id: input.eventId,
      action_id: input.action.record_id,
      run_id: input.action.run_id,
      action_sequence: input.action.sequence,
      kind: input.kind,
      from_state: input.fromState,
      to_state: input.action.state,
      action_content_digest: input.action.content_digest,
      payload_digest: input.action.canonical_payload_digest,
      proof_digests: input.proofDigests,
      occurred_at: input.action.updated_at,
    };
    return { ...unsigned, content_digest: sha256(canonicalJson(unsigned)) };
  }

  private insertEvent(action: ActionRecordV1, kind: ActionEventKind, fromState: ActionState | null, proofDigests: readonly string[]): string {
    const previous = this.latestRow(action.record_id);
    const expectedSequence = (previous?.action_sequence ?? 0) + 1;
    if (action.sequence !== expectedSequence) throw new Error(`action CAS sequence conflict: ${action.record_id}`);
    const eventId = this.nextId("action-event");
    const proposal = this.buildProposal({ eventId, action, kind, fromState, proofDigests });
    const eventJson = canonicalJson({
      event_id: eventId,
      action_id: action.record_id,
      action_sequence: action.sequence,
      from_state: fromState,
      to_state: action.state,
      boundary: action.dispatch_boundary,
      attempt: action.attempt,
      proposal_digest: proposal.content_digest,
    });
    const previousHash = previous?.event_hash ?? null;
    const eventHash = sha256(`zcr.action-event/v1\n${previousHash ?? ""}\n${eventJson}`);
    this.db.query(`
      INSERT INTO action_events(event_id, action_id, action_sequence, snapshot_json, event_json, prev_event_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, action.record_id, action.sequence, canonicalJson(action), eventJson, previousHash, eventHash);
    this.db.query("INSERT INTO receipt_outbox(event_id, action_id, event_json) VALUES (?, ?, ?)")
      .run(eventId, action.record_id, canonicalJson(proposal));
    return eventId;
  }

  private transition(input: {
    readonly actionId: string;
    readonly expectedState: ActionState;
    readonly targetState: ActionState;
    readonly boundary: DispatchBoundary;
    readonly kind: ActionEventKind;
    readonly proofDigests?: readonly string[];
    readonly incrementAttempt?: boolean;
  }): string {
    return this.immediate(() => {
      const current = this.latestAction(input.actionId);
      if (current === null) throw new Error(`unknown action: ${input.actionId}`);
      if (current.state !== input.expectedState) throw new Error(`action CAS state conflict: expected ${input.expectedState}, got ${current.state}`);
      assertTransition(current.state, input.targetState);
      const unsigned = {
        ...current,
        state: input.targetState,
        dispatch_boundary: input.boundary,
        attempt: current.attempt + (input.incrementAttempt ? 1 : 0),
        updated_at: this.now().toISOString(),
        sequence: current.sequence + 1,
      };
      const { content_digest: _oldDigest, ...withoutDigest } = unsigned;
      const next: ActionRecordV1 = { ...withoutDigest, content_digest: actionRecordDigest(withoutDigest) };
      assertStateBoundary(next.state, next.dispatch_boundary);
      return this.insertEvent(next, input.kind, current.state, input.proofDigests ?? []);
    });
  }

  private async flushEvent(eventId: string): Promise<CanonicalReceiptRef> {
    const existing = this.db.query("SELECT receipt_json FROM receipt_acks WHERE event_id = ?").get(eventId) as { receipt_json: string } | null;
    if (existing !== null) return JSON.parse(existing.receipt_json) as CanonicalReceiptRef;
    const row = this.db.query("SELECT event_json FROM receipt_outbox WHERE event_id = ?").get(eventId) as OutboxRow | null;
    if (row === null) throw new Error(`missing receipt outbox event: ${eventId}`);
    const proposal = JSON.parse(row.event_json) as ActionEventProposalV1;
    const written = await this.receipts.appendBatch([proposal]);
    const receipt = written[0];
    if (written.length !== 1 || !isReceipt(receipt)) throw new Error("canonical action receipt unavailable");
    this.immediate(() => {
      const prior = this.db.query("SELECT receipt_json FROM receipt_acks WHERE event_id = ?").get(eventId) as { receipt_json: string } | null;
      if (prior !== null) {
        if (prior.receipt_json !== canonicalJson(receipt)) throw new Error(`canonical receipt conflict: ${eventId}`);
        return;
      }
      this.db.query("INSERT INTO receipt_acks(event_id, receipt_json) VALUES (?, ?)").run(eventId, canonicalJson(receipt));
    });
    return receipt;
  }

  private async flushPending(actionId: string): Promise<void> {
    const rows = this.db.query(`
      SELECT o.event_id FROM receipt_outbox o LEFT JOIN receipt_acks a ON a.event_id = o.event_id
      WHERE o.action_id = ? AND a.event_id IS NULL ORDER BY o.rowid
    `).all(actionId) as Array<{ event_id: string }>;
    for (const row of rows) await this.flushEvent(row.event_id);
  }

  private snapshot(actionId: string): ActionSnapshot {
    const action = this.latestAction(actionId);
    if (action === null) throw new Error(`unknown action: ${actionId}`);
    const rows = this.db.query(`
      SELECT a.receipt_json FROM receipt_acks a JOIN receipt_outbox o ON o.event_id = a.event_id
      WHERE o.action_id = ? ORDER BY o.rowid
    `).all(actionId) as Array<{ receipt_json: string }>;
    return { action, receipts: rows.map((row) => JSON.parse(row.receipt_json) as CanonicalReceiptRef) };
  }

  async stage(input: StageActionInput): Promise<ActionSnapshot> {
    this.assertIntegrity();
    if (!input.idempotency_scope || !input.idempotency_key) throw new Error("action idempotency scope and key are required");
    const canonicalPayload = canonicalizeExactAction(input.payload);
    const payloadDigest = exactActionDigest(input.payload);
    const prior = this.db.query("SELECT action_id, payload_digest FROM actions WHERE idempotency_scope = ? AND idempotency_key = ?")
      .get(input.idempotency_scope, input.idempotency_key) as { action_id: string; payload_digest: string } | null;
    if (prior !== null) {
      if (prior.payload_digest !== payloadDigest) throw new Error("action idempotency conflict");
      await this.flushPending(prior.action_id);
      return this.snapshot(prior.action_id);
    }
    const ciphertextRef = await this.payloads.put(canonicalPayload);
    const actionId = this.nextId("action");
    const timestamp = this.now().toISOString();
    const unsigned = {
      schema_family: "zcr.action" as const,
      schema_major: 1 as const,
      record_id: actionId,
      run_id: input.run_id,
      capability_handle_id: input.capability_handle_id,
      ...(input.plan_decision === undefined ? {} : { plan_decision: input.plan_decision }),
      tool_id: input.payload.tool_id,
      resource: input.payload.resource,
      effect_class: input.effect_class,
      canonical_payload_digest: payloadDigest,
      canonical_payload_ciphertext_ref: ciphertextRef,
      ...(input.provider_idempotency_key === undefined ? {} : { provider_idempotency_key: input.provider_idempotency_key }),
      ...(input.stable_business_key === undefined ? {} : { stable_business_key: input.stable_business_key }),
      ...(input.compensates_action_id === undefined ? {} : { compensates_action_id: input.compensates_action_id }),
      state: "staged" as const,
      attempt: 0,
      dispatch_boundary: "not_dispatched" as const,
      created_at: timestamp,
      updated_at: timestamp,
      sequence: 1,
    };
    const action: ActionRecordV1 = { ...unsigned, content_digest: actionRecordDigest(unsigned) };
    const eventId = this.immediate(() => {
      const concurrent = this.db.query("SELECT action_id, payload_digest FROM actions WHERE idempotency_scope = ? AND idempotency_key = ?")
        .get(input.idempotency_scope, input.idempotency_key) as { action_id: string; payload_digest: string } | null;
      if (concurrent !== null) {
        if (concurrent.payload_digest !== payloadDigest) throw new Error("action idempotency conflict");
        throw new Error(`action idempotency already reserved: ${concurrent.action_id}`);
      }
      this.db.query("INSERT INTO actions(action_id, idempotency_scope, idempotency_key, payload_digest, base_json) VALUES (?, ?, ?, ?, ?)")
        .run(actionId, input.idempotency_scope, input.idempotency_key, payloadDigest, canonicalJson(action));
      return this.insertEvent(action, "staged", null, []);
    });
    await this.flushEvent(eventId);
    return this.snapshot(actionId);
  }

  async renderForApproval(actionId: string): Promise<TrustedActionRender & { readonly action_id: string }> {
    this.assertIntegrity();
    let action = this.latestAction(actionId);
    if (action === null) throw new Error(`unknown action: ${actionId}`);
    if (action.state === "staged") {
      const eventId = this.transition({ actionId, expectedState: "staged", targetState: "awaiting_approval", boundary: "not_dispatched", kind: "awaiting_approval" });
      await this.flushEvent(eventId);
      action = this.latestAction(actionId)!;
    }
    if (action.state !== "awaiting_approval") throw new Error(`action is not awaiting approval: ${action.state}`);
    const canonical = await this.payloads.get(action.canonical_payload_ciphertext_ref);
    if (canonical === null) throw new Error("sealed action payload unavailable");
    const payload = parseCanonicalExactAction(canonical);
    if (exactActionDigest(payload) !== action.canonical_payload_digest || payload.tool_id !== action.tool_id || canonicalJson(payload.resource) !== canonicalJson(action.resource)) {
      throw new Error("sealed action payload binding mismatch");
    }
    return { action_id: actionId, ...renderTrustedAction(payload) };
  }

  async recordDecision(signed: SignedActionApproval): Promise<ActionSnapshot> {
    this.assertIntegrity();
    const action = this.latestAction(signed.approval.action_id);
    if (action === null) throw new Error(`unknown action: ${signed.approval.action_id}`);
    const render = await this.loadAndRender(action);
    const verification = verifySignedActionApproval(signed, {
      trusted_keys: this.trustedKeys,
      now: this.now(),
      require_approval: false,
      binding: {
        action_id: action.record_id,
        run_id: action.run_id,
        capability_handle_id: action.capability_handle_id,
        canonical_payload_digest: action.canonical_payload_digest,
        tool_id: action.tool_id,
        resource_digest: render.resource_digest,
        plan_decision: action.plan_decision,
      },
    });
    if (!verification.valid) throw new Error(verification.reason ?? "action approval invalid");
    if (!await this.actors.authorize({ actor_id: signed.approval.actor_id, session_id: signed.approval.session_id, action })) {
      throw new Error("approval actor unauthorized");
    }
    const signedJson = canonicalJson(signed);
    const prior = this.db.query("SELECT signed_json FROM action_approvals WHERE record_id = ?").get(signed.approval.record_id) as ApprovalRow | null;
    if (prior !== null) {
      if (prior.signed_json !== signedJson) throw new Error("action approval replay conflict");
      await this.flushPending(action.record_id);
      return this.snapshot(action.record_id);
    }
    const targetState: "approved" | "rejected" = signed.approval.decision === "approve" ? "approved" : "rejected";
    const kind: "approved" | "rejected" = targetState;
    let eventId = "";
    this.immediate(() => {
      const current = this.latestAction(action.record_id);
      if (current?.state !== "awaiting_approval") throw new Error(`action CAS state conflict: ${current?.state ?? "missing"}`);
      this.db.query("INSERT INTO action_approvals(record_id, action_id, content_digest, signed_json) VALUES (?, ?, ?, ?)")
        .run(signed.approval.record_id, action.record_id, signed.approval.content_digest, signedJson);
      const unsigned = { ...current, state: targetState, updated_at: this.now().toISOString(), sequence: current.sequence + 1 };
      const { content_digest: _old, ...withoutDigest } = unsigned;
      const next: ActionRecordV1 = { ...withoutDigest, content_digest: actionRecordDigest(withoutDigest) };
      eventId = this.insertEvent(next, kind, current.state, [signed.approval.content_digest]);
    });
    await this.flushEvent(eventId);
    return this.snapshot(action.record_id);
  }

  private async loadAndRender(action: ActionRecordV1): Promise<TrustedActionRender> {
    const canonical = await this.payloads.get(action.canonical_payload_ciphertext_ref);
    if (canonical === null) throw new Error("sealed action payload unavailable");
    const payload = parseCanonicalExactAction(canonical);
    const render = renderTrustedAction(payload);
    if (render.canonical_payload_digest !== action.canonical_payload_digest || payload.tool_id !== action.tool_id || canonicalJson(payload.resource) !== canonicalJson(action.resource)) {
      throw new Error("sealed action payload binding mismatch");
    }
    return render;
  }

  private latestApproval(actionId: string): SignedActionApproval {
    const row = this.db.query("SELECT signed_json FROM action_approvals WHERE action_id = ? ORDER BY rowid DESC LIMIT 1").get(actionId) as ApprovalRow | null;
    if (row === null) throw new Error("exact action approval missing");
    return JSON.parse(row.signed_json) as SignedActionApproval;
  }

  private async verifyForDispatch(action: ActionRecordV1): Promise<{ payload: ExactActionPayload; approval: SignedActionApproval }> {
    const render = await this.loadAndRender(action);
    const payload = parseCanonicalExactAction(render.canonical_payload);
    const approval = this.latestApproval(action.record_id);
    const verified = verifySignedActionApproval(approval, {
      trusted_keys: this.trustedKeys,
      now: this.now(),
      binding: {
        action_id: action.record_id,
        run_id: action.run_id,
        capability_handle_id: action.capability_handle_id,
        canonical_payload_digest: action.canonical_payload_digest,
        tool_id: action.tool_id,
        resource_digest: render.resource_digest,
        plan_decision: action.plan_decision,
      },
    });
    if (!verified.valid) throw new Error(verified.reason ?? "exact action approval invalid");
    if (!await this.actors.authorize({ actor_id: approval.approval.actor_id, session_id: approval.approval.session_id, action })) {
      throw new Error("approval actor unauthorized");
    }
    const authority = await this.authority.verify({ action, payload, approval: approval.approval, at: this.now() });
    if (!authority.permitted) throw new Error(`action authority denied: ${authority.reasons.join(",")}`);
    return { payload, approval };
  }

  async dispatch(actionId: string): Promise<DispatchResult<T>> {
    this.assertIntegrity();
    const approved = this.latestAction(actionId);
    if (approved === null) throw new Error(`unknown action: ${actionId}`);
    if (approved.state !== "approved") throw new Error(`action is not approved: ${approved.state}`);
    await this.flushPending(actionId);
    await this.verifyForDispatch(approved);
    const claimEvent = this.transition({
      actionId,
      expectedState: "approved",
      targetState: "applying",
      boundary: "claimed",
      kind: "claimed",
      incrementAttempt: true,
      proofDigests: [this.latestApproval(actionId).approval.content_digest],
    });
    await this.flushEvent(claimEvent);
    const applying = this.latestAction(actionId)!;
    let verified: { payload: ExactActionPayload; approval: SignedActionApproval };
    try {
      verified = await this.verifyForDispatch(applying);
    } catch (error) {
      const eventId = this.transition({ actionId, expectedState: "applying", targetState: "outcome_unknown", boundary: "claimed", kind: "outcome_unknown" });
      await this.flushEvent(eventId);
      return { status: "outcome_unknown", snapshot: this.snapshot(actionId), reason: error instanceof Error ? error.message : String(error) };
    }
    let result: Awaited<ReturnType<ActionProviderInvoker<T>["invoke"]>>;
    try {
      result = await this.provider.invoke({ action: applying, payload: verified.payload });
    } catch (error) {
      const eventId = this.transition({ actionId, expectedState: "applying", targetState: "outcome_unknown", boundary: "claimed", kind: "outcome_unknown" });
      await this.flushEvent(eventId);
      return { status: "outcome_unknown", snapshot: this.snapshot(actionId), reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === "not_applied") {
      const eventId = this.transition({ actionId, expectedState: "applying", targetState: "failed_retryable", boundary: "claimed", kind: "failed_retryable", proofDigests: [result.provider_evidence_digest] });
      await this.flushEvent(eventId);
      return { status: "failed_retryable", snapshot: this.snapshot(actionId) };
    }
    const eventId = this.transition({ actionId, expectedState: "applying", targetState: "applied", boundary: "provider_confirmed", kind: "applied", proofDigests: [result.provider_evidence_digest] });
    await this.flushEvent(eventId);
    return { status: "applied", value: result.value, snapshot: this.snapshot(actionId) };
  }

  async recover(actionId?: string): Promise<readonly ActionSnapshot[]> {
    this.assertIntegrity();
    const ids = actionId === undefined
      ? (this.db.query("SELECT action_id FROM actions ORDER BY rowid").all() as Array<{ action_id: string }>).map((row) => row.action_id)
      : [actionId];
    const recovered: ActionSnapshot[] = [];
    for (const id of ids) {
      await this.flushPending(id);
      const action = this.latestAction(id);
      if (action?.state !== "applying") continue;
      const eventId = this.transition({ actionId: id, expectedState: "applying", targetState: "outcome_unknown", boundary: "claimed", kind: "outcome_unknown" });
      await this.flushEvent(eventId);
      recovered.push(this.snapshot(id));
    }
    return recovered;
  }

  get(actionId: string): ActionSnapshot | null {
    this.assertIntegrity();
    return this.latestAction(actionId) === null ? null : this.snapshot(actionId);
  }
}
