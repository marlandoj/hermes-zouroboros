import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consultSpecialists } from "../../../../packages/swarm/src/persona/specialist-consult.ts";
import {
  createHermesInvoker, EXAMPLE_REGISTRY, hermesDirectory, hermesPersonalities, loadRegistry, personalityId,
  registryPath, resolveAssociation, reviewerPool, validateRegistry,
} from "./registry.ts";

const script = join(import.meta.dir, "persona-consult.ts");
let root = "";
let env: Record<string, string> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persona-consult-"));
  mkdirSync(join(root, "hermes"));
  writeFileSync(join(root, "hermes", "config.yaml"), [
    "agent:",
    "  personalities:",
    "    Frontend Developer:",
    "      system_prompt: You are a senior frontend engineer.",
    "      model: openai/gpt-test",
    "    Mobile App Builder: You build native mobile apps.",
    "    Empty: ''",
    "",
  ].join("\n"));
  writeFileSync(join(root, "task.md"), "Build a settings page.\n");
  env = { PATH: process.env.PATH!, HOME: join(root, "home"), HERMES_HOME: join(root, "hermes") };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function cli(args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, script, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("the bundled example registry is valid and mobile is opt-in", () => {
  const registry = loadRegistry(EXAMPLE_REGISTRY);
  const plain = resolveAssociation(registry, "web-app@1.0.0", [], {});
  expect(plain.selectedRoles.map((role) => role.roleId)).toEqual(["frontend", "backend"]);
  expect(plain.omittedRoles.map((role) => role.roleId)).toEqual(["mobile", "accessibility", "security"]);
  const mobile = resolveAssociation(registry, "web-app@1.0.0", ["mobile"], {});
  expect(mobile.selectedRoles.map((role) => role.personaName)).toContain("Mobile App Builder");
  expect(mobile.associationSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(resolveAssociation(registry, "game@1.0.0", [], { engine: "godot" }).selectedRoles.map((role) => role.roleId)).toEqual(["design", "godot"]);
  expect(() => resolveAssociation(registry, "nope@1.0.0", [], {})).toThrow("unknown template");
  expect(() => resolveAssociation(registry, "web-app@1.0.0", ["telepathy"], {})).toThrow("unknown capability");
  expect(() => validateRegistry({ ...registry, templates: { "x@1.0.0": { roles: [{ roleId: "a", persona: "A", phases: ["deploy"] }] } } })).toThrow("invalid phases");
});

test("registry path: flag, env, profile config dir, then the bundled example", () => {
  expect(registryPath(undefined, {})).toBe(EXAMPLE_REGISTRY);
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "persona-consult"), { recursive: true });
  writeFileSync(join(configDir, "persona-consult", "associations.json"), "{}");
  expect(registryPath(undefined, { ZOUROBOROS_CONFIG_DIR: configDir })).toBe(join(configDir, "persona-consult", "associations.json"));
  expect(registryPath(undefined, { PERSONA_CONSULT_REGISTRY: "/x/r.json", ZOUROBOROS_CONFIG_DIR: configDir })).toBe("/x/r.json");
  expect(registryPath("/y/r.json", { PERSONA_CONSULT_REGISTRY: "/x/r.json" })).toBe("/y/r.json");
});

test("Hermes personalities form a native directory; built-ins and empty prompts are excluded", () => {
  const personalities = hermesPersonalities(env);
  expect(personalities.map((entry) => entry.name)).toEqual(["Frontend Developer", "Mobile App Builder"]);
  expect(personalities[0]!.model).toBe("openai/gpt-test");
  const directory = hermesDirectory(personalities);
  expect(directory.schema).toBe("native-persona-directory/v1");
  expect(directory.personas[0]!.id).toMatch(/^native:hermes-[0-9a-f]{16}$/);
  expect(hermesPersonalities({ HERMES_HOME: join(root, "missing") })).toEqual([]);
});

test("reviewer pool comes only from configuration", () => {
  expect(reviewerPool({})).toEqual([]);
  expect(reviewerPool({ PERSONA_CONSULT_REVIEWER_MODELS: "Moonshot=kimi-x, anthropic=claude-y" })).toEqual([
    { vendor: "moonshot", modelName: "kimi-x" }, { vendor: "anthropic", modelName: "claude-y" },
  ]);
  expect(() => reviewerPool({ PERSONA_CONSULT_REVIEWER_MODELS: "nomodel" })).toThrow("vendor=model-id");
});

test("enforce advice invokes the personality through the injected model layer", async () => {
  const personalities = hermesPersonalities(env);
  const prompts: string[] = [];
  const invoke = createHermesInvoker(personalities, async (request) => {
    prompts.push(request.prompt);
    return { ok: true, output: "Use a form with inline validation.", exitCode: 0, ms: 1, model: request.model ?? "" };
  });
  const association = resolveAssociation(loadRegistry(EXAMPLE_REGISTRY), "web-app@1.0.0", [], {});
  const result = await consultSpecialists({
    mode: "enforce", phase: "advise", taskId: "t", task: "Build a settings page.",
    listPersonas: async () => hermesDirectory(personalities), invokePersona: invoke,
    assignments: association.selectedRoles.map((role) => ({ ...role })),
  });
  expect(result.ok).toBe(true);
  const statuses = Object.fromEntries(result.evidence.map((item) => [item.roleId, item.status]));
  expect(statuses).toEqual({ frontend: "invoked", backend: "omitted" });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.startsWith("You are a senior frontend engineer.")).toBe(true);
  await expect(invoke({ input: "x", modelName: "m", personaId: personalityId("Nobody"), timeoutMs: 1000 })).rejects.toThrow("not in the Hermes profile");
});

test("CLI: help and template listing are side-effect free; shadow advice makes no model call", () => {
  expect(cli(["--help"]).code).toBe(0);
  const list = cli(["--list-templates"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("web-app@1.0.0");
  const shadow = cli(["--template", "web-app@1.0.0", "--capability", "mobile", "--phase", "advise", "--mode", "shadow", "--task-file", join(root, "task.md")]);
  expect(shadow.code).toBe(0);
  const payload = JSON.parse(shadow.stdout);
  expect(payload.result.evidence.map((item: { roleId: string; status: string }) => `${item.roleId}:${item.status}`).sort())
    .toEqual(["backend:omitted", "frontend:would_invoke", "mobile:would_invoke"]);
  const review = cli(["--template", "web-app@1.0.0", "--phase", "review", "--mode", "shadow", "--task-file", join(root, "task.md"),
    "--implementation-file", join(root, "task.md"), "--implementer-model", "openai/gpt-test"]);
  // No reviewer pool is configured: shadow records the required reviewer as blocked, with the reason.
  const reviewEvidence = JSON.parse(review.stdout).result.evidence;
  expect(reviewEvidence.find((item: { roleId: string }) => item.roleId === "frontend")).toMatchObject({ status: "blocked" });
  expect(JSON.stringify(reviewEvidence)).toContain("no specialist reviewer model satisfies");
  const missing = cli(["--template", "web-app@1.0.0", "--phase", "advise", "--mode", "shadow"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("--task or --task-file is required");
});
