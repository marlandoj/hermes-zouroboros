import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalPayloadDigest } from "../fingerprint.js";
import {
  FACTORY_CONTROL_MODES,
  type FactoryControlActorV1,
  type FactoryControlConfigV1,
} from "./factory-control-contracts.js";

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TICKET = /^ZOU-[1-9][0-9]*$/;
const CONFIG_KEYS = [
  "schema_family",
  "schema_major",
  "config_version",
  "mode",
  "allowlisted_ticket_identifiers",
  "source_commit",
  "runtime_entrypoint",
  "runtime_digest",
  "expires_at",
  "max_applied_effects",
  "state_dir",
  "authority_envelope_path",
  "authority_envelope_digest",
  "authority_evidence_path",
  "authority_evidence_digest",
  "capability_catalog_path",
  "capability_catalog_digest",
  "trusted_keys_path",
  "trusted_keys_digest",
  "allowed_actors",
  "content_digest",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are not exact`);
  }
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/") || resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be sha256 hex`);
  return value;
}

function parseActors(value: unknown): readonly FactoryControlActorV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("allowed_actors must be non-empty");
  const actors = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("allowed actor must be an object");
    requireExactKeys(entry, ["actor_id", "session_ids"], "allowed actor");
    if (typeof entry.actor_id !== "string" || entry.actor_id.length === 0) throw new Error("allowed actor id is invalid");
    if (!Array.isArray(entry.session_ids) || entry.session_ids.length === 0 || entry.session_ids.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error("allowed actor sessions are invalid");
    }
    const sessions = entry.session_ids as string[];
    if (new Set(sessions).size !== sessions.length || sessions.join("\n") !== [...sessions].sort().join("\n")) {
      throw new Error("allowed actor sessions must be unique and sorted");
    }
    return { actor_id: entry.actor_id, session_ids: sessions };
  });
  const ids = actors.map((actor) => actor.actor_id);
  if (new Set(ids).size !== ids.length || ids.join("\n") !== [...ids].sort().join("\n")) {
    throw new Error("allowed actors must be unique and sorted");
  }
  return actors;
}

export function parseFactoryControlConfig(payload: string): FactoryControlConfigV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Factory control config is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Factory control config must be an object");
  requireExactKeys(parsed, CONFIG_KEYS, "Factory control config");
  if (parsed.schema_family !== "zcr.factory-control-config" || parsed.schema_major !== 1 || parsed.config_version !== 1) {
    throw new Error("Factory control config schema is unsupported");
  }
  if (!FACTORY_CONTROL_MODES.includes(parsed.mode as never)) throw new Error("Factory control mode is invalid");
  if (!Array.isArray(parsed.allowlisted_ticket_identifiers) || parsed.allowlisted_ticket_identifiers.length === 0) {
    throw new Error("Factory control allowlist must be non-empty");
  }
  const allowlist = parsed.allowlisted_ticket_identifiers as unknown[];
  if (allowlist.some((item) => typeof item !== "string" || !TICKET.test(item))) throw new Error("Factory control allowlist contains an invalid identifier");
  const ticketIds = allowlist as string[];
  if (new Set(ticketIds).size !== ticketIds.length || ticketIds.join("\n") !== [...ticketIds].sort().join("\n")) {
    throw new Error("Factory control allowlist must be unique and sorted");
  }
  if (typeof parsed.source_commit !== "string" || !COMMIT.test(parsed.source_commit)) throw new Error("Factory control source commit is invalid");
  if (typeof parsed.expires_at !== "string" || !Number.isFinite(Date.parse(parsed.expires_at))) throw new Error("Factory control expiry is invalid");
  if (parsed.max_applied_effects !== 1) throw new Error("Factory control effect budget must equal one");
  const config: FactoryControlConfigV1 = {
    schema_family: "zcr.factory-control-config",
    schema_major: 1,
    config_version: 1,
    mode: parsed.mode as FactoryControlConfigV1["mode"],
    allowlisted_ticket_identifiers: ticketIds,
    source_commit: parsed.source_commit,
    runtime_entrypoint: requireAbsolutePath(parsed.runtime_entrypoint, "runtime_entrypoint"),
    runtime_digest: requireHash(parsed.runtime_digest, "runtime_digest"),
    expires_at: parsed.expires_at,
    max_applied_effects: 1,
    state_dir: requireAbsolutePath(parsed.state_dir, "state_dir"),
    authority_envelope_path: requireAbsolutePath(parsed.authority_envelope_path, "authority_envelope_path"),
    authority_envelope_digest: requireHash(parsed.authority_envelope_digest, "authority_envelope_digest"),
    authority_evidence_path: requireAbsolutePath(parsed.authority_evidence_path, "authority_evidence_path"),
    authority_evidence_digest: requireHash(parsed.authority_evidence_digest, "authority_evidence_digest"),
    capability_catalog_path: requireAbsolutePath(parsed.capability_catalog_path, "capability_catalog_path"),
    capability_catalog_digest: requireHash(parsed.capability_catalog_digest, "capability_catalog_digest"),
    trusted_keys_path: requireAbsolutePath(parsed.trusted_keys_path, "trusted_keys_path"),
    trusted_keys_digest: requireHash(parsed.trusted_keys_digest, "trusted_keys_digest"),
    allowed_actors: parseActors(parsed.allowed_actors),
    content_digest: requireHash(parsed.content_digest, "content_digest"),
  };
  const { content_digest: _, ...unsigned } = config;
  if (canonicalPayloadDigest(unsigned) !== config.content_digest) throw new Error("Factory control config content digest mismatch");
  return config;
}

