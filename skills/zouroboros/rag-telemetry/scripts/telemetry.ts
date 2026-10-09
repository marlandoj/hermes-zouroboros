import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const RAG_TELEMETRY_SCHEMA_VERSION = 2 as const;

type Env = Record<string, string | undefined>;

/**
 * Default sink: RAG_TELEMETRY_PATH, else <ZOUROBOROS_LOG_DIR>/rag-telemetry.jsonl, else
 * logs/rag-telemetry.jsonl in the hermes-zouroboros profile data directory.
 */
export function defaultRagTelemetryPath(env: Env = process.env): string {
  if (env.RAG_TELEMETRY_PATH) return env.RAG_TELEMETRY_PATH;
  const dataDir = resolve(
    env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "hermes-zouroboros"),
  );
  return join(env.ZOUROBOROS_LOG_DIR || join(dataDir, "logs"), "rag-telemetry.jsonl");
}

export type RagMethod = "vector" | "graph";
export type RagOperation = "query" | "index";

export interface RagTelemetryEvent {
  schemaVersion: typeof RAG_TELEMETRY_SCHEMA_VERSION;
  ts: string;
  method: RagMethod;
  operation: RagOperation;
  source: string;
  ok: boolean;
  errored: boolean;
  durationMs: number;
  resultCount: number;
  zeroResult: boolean;
  queryPreview?: string;
  queryLength?: number;
  error?: string;
  details: Record<string, unknown>;
}

export interface RagTelemetryInput {
  method: RagMethod;
  operation: RagOperation;
  source: string;
  ok: boolean;
  durationMs: number;
  resultCount?: number;
  zeroResult?: boolean;
  query?: string;
  error?: unknown;
  details?: Record<string, unknown>;
  ts?: string;
}

function boundedText(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return boundedText(error instanceof Error ? error.message : String(error), 240);
}

export function buildRagTelemetryEvent(input: RagTelemetryInput): RagTelemetryEvent {
  const resultCount = Math.max(0, Math.trunc(input.resultCount ?? 0));
  const query = input.query?.trim();
  return {
    schemaVersion: RAG_TELEMETRY_SCHEMA_VERSION,
    ts: input.ts ?? new Date().toISOString(),
    method: input.method,
    operation: input.operation,
    source: boundedText(input.source, 80),
    ok: input.ok,
    errored: !input.ok,
    durationMs: Number(Math.max(0, input.durationMs).toFixed(2)),
    resultCount,
    zeroResult: input.zeroResult ?? (input.ok && resultCount === 0),
    ...(query ? { queryPreview: boundedText(query, 160), queryLength: query.length } : {}),
    ...(!input.ok && errorText(input.error) ? { error: errorText(input.error) } : {}),
    details: input.details ?? {},
  };
}

export function writeRagTelemetry(
  input: RagTelemetryInput,
  path = defaultRagTelemetryPath(),
): RagTelemetryEvent {
  const event = buildRagTelemetryEvent(input);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}
