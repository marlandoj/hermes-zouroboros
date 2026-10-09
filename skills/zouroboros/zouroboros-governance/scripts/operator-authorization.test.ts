import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authorizationMaterial } from "./autonomy-authorization";
import {
  createAuthorizationRequest,
  enrollApprovalAuthority,
  signAuthorizationRequest,
} from "./operator-authorization";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("offline operator authorization", () => {
  test("signs a short-lived, request-bound authorization and enrolls only its public key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-authorization-"));
    roots.push(root);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const request = createAuthorizationRequest({
      actor: "codex-session",
      action: "filesystem.quarantine_delete",
      resource: "workspace/fixture",
      requestFingerprint: "fingerprint-123",
      scope: "single-resource",
      approvingAuthority: "operator-offline-v1",
      ttlSeconds: 300,
      now: new Date("2026-08-28T16:00:00.000Z"),
    });
    const signed = signAuthorizationRequest(
      request,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    expect(verify(
      null,
      Buffer.from(authorizationMaterial(signed)),
      publicKey,
      Buffer.from(signed.signature, "base64"),
    )).toBe(true);

    const registryPath = path.join(root, "approval-authorities.json");
    enrollApprovalAuthority({
      authority: "operator-offline-v1",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      registryPath,
    });
    const registry = fs.readFileSync(registryPath, "utf8");
    expect(registry).toContain("operator-offline-v1");
    expect(registry).not.toContain("PRIVATE KEY");
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
  });

  test("rejects approval lifetimes longer than fifteen minutes", () => {
    expect(() => createAuthorizationRequest({
      actor: "session",
      action: "action",
      resource: "resource",
      requestFingerprint: "fingerprint",
      scope: "scope",
      approvingAuthority: "operator-v1",
      ttlSeconds: 901,
    })).toThrow("between 30 and 900");
  });
});
