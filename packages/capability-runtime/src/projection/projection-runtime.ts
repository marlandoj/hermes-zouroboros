import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  actionRecordDigest,
  assertNoProjectedRefs,
  canonicalizeExactAction,
  canonicalizeExactValue,
  exactActionDigest,
  type ExactActionPayload,
} from "../action/exact-action.js";
import type { SealedActionPayloadStore } from "../action/payload-store.js";
import type { CanonicalReceiptRef } from "../contracts/capability.js";
import type {
  ActionRecordV1,
  ActionResource,
  CommittedRef,
  EffectClass,
  PlanDecisionRef,
  ProjectedRef,
  ProjectionRecordV1,
  ProjectionState,
  RefBinding,
} from "../contracts/types.js";

const SCHEMA_VERSION = 1;
const SCHEMA_DIGEST = createHash("sha256").update("zcr.projection-overlay/sqlite/v1", "utf8").digest("hex");

const PROJECTION_PREDECESSORS: Readonly<Record<ProjectionState, ReadonlySet<ProjectionState>>> = {
  projected: new Set([]),
  resolved: new Set(["projected"]),
  withdrawn: new Set(["projected"]),
  invalidated: new Set(["projected"]),
};

export function assertProjectionTransition(from: ProjectionState, to: ProjectionState): void {
  if (!PROJECTION_PREDECESSORS[to].has(from)) {
    throw new Error(`illegal projection transition: ${from} -> ${to}`);
  }
}

export interface ProvisionalRefSpec {
  readonly reference_type: string;
  readonly local_key: string;
}

export interface ProjectionAdapterContext {
  readonly action: ActionRecordV1;
  readonly payload: ExactActionPayload;
}

export type ProjectionAdapterOutcome =
  | {
      readonly status: "projected";
      readonly projected_value: unknown;
      readonly provisional_refs: readonly ProvisionalRefSpec[];
    }
  | { readonly status: "awaitDecision"; readonly reason: string };

export interface ProjectionAdapter {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly input_schema_digest: string;
  readonly output_schema_digest: string;
  project(context: ProjectionAdapterContext): ProjectionAdapterOutcome;
}

export type ProjectionEventKind = "projected" | "resolved" | "withdrawn" | "invalidated";

export interface ProjectionEventProposalV1 {
  readonly schema_family: "zcr.projection-event-proposal";
  readonly schema_major: 1;
  readonly event_id: string;
  readonly projection_id: string;
  readonly action_id: string;
  readonly run_id: string;
  readonly projection_sequence: number;
  readonly kind: ProjectionEventKind;
  readonly from_state: ProjectionState | null;
  readonly to_state: ProjectionState;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly projection_content_digest: string;
  readonly proof_digests: readonly string[];
  readonly occurred_at: string;
  readonly content_digest: string;
}

export interface ProjectionReceiptWriter {
  appendBatch(events: readonly ProjectionEventProposalV1[]): Promise<readonly CanonicalReceiptRef[]>;
}

export type PlannedTemplateState = "held" | "materialized" | "withdrawn";

export interface PlannedActionTemplateV1 {
  readonly schema_family: "zcr.planned-action-template";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly tool_id: string;
  readonly resource: ActionResource;
  readonly effect_class: EffectClass;
  readonly template_arguments: Readonly<Record<string, unknown>>;
  readonly projected_ref_keys: readonly string[];
  readonly plan_decision?: PlanDecisionRef;
  readonly state: PlannedTemplateState;
  readonly template_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sequence: number;
  readonly content_digest: string;
}

export interface MaterializedActionV1 {
  readonly schema_family: "zcr.materialized-action";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly template_id: string;
  readonly run_id: string;
  readonly capability_handle_id: string;
  readonly effect_class: EffectClass;
  readonly payload: ExactActionPayload;
  readonly canonical_payload_digest: string;
  readonly source_template_digest: string;
  readonly ref_bindings: readonly RefBinding[];
  readonly plan_decision?: PlanDecisionRef;
  readonly requires_fresh_approval: true;
  readonly created_at: string;
  readonly content_digest: string;
}

export interface ProjectionPauseV1 {
  readonly schema_family: "zcr.projection-pause";
  readonly schema_major: 1;
  readonly record_id: string;
  readonly run_id: string;
  readonly action_id: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly input_digest: string;
  readonly reason: string;
  readonly created_at: string;
  readonly content_digest: string;
}

export type ProjectionAttempt =
  | { readonly status: "projected"; readonly snapshot: ProjectionSnapshot }
  | { readonly status: "awaiting_decision"; readonly pause: ProjectionPauseV1 };

export interface ProjectionOverlayValue {
  readonly presentation: "projected" | "resolved" | "unavailable";
  readonly value: unknown | null;
  readonly provisional_refs: readonly ProjectedRef[];
  readonly committed_refs: readonly CommittedRef[];
}

export interface ProjectionSnapshot {
  readonly projection: ProjectionRecordV1;
  readonly receipts: readonly CanonicalReceiptRef[];
}

export interface ProjectionRender {
  readonly badge: "PROJECTED" | "RESOLVED" | "WITHDRAWN" | "INVALIDATED";
  readonly title: string;
  readonly provisional_labels: readonly string[];
  readonly committed_labels: readonly string[];
  readonly renderer_id: "zcr.projection-overlay-renderer";
  readonly renderer_version: 1;
}

