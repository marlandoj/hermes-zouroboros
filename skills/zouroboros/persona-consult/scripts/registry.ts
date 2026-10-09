import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SpecialistInvocationRequest, SpecialistInvocationResponse, SpecialistModelIdentity, SpecialistRolePhase } from "../../../../packages/swarm/src/persona/specialist-consult.ts";
import { ask } from "../../../../integration/ask.ts";

/**
 * Generic template → specialist association registry and the Hermes personality directory.
 *
 * The registry maps a template reference (`id@version`) to specialist roles. Each role names a
 * persona; persona names resolve, by exact name, against the `agent.personalities` entries of
 * the Hermes profile (`$HERMES_HOME/config.yaml`). Hermes' built-in personalities are tone
 * overlays, not specialists, so they are never part of the directory.
 */
export const SKILL_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
export const EXAMPLE_REGISTRY = join(SKILL_DIR, "assets", "persona-associations.example.json");
export const REGISTRY_ENV = "PERSONA_CONSULT_REGISTRY";
export const REVIEWER_MODELS_ENV = "PERSONA_CONSULT_REVIEWER_MODELS";

export interface RegistryRole {
  roleId: string;
  persona: string;
  phases: SpecialistRolePhase[];
  required?: boolean;
  /** Selected only when this capability is declared. */
  whenCapability?: string;
  /** Selected only when every selector matches (e.g. engine=unity). */
  whenSelectors?: Record<string, string>;
  requiredScopes?: string[];
  invocationCap?: number;
}

export interface AssociationRegistry {
  schemaVersion: 1;
  associationVersion: string;
  capabilities: string[];
  templates: Record<string, { description?: string; roles: RegistryRole[] }>;
}

export interface SelectedRole {
  roleId: string;
  personaName: string;
  required: boolean;
  phases: SpecialistRolePhase[];
  requiredScopes?: string[];
  invocationCap?: number;
}

export interface ResolvedAssociation {
  key: string;
  associationVersion: string;
  associationSha256: string;
  selectedRoles: SelectedRole[];
  omittedRoles: { roleId: string; reason: string }[];
}

