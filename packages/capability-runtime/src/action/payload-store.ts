import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SealedActionPayloadStore {
  put(canonicalPayload: string): Promise<string>;
  get(ciphertextRef: string): Promise<string | null>;
}

interface SealedFile {
  readonly version: 1;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export class FileSealedActionPayloadStore implements SealedActionPayloadStore {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(input: { readonly directory: string; readonly key: Uint8Array }) {
    if (!input.directory.startsWith("/")) throw new Error("sealed payload directory must be absolute");
    if (input.key.byteLength !== 32) throw new Error("sealed payload key must be 32 bytes");
    this.directory = resolve(input.directory);
    this.key = Buffer.from(input.key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  async put(canonicalPayload: string): Promise<string> {
    const digest = createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
    const path = join(this.directory, `${digest}.sealed.json`);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`zcr.action-payload/v1/${digest}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(canonicalPayload, "utf8"), cipher.final()]);
    const sealed: SealedFile = {
      version: 1,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const tempPath = join(this.directory, `.${digest}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tempPath, JSON.stringify(sealed), { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    try {
      try {
        linkSync(tempPath, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existing = this.readCanonical(digest, path);
        if (existing === null) throw new Error("existing sealed action payload failed validation");
        if (existing !== canonicalPayload) throw new Error("existing sealed action payload conflicts with canonical payload");
      }
    } finally {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    chmodSync(path, 0o600);
    return `sealed-action:v1:${digest}`;
  }

  async get(ciphertextRef: string): Promise<string | null> {
    const match = /^sealed-action:v1:([a-f0-9]{64})$/.exec(ciphertextRef);
    if (match === null) return null;
    const digest = match[1]!;
    const path = join(this.directory, `${digest}.sealed.json`);
    if (!existsSync(path)) return null;
    return this.readCanonical(digest, path);
  }

  private readCanonical(digest: string, path: string): string | null {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
      const sealed = JSON.parse(readFileSync(path, "utf8")) as Partial<SealedFile>;
      if (
        sealed.version !== 1
        || typeof sealed.nonce !== "string"
        || typeof sealed.tag !== "string"
        || typeof sealed.ciphertext !== "string"
        || !/^[A-Za-z0-9_-]+$/.test(sealed.nonce)
        || !/^[A-Za-z0-9_-]+$/.test(sealed.tag)
        || (sealed.ciphertext.length > 0 && !/^[A-Za-z0-9_-]+$/.test(sealed.ciphertext))
      ) return null;
      const nonce = Buffer.from(sealed.nonce, "base64url");
      const tag = Buffer.from(sealed.tag, "base64url");
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from(`zcr.action-payload/v1/${digest}`, "utf8"));
      decipher.setAuthTag(tag);
      const canonical = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return createHash("sha256").update(canonical, "utf8").digest("hex") === digest ? canonical : null;
    } catch {
      return null;
    }
  }
}