interface ProjectionRow {
  readonly snapshot_json: string;
  readonly event_json: string;
  readonly prev_event_hash: string | null;
  readonly event_hash: string;
  readonly projection_sequence: number;
  readonly projection_id: string;
}

interface TemplateRow {
  readonly snapshot_json: string;
  readonly template_sequence: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeExactValue(value));
}

function recordDigest(record: Readonly<Record<string, unknown>>): string {
  const { content_digest: _contentDigest, ...unsigned } = record;
  return sha256(canonicalJson(unsigned));
}

function isReceipt(value: CanonicalReceiptRef | undefined): value is CanonicalReceiptRef {
  return value?.owner === "evidence-substrate/ZOU-1051" && value.schema_major > 0 && value.receipt_id.length > 0 && /^[a-f0-9]{64}$/.test(value.content_digest);
}

function refKey(projectionId: string, localKey: string): string {
  return `${projectionId}\u0000${localKey}`;
}

export function isProjectedRef(value: unknown): value is ProjectedRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectedRef>;
  return candidate.kind === "projected"
    && candidate.schema_major === 1
    && typeof candidate.reference_type === "string" && candidate.reference_type.length > 0
    && typeof candidate.projection_id === "string" && candidate.projection_id.length > 0
    && typeof candidate.local_key === "string" && candidate.local_key.length > 0;
}

export function collectProjectedRefs(value: unknown, found: ProjectedRef[] = [], path = "$", seen = new Set<object>()): ProjectedRef[] {
  if (value === null || typeof value !== "object") return found;
  if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) collectProjectedRefs(value[index], found, `${path}[${index}]`, seen);
  } else {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "projected") {
      if (!isProjectedRef(candidate)) throw new Error(`malformed projected reference at ${path}`);
      found.push(candidate as unknown as ProjectedRef);
    } else {
      for (const [key, child] of Object.entries(candidate)) collectProjectedRefs(child, found, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
  return found;
}

function substituteProjectedRefs(value: unknown, bindings: ReadonlyMap<string, CommittedRef>, path = "$"): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((child, index) => substituteProjectedRefs(child, bindings, `${path}[${index}]`));
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "projected") {
    if (!isProjectedRef(candidate)) throw new Error(`malformed projected reference at ${path}`);
    const committed = bindings.get(refKey(candidate.projection_id, candidate.local_key));
    if (committed === undefined) throw new Error(`unresolved projected reference at ${path}`);
    return committed.provider_id;
  }
  const substituted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(candidate)) {
    substituted[key] = substituteProjectedRefs(child, bindings, `${path}.${key}`);
  }
  return substituted;
}

export function adapterDigest(adapter: Pick<ProjectionAdapter, "adapter_id" | "adapter_version" | "input_schema_digest" | "output_schema_digest">): string {
  return sha256(`zcr.projection-adapter/v1\u0000${adapter.adapter_id}\u0000${adapter.adapter_version}\u0000${adapter.input_schema_digest}\u0000${adapter.output_schema_digest}`);
}

export function renderProjectionOverlay(projection: ProjectionRecordV1): ProjectionRender {
  const badge = projection.state === "projected" ? "PROJECTED"
    : projection.state === "resolved" ? "RESOLVED"
    : projection.state === "withdrawn" ? "WITHDRAWN"
    : "INVALIDATED";
  return {
    badge,
    title: `[${badge}] ${projection.adapter_id}@${projection.adapter_version} for action ${projection.action_id}`,
    provisional_labels: projection.provisional_refs.map((ref) => `projected:${ref.reference_type}:${ref.local_key}:${ref.projection_id}`),
    committed_labels: (projection.committed_refs ?? []).map((ref) => `committed:${ref.reference_type}:${ref.provider}:${ref.provider_id}`),
    renderer_id: "zcr.projection-overlay-renderer",
    renderer_version: 1,
  };
}

export class ProjectionOverlayRuntime {
  private readonly db: Database;
  private readonly values: SealedActionPayloadStore;
  private readonly receipts: ProjectionReceiptWriter;
  private readonly now: () => Date;
  private readonly nextId: (prefix: string) => string;

