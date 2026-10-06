import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ShadowConsumer, ShadowOutcome, ShadowVerdictRecordV1, ShadowWindowStatus } from "./shadow-contracts.js";
import { SHADOW_CONSUMERS } from "./shadow-contracts.js";
import { canonicalPayloadDigest } from "../fingerprint.js";

export const SHADOW_WINDOW_TARGET_EVENTS = 30;
export const SHADOW_WINDOW_TARGET_DAYS = 7;

const ELIGIBLE_OUTCOMES: readonly ShadowOutcome[] = ["staged_awaiting_approval", "read_permitted", "denied"];

export type ShadowEventReservation =
  | { readonly outcome: "reserved" }
  | { readonly outcome: "existing" }
  | { readonly outcome: "idempotency_conflict" };

export class ShadowEventReservationStore {
  private readonly db: Database;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("shadow event reservation path must be absolute");
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    this.db = new Database(resolved, { create: true, strict: true });
    chmodSync(resolved, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_events (
        consumer TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (consumer, event_id)
      );
    `);
  }

  reserve(input: {
    readonly consumer: ShadowConsumer;
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly createdAt: string;
  }): ShadowEventReservation {
    const result = this.db.query(`
      INSERT INTO shadow_events(consumer, event_id, payload_digest, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(consumer, event_id) DO NOTHING
    `).run(input.consumer, input.eventId, input.payloadDigest, input.createdAt);
    const row = this.db.query(
      "SELECT payload_digest, created_at FROM shadow_events WHERE consumer = ? AND event_id = ?",
    ).get(input.consumer, input.eventId) as { payload_digest: string; created_at: string } | null;
    if (row === null) throw new Error("shadow event reservation was not persisted");
    if (row.payload_digest !== input.payloadDigest) return { outcome: "idempotency_conflict" };
    return { outcome: result.changes === 1 ? "reserved" : "existing" };
  }
}

export class ShadowVerdictStore {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "verdicts.jsonl");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  append(record: ShadowVerdictRecordV1): void {
    const { content_digest: _, ...unsigned } = record;
    const digest = canonicalPayloadDigest(unsigned);
    if (digest !== record.content_digest) throw new Error("shadow verdict content digest mismatch");
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  readAll(): ShadowVerdictRecordV1[] {
    if (!existsSync(this.path)) return [];
    const records: ShadowVerdictRecordV1[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as ShadowVerdictRecordV1;
      const { content_digest, ...unsigned } = parsed;
      if (canonicalPayloadDigest(unsigned) !== content_digest) {
        throw new Error("shadow verdict store integrity violation: digest mismatch");
      }
      records.push(parsed);
    }
    return records;
  }

  windowStatus(input?: { readonly targetEvents?: number; readonly targetDays?: number }): ShadowWindowStatus {
    const targetEvents = input?.targetEvents ?? SHADOW_WINDOW_TARGET_EVENTS;
    const targetDays = input?.targetDays ?? SHADOW_WINDOW_TARGET_DAYS;
    const records = this.readAll();
    const eligible = records.filter((record) => ELIGIBLE_OUTCOMES.includes(record.outcome));
    const byConsumer = Object.fromEntries(SHADOW_CONSUMERS.map((consumer) => [consumer, 0])) as Record<
      ShadowConsumer,
      number
    >;
    const byOutcome: Partial<Record<ShadowOutcome, number>> = {};
    for (const record of records) byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    for (const record of eligible) byConsumer[record.consumer] += 1;
    const days = new Set(eligible.map((record) => record.observed_at.slice(0, 10)));
    const observedAts = eligible.map((record) => record.observed_at).sort();
    const spanDays =
      observedAts.length === 0
        ? 0
        : Math.floor(
            (Date.parse(observedAts[observedAts.length - 1]!) - Date.parse(observedAts[0]!)) / (24 * 60 * 60 * 1000),
          );
    const satisfied =
      eligible.length >= targetEvents &&
      days.size >= targetDays &&
      spanDays >= targetDays &&
      SHADOW_CONSUMERS.every((consumer) => byConsumer[consumer] > 0);
    return {
      total_verdicts: records.length,
      eligible_events: eligible.length,
      distinct_days: days.size,
      first_at: observedAts[0] ?? null,
      last_at: observedAts[observedAts.length - 1] ?? null,
      by_consumer: byConsumer,
      by_outcome: byOutcome,
      target_events: targetEvents,
      target_days: targetDays,
      satisfied,
    };
  }
}
