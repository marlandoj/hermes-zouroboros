import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseVerifier, excludeAuthor, normalizeModelId, sameModel } from "./independence.ts";

test("model ids match across provider schemes and basenames; empty ids never match", () => {
  expect(normalizeModelId(" OpenRouter:Vendor/Model-X ")).toBe("vendor/model-x");
  expect(sameModel("Model-X", "hf:vendor/model-x")).toBe(true);
  expect(sameModel("vendor/model-x", "other/model-y")).toBe(false);
  expect(sameModel("", "")).toBe(false);
  expect(sameModel(undefined, "model-x")).toBe(false);
});

test("the author is excluded from a panel and never verifies its own deliverable", () => {
  expect(excludeAuthor(["a/model-x", "b/model-y"], "model-x")).toEqual(["b/model-y"]);
  expect(excludeAuthor(["a", "b"])).toEqual(["a", "b"]);
  expect(chooseVerifier("vision-1", "author-1")).toEqual({ ok: true, model: "vision-1", substituted: false });
  expect(chooseVerifier("vision-1", "openai:vision-1", ["vision-1", "vision-2"])).toEqual({ ok: true, model: "vision-2", substituted: true });
  const refused = chooseVerifier("vision-1", "vision-1", ["vision-1"]);
  expect(refused.ok).toBe(false);
});

test("station disabled is a clean no-op, and verify without a key fails before any network call", () => {
  const root = mkdtempSync(join(tmpdir(), "visual-verifier-"));
  try {
    const env = { PATH: process.env.PATH!, HOME: root, HERMES_ZOUROBOROS_HOME: join(root, "data") };
    const station = Bun.spawnSync([process.execPath, join(import.meta.dir, "station.ts"), "--screenshot", join(root, "x.png"), "--criteria", "c", "--label", "l"],
      { env: { ...env, VISUAL_VERIFIER: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(station.exitCode).toBe(0);
    writeFileSync(join(root, "x.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const verify = Bun.spawnSync([process.execPath, join(import.meta.dir, "verify.ts"), "--screenshot", join(root, "x.png"), "--criteria", "c", "--label", "l"],
      { env, stdout: "pipe", stderr: "pipe" });
    expect(verify.exitCode).toBe(1);
    expect(`${verify.stdout}${verify.stderr}`).toMatch(/API_KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