  constructor(input: {
    readonly path: string;
    readonly values: SealedActionPayloadStore;
    readonly receipts: ProjectionReceiptWriter;
    readonly now?: () => Date;
    readonly next_id?: (prefix: string) => string;
  }) {
    if (!input.path.startsWith("/")) throw new Error("projection overlay path must be absolute");
    const path = resolve(input.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.values = input.values;
    this.receipts = input.receipts;
    this.now = input.now ?? (() => new Date());
    this.nextId = input.next_id ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS overlay_meta (schema_version INTEGER NOT NULL, schema_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projections (
        projection_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        base_json TEXT NOT NULL,
        UNIQUE(action_id)
      );
      CREATE TABLE IF NOT EXISTS projection_events (
        commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        projection_id TEXT NOT NULL REFERENCES projections(projection_id),
        projection_sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        event_json TEXT NOT NULL,
        prev_event_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE(projection_id, projection_sequence)
      );
      CREATE TABLE IF NOT EXISTS receipt_outbox (
        event_id TEXT PRIMARY KEY REFERENCES projection_events(event_id),
        projection_id TEXT NOT NULL REFERENCES projections(projection_id),
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipt_acks (
        event_id TEXT PRIMARY KEY REFERENCES receipt_outbox(event_id),
        receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pauses (
        pause_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        pause_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        template_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        template_digest TEXT NOT NULL,
        base_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS template_events (
        commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        template_sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        UNIQUE(template_id, template_sequence)
      );
      CREATE TABLE IF NOT EXISTS template_refs (
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        projection_id TEXT NOT NULL REFERENCES projections(projection_id),
        local_key TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        PRIMARY KEY(template_id, projection_id, local_key)
      );
      CREATE TABLE IF NOT EXISTS materializations (
        template_id TEXT PRIMARY KEY REFERENCES templates(template_id),
        materialization_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS projections_no_update BEFORE UPDATE ON projections BEGIN SELECT RAISE(ABORT, 'projections are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS projections_no_delete BEFORE DELETE ON projections BEGIN SELECT RAISE(ABORT, 'projections are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS projection_events_no_update BEFORE UPDATE ON projection_events BEGIN SELECT RAISE(ABORT, 'projection events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS projection_events_no_delete BEFORE DELETE ON projection_events BEGIN SELECT RAISE(ABORT, 'projection events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outbox_no_update BEFORE UPDATE ON receipt_outbox BEGIN SELECT RAISE(ABORT, 'outbox is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS outbox_no_delete BEFORE DELETE ON receipt_outbox BEGIN SELECT RAISE(ABORT, 'outbox is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS acks_no_update BEFORE UPDATE ON receipt_acks BEGIN SELECT RAISE(ABORT, 'receipt acknowledgements are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS acks_no_delete BEFORE DELETE ON receipt_acks BEGIN SELECT RAISE(ABORT, 'receipt acknowledgements are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS pauses_no_update BEFORE UPDATE ON pauses BEGIN SELECT RAISE(ABORT, 'pauses are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS pauses_no_delete BEFORE DELETE ON pauses BEGIN SELECT RAISE(ABORT, 'pauses are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS templates_no_update BEFORE UPDATE ON templates BEGIN SELECT RAISE(ABORT, 'templates are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS templates_no_delete BEFORE DELETE ON templates BEGIN SELECT RAISE(ABORT, 'templates are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS template_events_no_update BEFORE UPDATE ON template_events BEGIN SELECT RAISE(ABORT, 'template events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS template_events_no_delete BEFORE DELETE ON template_events BEGIN SELECT RAISE(ABORT, 'template events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS template_refs_no_update BEFORE UPDATE ON template_refs BEGIN SELECT RAISE(ABORT, 'template refs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS template_refs_no_delete BEFORE DELETE ON template_refs BEGIN SELECT RAISE(ABORT, 'template refs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS materializations_no_update BEFORE UPDATE ON materializations BEGIN SELECT RAISE(ABORT, 'materializations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS materializations_no_delete BEFORE DELETE ON materializations BEGIN SELECT RAISE(ABORT, 'materializations are immutable'); END;
    `);
    const metadata = this.db.query("SELECT schema_version, schema_digest FROM overlay_meta LIMIT 1").get() as { schema_version: number; schema_digest: string } | null;
    if (metadata === null) {
      this.db.query("INSERT INTO overlay_meta(schema_version, schema_digest) VALUES (?, ?)").run(SCHEMA_VERSION, SCHEMA_DIGEST);
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    } else if (metadata.schema_version !== SCHEMA_VERSION || metadata.schema_digest !== SCHEMA_DIGEST) {
      throw new Error("projection overlay schema mismatch");
    }
    const quickCheck = (this.db.query("PRAGMA quick_check").get() as { quick_check: string })["quick_check"];
    if (quickCheck !== "ok") throw new Error(`projection overlay quick_check failed: ${quickCheck}`);
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

  private latestRow(projectionId: string): ProjectionRow | null {
    return this.db.query(`
      SELECT projection_id, projection_sequence, snapshot_json, event_json, prev_event_hash, event_hash
      FROM projection_events WHERE projection_id = ? ORDER BY projection_sequence DESC LIMIT 1
    `).get(projectionId) as ProjectionRow | null;
  }

  private latestProjection(projectionId: string): ProjectionRecordV1 | null {
    const row = this.latestRow(projectionId);
    if (row === null) return null;
    const projection = JSON.parse(row.snapshot_json) as ProjectionRecordV1;
    this.verifyProjection(projection);
    return projection;
  }

  private verifyProjection(projection: ProjectionRecordV1): void {
    if (recordDigest(projection as unknown as Readonly<Record<string, unknown>>) !== projection.content_digest) {
      throw new Error(`projection content digest mismatch: ${projection.record_id}`);
    }
  }

  assertIntegrity(): void {
    const quickCheck = (this.db.query("PRAGMA quick_check").get() as { quick_check: string })["quick_check"];
    if (quickCheck !== "ok") throw new Error(`projection overlay integrity failure: ${quickCheck}`);
    const rows = this.db.query(`
      SELECT projection_id, projection_sequence, snapshot_json, event_json, prev_event_hash, event_hash
      FROM projection_events ORDER BY commit_sequence
    `).all() as ProjectionRow[];
    const previous = new Map<string, { sequence: number; hash: string }>();
    for (const row of rows) {
      const prior = previous.get(row.projection_id);
      if (row.projection_sequence !== (prior?.sequence ?? 0) + 1) throw new Error(`projection sequence gap: ${row.projection_id}`);
      if (row.prev_event_hash !== (prior?.hash ?? null)) throw new Error(`projection hash chain gap: ${row.projection_id}`);
      if (sha256(`zcr.projection-event/v1\n${row.prev_event_hash ?? ""}\n${row.event_json}`) !== row.event_hash) {
        throw new Error(`projection event hash mismatch: ${row.projection_id}`);
      }
      this.verifyProjection(JSON.parse(row.snapshot_json) as ProjectionRecordV1);
      previous.set(row.projection_id, { sequence: row.projection_sequence, hash: row.event_hash });
    }
  }

  private buildProposal(input: {
    readonly eventId: string;
    readonly projection: ProjectionRecordV1;
    readonly kind: ProjectionEventKind;
    readonly fromState: ProjectionState | null;
    readonly proofDigests: readonly string[];
  }): ProjectionEventProposalV1 {
    const unsigned = {
      schema_family: "zcr.projection-event-proposal" as const,
      schema_major: 1 as const,
      event_id: input.eventId,
      projection_id: input.projection.record_id,
      action_id: input.projection.action_id,
      run_id: input.projection.run_id,
      projection_sequence: input.projection.sequence,
      kind: input.kind,
      from_state: input.fromState,
      to_state: input.projection.state,
      adapter_id: input.projection.adapter_id,
      adapter_version: input.projection.adapter_version,
      projection_content_digest: input.projection.content_digest,
      proof_digests: input.proofDigests,
      occurred_at: input.projection.updated_at,
    };
    return { ...unsigned, content_digest: sha256(canonicalJson(unsigned)) };
  }

  private insertEvent(projection: ProjectionRecordV1, kind: ProjectionEventKind, fromState: ProjectionState | null, proofDigests: readonly string[]): string {
    const previous = this.latestRow(projection.record_id);
    const expectedSequence = (previous?.projection_sequence ?? 0) + 1;
    if (projection.sequence !== expectedSequence) throw new Error(`projection CAS sequence conflict: ${projection.record_id}`);
    const eventId = this.nextId("projection-event");
    const proposal = this.buildProposal({ eventId, projection, kind, fromState, proofDigests });
    const eventJson = canonicalJson({
      event_id: eventId,
      projection_id: projection.record_id,
      projection_sequence: projection.sequence,
      from_state: fromState,
      to_state: projection.state,
      proposal_digest: proposal.content_digest,
    });
    const previousHash = previous?.event_hash ?? null;
    const eventHash = sha256(`zcr.projection-event/v1\n${previousHash ?? ""}\n${eventJson}`);
    this.db.query(`
      INSERT INTO projection_events(event_id, projection_id, projection_sequence, snapshot_json, event_json, prev_event_hash, event_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, projection.record_id, projection.sequence, canonicalJson(projection), eventJson, previousHash, eventHash);
    this.db.query("INSERT INTO receipt_outbox(event_id, projection_id, event_json) VALUES (?, ?, ?)")
      .run(eventId, projection.record_id, canonicalJson(proposal));
    return eventId;
  }

  private async flushEvent(eventId: string): Promise<CanonicalReceiptRef> {
    const existing = this.db.query("SELECT receipt_json FROM receipt_acks WHERE event_id = ?").get(eventId) as { receipt_json: string } | null;
    if (existing !== null) return JSON.parse(existing.receipt_json) as CanonicalReceiptRef;
    const row = this.db.query("SELECT event_json FROM receipt_outbox WHERE event_id = ?").get(eventId) as { event_json: string } | null;
    if (row === null) throw new Error(`missing projection receipt outbox event: ${eventId}`);
    const proposal = JSON.parse(row.event_json) as ProjectionEventProposalV1;
    const written = await this.receipts.appendBatch([proposal]);
    const receipt = written[0];
    if (written.length !== 1 || !isReceipt(receipt)) throw new Error("canonical projection receipt unavailable");
    this.immediate(() => {
      const prior = this.db.query("SELECT receipt_json FROM receipt_acks WHERE event_id = ?").get(eventId) as { receipt_json: string } | null;
      if (prior !== null) {
        if (prior.receipt_json !== canonicalJson(receipt)) throw new Error(`canonical projection receipt conflict: ${eventId}`);
        return;
      }
      this.db.query("INSERT INTO receipt_acks(event_id, receipt_json) VALUES (?, ?)").run(eventId, canonicalJson(receipt));
    });
    return receipt;
  }

  private async flushPending(projectionId: string): Promise<void> {
    const rows = this.db.query(`
      SELECT o.event_id FROM receipt_outbox o LEFT JOIN receipt_acks a ON a.event_id = o.event_id
      WHERE o.projection_id = ? AND a.event_id IS NULL ORDER BY o.rowid
    `).all(projectionId) as Array<{ event_id: string }>;
    for (const row of rows) await this.flushEvent(row.event_id);
  }

  private snapshot(projectionId: string): ProjectionSnapshot {
    const projection = this.latestProjection(projectionId);
    if (projection === null) throw new Error(`unknown projection: ${projectionId}`);
    const rows = this.db.query(`
      SELECT a.receipt_json FROM receipt_acks a JOIN receipt_outbox o ON o.event_id = a.event_id
      WHERE o.projection_id = ? ORDER BY o.rowid
    `).all(projectionId) as Array<{ receipt_json: string }>;
    return { projection, receipts: rows.map((row) => JSON.parse(row.receipt_json) as CanonicalReceiptRef) };
  }

  private verifyActionProof(action: ActionRecordV1): void {
    if (actionRecordDigest(action as unknown as Readonly<Record<string, unknown>>) !== action.content_digest) {
      throw new Error(`action proof digest mismatch: ${action.record_id}`);
    }
  }

  private async recordPause(input: {
    readonly action: ActionRecordV1;
    readonly adapter: ProjectionAdapter;
    readonly inputDigest: string;
    readonly reason: string;
  }): Promise<ProjectionAttempt> {
    const unsigned = {
      schema_family: "zcr.projection-pause" as const,
      schema_major: 1 as const,
      record_id: this.nextId("projection-pause"),
      run_id: input.action.run_id,
      action_id: input.action.record_id,
      adapter_id: input.adapter.adapter_id,
      adapter_version: input.adapter.adapter_version,
      input_digest: input.inputDigest,
      reason: input.reason,
      created_at: this.now().toISOString(),
    };
    const pause: ProjectionPauseV1 = { ...unsigned, content_digest: sha256(canonicalJson(unsigned)) };
    this.immediate(() => {
      this.db.query("INSERT INTO pauses(pause_id, action_id, pause_json) VALUES (?, ?, ?)")
        .run(pause.record_id, pause.action_id, canonicalJson(pause));
    });
    return { status: "awaiting_decision", pause };
  }

  pausesFor(actionId: string): readonly ProjectionPauseV1[] {
    const rows = this.db.query("SELECT pause_json FROM pauses WHERE action_id = ? ORDER BY rowid").all(actionId) as Array<{ pause_json: string }>;
    return rows.map((row) => JSON.parse(row.pause_json) as ProjectionPauseV1);
  }

  async project(input: {
    readonly action: ActionRecordV1;
    readonly payload: ExactActionPayload;
    readonly adapter: ProjectionAdapter;
  }): Promise<ProjectionAttempt> {
    this.assertIntegrity();
    const { action, payload, adapter } = input;
    this.verifyActionProof(action);
    if (!["staged", "awaiting_approval", "approved"].includes(action.state)) {
      throw new Error(`projection requires a pre-dispatch action state: ${action.state}`);
    }
    if (exactActionDigest(payload) !== action.canonical_payload_digest) {
      throw new Error("projection payload does not match the staged action");
    }
    const inputDigest = action.canonical_payload_digest;
    if (action.effect_class === "destructive_write") {
      return this.recordPause({ action, adapter, inputDigest, reason: "destructive_write is outside the reversible projection pilot set" });
    }
    const existing = this.db.query("SELECT projection_id FROM projections WHERE action_id = ?").get(action.record_id) as { projection_id: string } | null;
    if (existing !== null) {
      await this.flushPending(existing.projection_id);
      return { status: "projected", snapshot: this.snapshot(existing.projection_id) };
    }
    const first = adapter.project({ action, payload });
    const second = adapter.project({ action, payload });
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new Error(`projection adapter is nondeterministic: ${adapter.adapter_id}@${adapter.adapter_version}`);
    }
    if (first.status === "awaitDecision") {
      return this.recordPause({ action, adapter, inputDigest, reason: first.reason });
    }
    if (first.provisional_refs.length === 0) throw new Error("projection must declare at least one provisional reference");
    const keys = new Set<string>();
    for (const spec of first.provisional_refs) {
      if (!spec.reference_type || !spec.local_key) throw new Error("provisional reference spec is incomplete");
      if (keys.has(spec.local_key)) throw new Error(`duplicate provisional local_key: ${spec.local_key}`);
      keys.add(spec.local_key);
    }
    assertNoProjectedRefs(first.projected_value, "$.projected_value");
    const projectionId = this.nextId("projection");
    const provisionalRefs: ProjectedRef[] = first.provisional_refs.map((spec) => ({
      kind: "projected",
      schema_major: 1,
      reference_type: spec.reference_type,
      projection_id: projectionId,
      local_key: spec.local_key,
    }));
    const canonicalValue = canonicalJson(first.projected_value);
    const valueRef = await this.values.put(canonicalValue);
    const timestamp = this.now().toISOString();
    const refsCanonical = canonicalJson([...first.provisional_refs].sort((a, b) => a.local_key.localeCompare(b.local_key)));
    const unsigned = {
      schema_family: "zcr.projection" as const,
      schema_major: 1 as const,
      record_id: projectionId,
      run_id: action.run_id,
      action_id: action.record_id,
      adapter_id: adapter.adapter_id,
      adapter_version: adapter.adapter_version,
      adapter_digest: adapterDigest(adapter),
      input_digest: inputDigest,
      input_schema_digest: adapter.input_schema_digest,
      output_schema_digest: adapter.output_schema_digest,
      dependency_graph_digest: sha256(`zcr.projection-deps/v1\u0000${action.record_id}\u0000${refsCanonical}`),
      projected_value_ref: valueRef,
      projected_value_digest: sha256(canonicalValue),
      provisional_refs: provisionalRefs,
      state: "projected" as const,
      created_at: timestamp,
      updated_at: timestamp,
      sequence: 1,
    };
    const projection: ProjectionRecordV1 = { ...unsigned, content_digest: recordDigest(unsigned) };
    const eventId = this.immediate(() => {
      this.db.query("INSERT INTO projections(projection_id, action_id, run_id, base_json) VALUES (?, ?, ?, ?)")
        .run(projectionId, action.record_id, action.run_id, canonicalJson(projection));
      return this.insertEvent(projection, "projected", null, [action.content_digest]);
    });
    await this.flushEvent(eventId);
    return { status: "projected", snapshot: this.snapshot(projectionId) };
  }

  private transition(input: {
    readonly projectionId: string;
    readonly targetState: ProjectionState;
    readonly kind: ProjectionEventKind;
    readonly proofDigests: readonly string[];
    readonly committedRefs?: readonly CommittedRef[];
  }): string {
    return this.immediate(() => {
      const current = this.latestProjection(input.projectionId);
      if (current === null) throw new Error(`unknown projection: ${input.projectionId}`);
      assertProjectionTransition(current.state, input.targetState);
      const unsigned = {
        ...current,
        state: input.targetState,
        ...(input.committedRefs === undefined ? {} : { committed_refs: input.committedRefs }),
        updated_at: this.now().toISOString(),
        sequence: current.sequence + 1,
      };
      const { content_digest: _old, ...withoutDigest } = unsigned;
      const next: ProjectionRecordV1 = { ...withoutDigest, content_digest: recordDigest(withoutDigest) } as ProjectionRecordV1;
      return this.insertEvent(next, input.kind, current.state, input.proofDigests);
    });
  }

  async resolve(input: {
    readonly projection_id: string;
    readonly action_proof: ActionRecordV1;
    readonly committed_refs: readonly CommittedRef[];
  }): Promise<ProjectionSnapshot> {
    this.assertIntegrity();
    const projection = this.latestProjection(input.projection_id);
    if (projection === null) throw new Error(`unknown projection: ${input.projection_id}`);
    this.verifyActionProof(input.action_proof);
    if (input.action_proof.record_id !== projection.action_id) throw new Error("action proof does not match projection");
    if (input.action_proof.state !== "applied") {
      throw new Error(`projection resolution requires an applied action, got: ${input.action_proof.state}`);
    }
    const provided = new Set<string>();
    for (const committed of input.committed_refs) {
      if (committed.kind !== "committed" || committed.schema_major !== 1) throw new Error("malformed committed reference");
      if (!committed.provider || !committed.provider_id) throw new Error("committed reference requires provider identifiers");
      const localKey = this.localKeyFor(projection, committed);
      if (provided.has(localKey)) throw new Error(`duplicate committed reference: ${localKey}`);
      provided.add(localKey);
    }
    if (provided.size !== projection.provisional_refs.length) {
      throw new Error("committed references must cover every provisional reference");
    }
    const eventId = this.transition({
      projectionId: input.projection_id,
      targetState: "resolved",
      kind: "resolved",
      proofDigests: [input.action_proof.content_digest],
      committedRefs: input.committed_refs,
    });
    await this.flushEvent(eventId);
    return this.snapshot(input.projection_id);
  }

  private localKeyFor(projection: ProjectionRecordV1, committed: CommittedRef): string {
    const matches = projection.provisional_refs.filter((ref) => ref.reference_type === committed.reference_type);
    if (matches.length !== 1) {
      throw new Error(`committed reference type is ambiguous or unknown: ${committed.reference_type}`);
    }
    return matches[0]!.local_key;
  }

  async withdraw(input: {
    readonly projection_id: string;
    readonly action_proof: ActionRecordV1;
  }): Promise<ProjectionSnapshot> {
    this.assertIntegrity();
    const projection = this.latestProjection(input.projection_id);
    if (projection === null) throw new Error(`unknown projection: ${input.projection_id}`);
    this.verifyActionProof(input.action_proof);
    if (input.action_proof.record_id !== projection.action_id) throw new Error("action proof does not match projection");
    if (!["rejected", "canceled"].includes(input.action_proof.state)) {
      throw new Error(`projection withdrawal requires a rejected or canceled action, got: ${input.action_proof.state}`);
    }
    const eventId = this.transition({
      projectionId: input.projection_id,
      targetState: "withdrawn",
      kind: "withdrawn",
      proofDigests: [input.action_proof.content_digest],
    });
    await this.flushEvent(eventId);
    this.cascadeTemplates(input.projection_id, "withdrawn");
    return this.snapshot(input.projection_id);
  }

  async invalidate(input: {
    readonly projection_id: string;
    readonly reason: "adapter_drift" | "restart_mismatch" | "failed_action_proof";
  }): Promise<ProjectionSnapshot> {
    this.assertIntegrity();
    const projection = this.latestProjection(input.projection_id);
    if (projection === null) throw new Error(`unknown projection: ${input.projection_id}`);
    const eventId = this.transition({
      projectionId: input.projection_id,
      targetState: "invalidated",
      kind: "invalidated",
      proofDigests: [sha256(`zcr.projection-invalidation/v1\u0000${input.reason}`)],
    });
    await this.flushEvent(eventId);
    this.cascadeTemplates(input.projection_id, "withdrawn");
    return this.snapshot(input.projection_id);
  }

  async verifyAdapters(registry: readonly ProjectionAdapter[]): Promise<readonly ProjectionSnapshot[]> {
    this.assertIntegrity();
    const byId = new Map(registry.map((adapter) => [adapter.adapter_id, adapter]));
    const rows = this.db.query("SELECT projection_id FROM projections ORDER BY rowid").all() as Array<{ projection_id: string }>;
    const invalidated: ProjectionSnapshot[] = [];
    for (const row of rows) {
      await this.flushPending(row.projection_id);
      const projection = this.latestProjection(row.projection_id);
      if (projection === null || projection.state !== "projected") continue;
      const adapter = byId.get(projection.adapter_id);
      const drifted = adapter === undefined
        || adapter.adapter_version !== projection.adapter_version
        || adapterDigest(adapter) !== projection.adapter_digest;
      if (drifted) {
        invalidated.push(await this.invalidate({ projection_id: row.projection_id, reason: "adapter_drift" }));
      }
    }
    return invalidated;
  }

  async overlay(projectionId: string): Promise<ProjectionOverlayValue> {
    this.assertIntegrity();
    const projection = this.latestProjection(projectionId);
    if (projection === null) throw new Error(`unknown projection: ${projectionId}`);
    if (projection.state === "withdrawn" || projection.state === "invalidated") {
      return { presentation: "unavailable", value: null, provisional_refs: projection.provisional_refs, committed_refs: projection.committed_refs ?? [] };
    }
    const canonical = await this.values.get(projection.projected_value_ref);
    if (canonical === null) throw new Error("projected overlay value unavailable");
    if (sha256(canonical) !== projection.projected_value_digest) throw new Error("projected overlay value digest mismatch");
    return {
      presentation: projection.state === "resolved" ? "resolved" : "projected",
      value: JSON.parse(canonical) as unknown,
      provisional_refs: projection.provisional_refs,
      committed_refs: projection.committed_refs ?? [],
    };
  }

  get(projectionId: string): ProjectionSnapshot | null {
    this.assertIntegrity();
    return this.latestProjection(projectionId) === null ? null : this.snapshot(projectionId);
  }

  private latestTemplate(templateId: string): PlannedActionTemplateV1 | null {
    const row = this.db.query(`
      SELECT snapshot_json, template_sequence FROM template_events
      WHERE template_id = ? ORDER BY template_sequence DESC LIMIT 1
    `).get(templateId) as TemplateRow | null;
    if (row === null) return null;
    const template = JSON.parse(row.snapshot_json) as PlannedActionTemplateV1;
    if (recordDigest(template as unknown as Readonly<Record<string, unknown>>) !== template.content_digest) {
      throw new Error(`template content digest mismatch: ${template.record_id}`);
    }
    return template;
  }

  private insertTemplateSnapshot(template: PlannedActionTemplateV1): void {
    this.db.query("INSERT INTO template_events(template_id, template_sequence, snapshot_json) VALUES (?, ?, ?)")
      .run(template.record_id, template.sequence, canonicalJson(template));
  }

  private transitionTemplate(templateId: string, targetState: PlannedTemplateState): PlannedActionTemplateV1 {
    const current = this.latestTemplate(templateId);
    if (current === null) throw new Error(`unknown template: ${templateId}`);
    if (current.state !== "held") throw new Error(`template is not held: ${current.state}`);
    const unsigned = {
      ...current,
      state: targetState,
      updated_at: this.now().toISOString(),
      sequence: current.sequence + 1,
    };
    const { content_digest: _old, ...withoutDigest } = unsigned;
    const next: PlannedActionTemplateV1 = { ...withoutDigest, content_digest: recordDigest(withoutDigest) } as PlannedActionTemplateV1;
    this.insertTemplateSnapshot(next);
    return next;
  }

  private cascadeTemplates(projectionId: string, targetState: "withdrawn"): void {
    const rows = this.db.query("SELECT DISTINCT template_id FROM template_refs WHERE projection_id = ?").all(projectionId) as Array<{ template_id: string }>;
    this.immediate(() => {
      for (const row of rows) {
        const current = this.latestTemplate(row.template_id);
        if (current?.state === "held") this.transitionTemplate(row.template_id, targetState);
      }
    });
  }

  holdTemplate(input: {
    readonly run_id: string;
    readonly capability_handle_id: string;
    readonly tool_id: string;
    readonly resource: ActionResource;
    readonly effect_class: EffectClass;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly plan_decision?: PlanDecisionRef;
  }): PlannedActionTemplateV1 {
    this.assertIntegrity();
    if (!input.tool_id || !input.resource.kind || !input.resource.resource_id) {
      throw new Error("template requires tool and resource identifiers");
    }
    const refs = collectProjectedRefs(input.arguments);
    if (refs.length === 0) {
      throw new Error("template has no projected references; stage it as an exact action instead");
    }
    const keys = new Set<string>();
    for (const ref of refs) {
      const key = refKey(ref.projection_id, ref.local_key);
      keys.add(key);
      const projection = this.latestProjection(ref.projection_id);
      if (projection === null) throw new Error(`template references unknown projection: ${ref.projection_id}`);
      if (projection.run_id !== input.run_id) throw new Error("template references a projection from another run");
      if (projection.state !== "projected" && projection.state !== "resolved") {
        throw new Error(`template references a ${projection.state} projection: ${ref.projection_id}`);
      }
      if (!projection.provisional_refs.some((provisional) => provisional.local_key === ref.local_key && provisional.reference_type === ref.reference_type)) {
        throw new Error(`template reference does not match a provisional reference: ${ref.local_key}`);
      }
    }
    const templateId = this.nextId("planned-template");
    const timestamp = this.now().toISOString();
    const templateDigest = sha256(canonicalJson({
      tool_id: input.tool_id,
      resource: input.resource,
      arguments: input.arguments,
      effect_class: input.effect_class,
      capability_handle_id: input.capability_handle_id,
    }));
    const unsigned = {
      schema_family: "zcr.planned-action-template" as const,
      schema_major: 1 as const,
      record_id: templateId,
      run_id: input.run_id,
      capability_handle_id: input.capability_handle_id,
      tool_id: input.tool_id,
      resource: input.resource,
      effect_class: input.effect_class,
      template_arguments: input.arguments,
      projected_ref_keys: [...keys].sort(),
      ...(input.plan_decision === undefined ? {} : { plan_decision: input.plan_decision }),
      state: "held" as const,
      template_digest: templateDigest,
      created_at: timestamp,
      updated_at: timestamp,
      sequence: 1,
    };
    const template: PlannedActionTemplateV1 = { ...unsigned, content_digest: recordDigest(unsigned) };
    this.immediate(() => {
      this.db.query("INSERT INTO templates(template_id, run_id, template_digest, base_json) VALUES (?, ?, ?, ?)")
        .run(templateId, input.run_id, templateDigest, canonicalJson(template));
      this.insertTemplateSnapshot(template);
      for (const ref of refs) {
        this.db.query("INSERT OR IGNORE INTO template_refs(template_id, projection_id, local_key, reference_type) VALUES (?, ?, ?, ?)")
          .run(templateId, ref.projection_id, ref.local_key, ref.reference_type);
      }
    });
    return template;
  }

  getTemplate(templateId: string): PlannedActionTemplateV1 | null {
    this.assertIntegrity();
    return this.latestTemplate(templateId);
  }

  materialize(templateId: string): MaterializedActionV1 {
    this.assertIntegrity();
    const template = this.latestTemplate(templateId);
    if (template === null) throw new Error(`unknown template: ${templateId}`);
    const prior = this.db.query("SELECT materialization_json FROM materializations WHERE template_id = ?").get(templateId) as { materialization_json: string } | null;
    if (prior !== null) {
      const existing = JSON.parse(prior.materialization_json) as MaterializedActionV1;
      if (recordDigest(existing as unknown as Readonly<Record<string, unknown>>) !== existing.content_digest) {
        throw new Error(`materialization content digest mismatch: ${templateId}`);
      }
      return existing;
    }
    if (template.state !== "held") throw new Error(`template is not held: ${template.state}`);
    const refs = collectProjectedRefs(template.template_arguments);
    const bindings = new Map<string, CommittedRef>();
    const refBindings: RefBinding[] = [];
    for (const ref of refs) {
      const projection = this.latestProjection(ref.projection_id);
      if (projection === null) throw new Error(`unknown projection: ${ref.projection_id}`);
      if (projection.state !== "resolved") {
        throw new Error(`materialization requires resolved projections; ${ref.projection_id} is ${projection.state}`);
      }
      const committed = (projection.committed_refs ?? []).find((candidate) => candidate.reference_type === ref.reference_type);
      if (committed === undefined) throw new Error(`resolved projection lacks a committed reference for: ${ref.reference_type}`);
      bindings.set(refKey(ref.projection_id, ref.local_key), committed);
      refBindings.push({ projected: ref, committed });
    }
    const substituted = substituteProjectedRefs(template.template_arguments, bindings) as Readonly<Record<string, unknown>>;
    const payload: ExactActionPayload = {
      tool_id: template.tool_id,
      resource: template.resource,
      arguments: substituted,
    };
    const canonicalPayloadDigest = exactActionDigest(payload);
    canonicalizeExactAction(payload);
    const unsigned = {
      schema_family: "zcr.materialized-action" as const,
      schema_major: 1 as const,
      record_id: this.nextId("materialized-action"),
      template_id: templateId,
      run_id: template.run_id,
      capability_handle_id: template.capability_handle_id,
      effect_class: template.effect_class,
      payload,
      canonical_payload_digest: canonicalPayloadDigest,
      source_template_digest: template.template_digest,
      ref_bindings: refBindings,
      ...(template.plan_decision === undefined ? {} : { plan_decision: template.plan_decision }),
      requires_fresh_approval: true as const,
      created_at: this.now().toISOString(),
    };
    const materialized: MaterializedActionV1 = { ...unsigned, content_digest: recordDigest(unsigned) };
    this.immediate(() => {
      this.db.query("INSERT INTO materializations(template_id, materialization_json) VALUES (?, ?)")
        .run(templateId, canonicalJson(materialized));
      this.transitionTemplate(templateId, "materialized");
    });
    return materialized;
  }
}