export function readFactoryControlConfig(path: string): FactoryControlConfigV1 {
  const normalized = requireAbsolutePath(path, "Factory control config path");
  const stat = lstatSync(normalized);
  if (!stat.isFile()) throw new Error("Factory control config path must be a regular file");
  return parseFactoryControlConfig(readFileSync(normalized, "utf8"));
}

export function resolveFactoryControlConfig(env: Readonly<Record<string, string | undefined>> = process.env): FactoryControlConfigV1 | null {
  const path = env.ZCR_FACTORY_CONTROL_CONFIG;
  return path === undefined || path.length === 0 ? null : readFactoryControlConfig(path);
}

export function readFactoryControlScope(path: string): {
  readonly mode: FactoryControlConfigV1["mode"] | null;
  readonly allowlisted_ticket_identifiers: readonly string[];
} {
  try {
    const parsed = JSON.parse(readFileSync(requireAbsolutePath(path, "Factory control config path"), "utf8")) as unknown;
    if (!isRecord(parsed)) return { mode: null, allowlisted_ticket_identifiers: [] };
    const mode = FACTORY_CONTROL_MODES.includes(parsed.mode as never)
      ? parsed.mode as FactoryControlConfigV1["mode"]
      : null;
    const allowlist = Array.isArray(parsed.allowlisted_ticket_identifiers)
      ? parsed.allowlisted_ticket_identifiers.filter((item): item is string => typeof item === "string" && TICKET.test(item))
      : [];
    return { mode, allowlisted_ticket_identifiers: [...new Set(allowlist)] };
  } catch {
    return { mode: null, allowlisted_ticket_identifiers: [] };
  }
}

function fileDigest(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Factory control bound path is not a regular file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyFactoryControlActivation(
  config: FactoryControlConfigV1,
  input: { readonly now: Date; readonly source_commit?: string },
): readonly string[] {
  const reasons: string[] = [];
  if (input.now.getTime() >= Date.parse(config.expires_at)) reasons.push("config_expired");
  if (input.source_commit === undefined || input.source_commit !== config.source_commit) reasons.push("source_commit_mismatch");
  const bindings = [
    [config.runtime_entrypoint, config.runtime_digest, "runtime_digest_mismatch"],
    [config.authority_envelope_path, config.authority_envelope_digest, "authority_envelope_digest_mismatch"],
    [config.authority_evidence_path, config.authority_evidence_digest, "authority_evidence_digest_mismatch"],
    [config.capability_catalog_path, config.capability_catalog_digest, "capability_catalog_digest_mismatch"],
    [config.trusted_keys_path, config.trusted_keys_digest, "trusted_keys_digest_mismatch"],
  ] as const;
  for (const [path, expected, reason] of bindings) {
    try {
      if (fileDigest(path) !== expected) reasons.push(reason);
    } catch {
      reasons.push(reason);
    }
  }
  return reasons;
}