const PHASES = new Set(["advise", "review", "implement"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Registry path: explicit flag, then PERSONA_CONSULT_REGISTRY, then the profile config dir, then the bundled example. */
export function registryPath(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  if (explicit) return resolve(explicit);
  if (env[REGISTRY_ENV]) return resolve(env[REGISTRY_ENV]!);
  const configDir = env.ZOUROBOROS_CONFIG_DIR;
  if (configDir) {
    const profile = join(configDir, "persona-consult", "associations.json");
    if (existsSync(profile)) return profile;
  }
  return EXAMPLE_REGISTRY;
}

export function validateRegistry(raw: unknown): AssociationRegistry {
  const fail = (message: string): never => { throw new Error(`invalid association registry: ${message}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");
  const registry = raw as AssociationRegistry;
  if (registry.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (typeof registry.associationVersion !== "string" || !registry.associationVersion) fail("associationVersion is required");
  if (!Array.isArray(registry.capabilities)) fail("capabilities must be an array");
  if (!registry.templates || typeof registry.templates !== "object") fail("templates must be an object");
  for (const [key, template] of Object.entries(registry.templates)) {
    if (!/^[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/.test(key)) fail(`template key ${key} must be <id>@<semver> (for example web-app@1.0.0)`);
    if (!Array.isArray(template.roles) || template.roles.length === 0) fail(`${key} has no roles`);
    const ids = new Set<string>();
    for (const role of template.roles) {
      if (!role.roleId || ids.has(role.roleId)) fail(`${key} has a missing or duplicate roleId`);
      ids.add(role.roleId);
      if (typeof role.persona !== "string" || !role.persona.trim()) fail(`${key}/${role.roleId} needs a persona name`);
      if (!Array.isArray(role.phases) || role.phases.length === 0 || role.phases.some((phase) => !PHASES.has(phase))) fail(`${key}/${role.roleId} has invalid phases`);
      if (role.whenCapability && !registry.capabilities.includes(role.whenCapability)) fail(`${key}/${role.roleId} uses unknown capability ${role.whenCapability}`);
    }
  }
  return registry;
}

export function loadRegistry(path: string): AssociationRegistry {
  return validateRegistry(JSON.parse(readFileSync(path, "utf8")));
}

export function resolveAssociation(
  registry: AssociationRegistry,
  key: string,
  capabilities: string[],
  selectors: Record<string, string>,
): ResolvedAssociation {
  const template = registry.templates[key];
  if (!template) throw new Error(`unknown template ${key}; known: ${Object.keys(registry.templates).sort().join(", ")}`);
  for (const capability of capabilities) {
    if (!registry.capabilities.includes(capability)) throw new Error(`unknown capability ${capability}`);
  }
  const selectedRoles: SelectedRole[] = [];
  const omittedRoles: { roleId: string; reason: string }[] = [];
  for (const role of template.roles) {
    if (role.whenCapability && !capabilities.includes(role.whenCapability)) {
      omittedRoles.push({ roleId: role.roleId, reason: `capability ${role.whenCapability} not declared` });
      continue;
    }
    const mismatch = Object.entries(role.whenSelectors ?? {}).find(([dimension, value]) => selectors[dimension] !== value);
    if (mismatch) {
      omittedRoles.push({ roleId: role.roleId, reason: `selector ${mismatch[0]}=${mismatch[1]} not set` });
      continue;
    }
    selectedRoles.push({
      roleId: role.roleId, personaName: role.persona, required: role.required ?? false, phases: role.phases,
      requiredScopes: role.requiredScopes, invocationCap: role.invocationCap,
    });
  }
  return {
    key,
    associationVersion: registry.associationVersion,
    associationSha256: sha256(canonical({ associationVersion: registry.associationVersion, key, template })),
    selectedRoles,
    omittedRoles,
  };
}

export function hermesHome(env: Record<string, string | undefined> = process.env): string {
  return env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
}

export interface HermesPersonality { name: string; prompt: string; model: string | null }

/** User-defined personalities from the Hermes profile config (string or structured entries). */
export function hermesPersonalities(env: Record<string, string | undefined> = process.env): HermesPersonality[] {
  const path = join(hermesHome(env), "config.yaml");
  if (!existsSync(path)) return [];
  const config = parseYaml(readFileSync(path, "utf8")) as { agent?: { personalities?: Record<string, unknown> } } | null;
  const entries = config?.agent?.personalities;
  if (!entries || typeof entries !== "object") return [];
  const result: HermesPersonality[] = [];
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === "string") result.push({ name, prompt: value.trim(), model: null });
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const prompt = [record.system_prompt, record.prompt, record.description].find((item) => typeof item === "string" && item.trim()) as string | undefined;
      const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : null;
      result.push({ name, prompt: prompt?.trim() ?? "", model });
    }
  }
  return result.filter((entry) => entry.prompt);
}

export function personalityId(name: string): string {
  return `native:hermes-${sha256(name).slice(0, 16)}`;
}

/** The personalities as a native persona directory (the swarm package's `native-persona-directory/v1`). */
export function hermesDirectory(personalities: HermesPersonality[]) {
  return {
    schema: "native-persona-directory/v1",
    personas: personalities.map((entry) => ({
      id: personalityId(entry.name), name: entry.name, model: entry.model, scopes: ["files:read"], updated_at: null,
    })),
  };
}

/** Invoke one specialist: its personality text frames the request, the Hermes model layer answers. */
export function createHermesInvoker(personalities: HermesPersonality[], askImpl: typeof ask = ask) {
  const byId = new Map(personalities.map((entry) => [personalityId(entry.name), entry]));
  return async (request: SpecialistInvocationRequest): Promise<SpecialistInvocationResponse> => {
    const persona = byId.get(request.personaId);
    if (!persona) throw new Error(`personality ${request.personaId} is not in the Hermes profile`);
    const prompt = `${persona.prompt}\n\n---\n\n${request.input}`;
    const outcome = await askImpl({ prompt, model: request.modelName, timeoutSec: Math.ceil(request.timeoutMs / 1000) });
    if (!outcome.ok) throw new Error(`specialist call failed (${outcome.failure ?? "failed"})${outcome.detail ? `: ${outcome.detail}` : ""}`);
    return { output: outcome.output, modelName: outcome.model || request.modelName, costUsd: null };
  };
}

/** Reviewer pool from PERSONA_CONSULT_REVIEWER_MODELS: comma-separated `vendor=model` entries. No compiled defaults. */
export function reviewerPool(env: Record<string, string | undefined> = process.env): SpecialistModelIdentity[] {
  const raw = env[REVIEWER_MODELS_ENV]?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) throw new Error(`${REVIEWER_MODELS_ENV} entries must use vendor=model-id syntax`);
    return { vendor: entry.slice(0, separator).trim().toLowerCase(), modelName: entry.slice(separator + 1).trim() };
  });
}
