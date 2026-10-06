import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Zou1059OwnerContract } from "../adapters/zou-1059-authority.js";
import type { AuthorityEnvelopeRef, CapabilityCatalogEntry } from "../contracts/capability.js";
import { canonicalPayloadDigest } from "../fingerprint.js";

const SHADOW_EVIDENCE_PAYLOAD = "zcr-008-shadow-observer-evidence/v1";
const SHADOW_PRINCIPAL = "zcr-008-shadow-observer";
const SHADOW_REPOSITORY = "marlandoj/zouroboros";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ShadowBootstrap {
  readonly stateDir: string;
  readonly envelopeRef: AuthorityEnvelopeRef;
  readonly envelopePayload: string;
  readonly evidencePayload: string;
  readonly catalog: readonly CapabilityCatalogEntry[];
  readonly catalogDigest: string;
  readonly environment: {
    readonly runtime_root: string;
    readonly isolation_mode: string;
    readonly repository: string;
    readonly state_dir: string;
  };
  readonly sealKey: Uint8Array;
}

function sha256(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function deterministicEnvelopeId(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  let id = "";
  for (let index = 0; index < 26; index++) id += CROCKFORD[digest[index]! % 32];
  return `ae-${id}`;
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

/**
 * The observed operations and their truthful provider classifications. All three
 * ZCR-008 consumer events are writes in their host systems; they are classified
 * reconcilable_write because each host effect is externally visible and
 * verifiable (git commit, execution record, dispatch record) after the fact.
 */
export function shadowCatalogEntries(): CapabilityCatalogEntry[] {
  return [
    {
      operation: "autoloop.apply-candidate",
      resource_kind: "autoloop-target",
      credential_ref: "vault://zcr-shadow/observer",
      credential_class: "shadow-local",
      effect: "write",
      required_arguments: ["experiment"],
      optional_arguments: ["commit", "hypothesis_digest"],
      schema_digest: sha256("zcr.shadow.autoloop.apply-candidate/v1"),
      model_description: "Autoloop applies an experiment candidate commit to its target file",
    },
    {
      operation: "swarm.enqueue-execution",
      resource_kind: "swarm-campaign",
      credential_ref: "vault://zcr-shadow/observer",
      credential_class: "shadow-local",
      effect: "write",
      required_arguments: ["ticket"],
      optional_arguments: ["gate_decision", "stage"],
      schema_digest: sha256("zcr.shadow.swarm.enqueue-execution/v1"),
      model_description: "Swarm executor records a pipeline execution lifecycle event",
    },
    {
      operation: "factory.dispatch-ticket",
      resource_kind: "factory-ticket",
      credential_ref: "vault://zcr-shadow/observer",
      credential_class: "shadow-local",
      effect: "write",
      required_arguments: ["decision"],
      optional_arguments: ["score", "lane"],
      schema_digest: sha256("zcr.shadow.factory.dispatch-ticket/v1"),
      model_description: "Software Factory dispatcher routes an intake ticket",
    },
  ];
}

function buildEnvelope(input: {
  readonly envelopeId: string;
  readonly environment: ShadowBootstrap["environment"];
  readonly notBefore: string;
  readonly expiresAt: string;
}): Record<string, unknown> {
  const operations = shadowCatalogEntries().map((entry) => entry.operation).sort();
  return {
    contract_id: "zouroboros-authority-envelope/v1",
    schema_version: 1,
    envelope_id: input.envelopeId,
    principal: { kind: "service", id: SHADOW_PRINCIPAL },
    capabilities: [
      {
        capability: "autoloop.apply-candidate",
        resources: ["autoloop/*"],
        argument_constraints: {},
        credential_classes: ["shadow-local"],
        revoked_at: null,
      },
      {
        capability: "swarm.enqueue-execution",
        resources: ["swarm-campaigns/*"],
        argument_constraints: {},
        credential_classes: ["shadow-local"],
        revoked_at: null,
      },
      {
        capability: "factory.dispatch-ticket",
        resources: ["factory-tickets/*"],
        argument_constraints: {},
        credential_classes: ["shadow-local"],
        revoked_at: null,
      },
    ],
    validity: { not_before: input.notBefore, expires_at: input.expiresAt },
    environment: input.environment,
    approval_binding: {
      actor: "marlandoj",
      session_id: "zcr-008-shadow-window",
      run_id: "zcr-008-shadow-window",
      tool: "zcr-shadow-bootstrap",
      bound_arguments_sha256: sha256(JSON.stringify(operations)),
      lifetime: { kind: "session" },
      required_terminal_outcome: null,
    },
    global_rung_cap: "read-only",
    delegation: { parent_envelope_ref: null, depth: 0 },
    integration_refs: {
      permission_rung_ref: null,
      skillspector_finding_refs: ["skillspector:zcr-008-shadow-observer"],
      mcp_finding_refs: ["mcp-inject-scan:zcr-008-shadow-observer"],
      provenance_evidence_refs: ["provenance:zcr-008-shadow-bootstrap"],
    },
    enforcement_evidence: {
      kind: "ledger",
      evidence_ref: "zcr-shadow/evidence-v1",
      sha256: sha256(SHADOW_EVIDENCE_PAYLOAD),
    },
  };
}

/**
 * Creates or loads the durable shadow bootstrap under stateDir. Fails closed:
 * a generated or previously persisted envelope that the ZOU-1059 owner
 * contract rejects raises instead of degrading to an unauthorized runtime.
 */
export function ensureShadowBootstrap(input: {
  readonly stateDir: string;
  readonly owner: Zou1059OwnerContract;
  readonly now?: () => Date;
}): ShadowBootstrap {
  const stateDir = resolve(input.stateDir);
  if (!stateDir.startsWith("/")) throw new Error("shadow state dir must be absolute");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const envelopePath = join(stateDir, "envelope.json");
  const environment = {
    runtime_root: stateDir,
    isolation_mode: "read-only",
    repository: SHADOW_REPOSITORY,
    state_dir: stateDir,
  };

  if (!existsSync(envelopePath)) {
    const now = (input.now ?? (() => new Date()))();
    const notBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const envelopeId = deterministicEnvelopeId(`${SHADOW_PRINCIPAL}/${stateDir}/${notBefore}`);
    const candidate = JSON.stringify(buildEnvelope({ envelopeId, environment, notBefore, expiresAt }), null, 2);
    createPrivateFileOnce(envelopePath, candidate);
  }
  const envelopePayload = readFileSync(envelopePath, "utf8");

  const parsed = JSON.parse(envelopePayload) as { envelope_id: string; environment: ShadowBootstrap["environment"] };
  const validation = input.owner.validateEnvelope(JSON.parse(envelopePayload));
  if (!validation.ok) {
    throw new Error(`shadow bootstrap envelope rejected by ZOU-1059 owner contract: ${JSON.stringify(validation)}`);
  }

  const keyPath = join(stateDir, "seal.key");
  if (!existsSync(keyPath)) {
    createPrivateFileOnce(keyPath, randomBytes(32).toString("base64"));
  }
  chmodSync(keyPath, 0o600);
  const sealKey = Uint8Array.from(Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64"));
  if (sealKey.byteLength !== 32) throw new Error("shadow seal key must decode to 32 bytes");

  const catalog = shadowCatalogEntries();
  const catalogPath = join(stateDir, "catalog.json");
  const catalogPayload = JSON.stringify(catalog, null, 2);
  if (!existsSync(catalogPath)) createPrivateFileOnce(catalogPath, catalogPayload);
  if (readFileSync(catalogPath, "utf8") !== catalogPayload) throw new Error("shadow capability catalog drift detected");

  return {
    stateDir,
    envelopeRef: {
      owner: "evidence-substrate/ZOU-1059",
      envelope_id: parsed.envelope_id,
      schema_major: 1,
      content_digest: input.owner.sha256Hex(envelopePayload),
    },
    envelopePayload,
    evidencePayload: SHADOW_EVIDENCE_PAYLOAD,
    catalog,
    catalogDigest: canonicalPayloadDigest(catalog),
    environment: parsed.environment,
    sealKey,
  };
}
