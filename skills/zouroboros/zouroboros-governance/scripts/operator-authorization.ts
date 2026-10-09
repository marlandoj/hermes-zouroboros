import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  authorizationMaterial,
  authorityRegistryPath,
  parseAuthorizationEvidence,
  type AuthorizationEvidence,
} from "./autonomy-authorization";
import { governanceDataDir } from "./governance-paths";

export type UnsignedAuthorization = Omit<AuthorizationEvidence, "signature">;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function atomicWrite(filePath: string, content: string, mode = 0o600): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { mode, flag: "wx" });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

function validatedEvidence(unsigned: UnsignedAuthorization, signature: string): AuthorizationEvidence {
  const evidence = { ...unsigned, signature };
  const parsed = parseAuthorizationEvidence(evidence);
  if (!parsed) throw new Error("authorization request is malformed or incomplete");
  const issuedAt = Date.parse(parsed.issued_at);
  const expiresAt = Date.parse(parsed.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error("authorization request timestamps are invalid");
  }
  if (expiresAt - issuedAt > 15 * 60 * 1000) {
    throw new Error("authorization request lifetime exceeds 15 minutes");
  }
  return parsed;
}

export function createAuthorizationRequest(options: {
  actor: string;
  action: string;
  resource: string;
  requestFingerprint: string;
  scope: string;
  approvingAuthority: string;
  ttlSeconds?: number;
  now?: Date;
}): UnsignedAuthorization {
  const ttlSeconds = options.ttlSeconds ?? 300;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    throw new Error("ttlSeconds must be an integer between 30 and 900");
  }
  const now = options.now ?? new Date();
  const request: UnsignedAuthorization = {
    schema_version: 1,
    actor: required(options.actor, "actor"),
    action: required(options.action, "action"),
    resource: required(options.resource, "resource"),
    request_fingerprint: required(options.requestFingerprint, "requestFingerprint"),
    scope: required(options.scope, "scope"),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    revoked: false,
    approving_authority: required(options.approvingAuthority, "approvingAuthority"),
    nonce: randomUUID(),
  };
  validatedEvidence(request, "unsigned-request");
  return request;
}

export function signAuthorizationRequest(
  request: UnsignedAuthorization,
  privateKeyPem: string,
): AuthorizationEvidence {
  const unsigned = validatedEvidence(request, "unsigned-request");
  const privateKey = privateKeyPem.trim();
  if (!privateKey) throw new Error("private key is empty");
  const signature = signPayload(null, Buffer.from(authorizationMaterial(unsigned)), privateKey).toString("base64");
  return validatedEvidence(request, signature);
}

export function enrollApprovalAuthority(options: {
  authority: string;
  publicKeyPem: string;
  registryPath?: string;
}): string {
  const authority = required(options.authority, "authority");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(authority)) throw new Error("authority identifier is invalid");
  const publicKey = createPublicKey(options.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("approval key must be Ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const registryPath = path.resolve(options.registryPath ?? authorityRegistryPath());
  let registry: Record<string, { algorithm: "ed25519"; public_key_pem: string; revoked: boolean }> = {};
  if (fs.existsSync(registryPath)) {
    const stat = fs.lstatSync(registryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("approval authority registry must be a regular, non-linked file");
    }
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  }
  registry[authority] = { algorithm: "ed25519", public_key_pem: publicKeyPem, revoked: false };
  atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registryPath;
}

function readUnsigned(filePath: string): UnsignedAuthorization {
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as UnsignedAuthorization & { signature?: unknown };
  if (value.signature !== undefined && value.signature !== "") throw new Error("request is already signed");
  const { signature: _signature, ...unsigned } = value;
  validatedEvidence(unsigned, "unsigned-request");
  return unsigned;
}

function usage(): never {
  throw new Error("usage: operator-authorization.ts generate|request|sign|enroll [options]");
}

/** True inside a Hermes agent session (tool subprocesses inherit these). */
export function inAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["HERMES_SESSION_ID", "HERMES_KANBAN_TASK", "HERMES_RPC_TOKEN"].some((name) => Boolean(env[name]));
}

/** Private keys never live on the agent host: refuse inside an agent session or next to a hermes-zouroboros profile. */
function assertOfflineOperatorDevice(): void {
  if (inAgentSession() || fs.existsSync(path.join(governanceDataDir(), "settings.json"))) {
    throw new Error("private-key operations are prohibited on the agent host; run this command on the offline operator device");
  }
}

/** Only the operator, outside an agent session, may add a trusted approval authority. */
function assertOperatorShell(): void {
  if (inAgentSession()) throw new Error("enrolling an approval authority is operator-only; run it from an operator shell, not an agent session");
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        actor: { type: "string" },
        action: { type: "string" },
        resource: { type: "string" },
        fingerprint: { type: "string" },
        scope: { type: "string" },
        authority: { type: "string" },
        ttl: { type: "string" },
        request: { type: "string" },
        output: { type: "string" },
        "private-key": { type: "string" },
        "public-key": { type: "string" },
        registry: { type: "string" },
        "output-dir": { type: "string" },
      },
    });
    const command = positionals[0];
    if (command === "generate") {
      assertOfflineOperatorDevice();
      const authority = required(values.authority, "authority");
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(authority)) throw new Error("authority identifier is invalid");
      const outputDir = path.resolve(required(values["output-dir"], "output-dir"));
      const privatePath = path.join(outputDir, `${authority}.private.pem`);
      const publicPath = path.join(outputDir, `${authority}.public.pem`);
      if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) throw new Error("operator key output already exists");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      atomicWrite(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      atomicWrite(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), 0o644);
      console.log(JSON.stringify({ authority, public_key: publicPath, private_key_retained_on_operator_device: true }));
    } else if (command === "request") {
      const output = path.resolve(required(values.output, "output"));
      const request = createAuthorizationRequest({
        actor: required(values.actor, "actor"),
        action: required(values.action, "action"),
        resource: required(values.resource, "resource"),
        requestFingerprint: required(values.fingerprint, "fingerprint"),
        scope: required(values.scope, "scope"),
        approvingAuthority: required(values.authority, "authority"),
        ttlSeconds: values.ttl ? Number(values.ttl) : undefined,
      });
      atomicWrite(output, `${JSON.stringify(request, null, 2)}\n`);
      console.log(output);
    } else if (command === "sign") {
      assertOfflineOperatorDevice();
      const output = path.resolve(required(values.output, "output"));
      const request = readUnsigned(required(values.request, "request"));
      const privateKey = fs.readFileSync(path.resolve(required(values["private-key"], "private-key")), "utf8");
      const evidence = signAuthorizationRequest(request, privateKey);
      atomicWrite(output, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(output);
    } else if (command === "enroll") {
      assertOperatorShell();
      const registryPath = enrollApprovalAuthority({
        authority: required(values.authority, "authority"),
        publicKeyPem: fs.readFileSync(path.resolve(required(values["public-key"], "public-key")), "utf8"),
        registryPath: values.registry,
      });
      console.log(registryPath);
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
