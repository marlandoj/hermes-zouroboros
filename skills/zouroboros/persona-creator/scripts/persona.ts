#!/usr/bin/env bun
/**
 * persona-creator — generate a persona with the distribution's zouroboros-personas package and
 * register it as a Hermes personality in the hermes-zouroboros profile.
 *
 *   create   --name NAME --domain DOMAIN [--description TEXT] [--expertise a,b] [--rules "r1|r2"] [--output DIR] [--with-skill]
 *   validate SLUG [--output DIR]
 *   install  SLUG [--output DIR] [--force]   adds agent.personalities.<slug> to the profile config.yaml
 *   list     [--output DIR]
 *
 * Generated files go to $ZOUROBOROS_STATE_DIR/personas by default, never into the skill tree.
 * install never selects the personality; switch with /personality <slug> in a Hermes session.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { generatePersona } from "../../../../packages/personas/src/generators/persona.ts";
import type { PersonaConfig } from "../../../../packages/personas/src/types.ts";
import { paths } from "../../../../integration/profile.ts";

/** Hermes built-in personality names (hermes_cli/personality.py); overriding one needs --force. */
const HERMES_BUILTINS = new Set(["helpful", "concise", "technical", "creative", "teacher", "kawaii", "catgirl", "pirate", "shakespeare", "surfer", "noir", "uwu", "philosopher", "hype"]);
const NEUTRAL = new Set(["", "none", "default", "neutral"]);
const REQUIRED = (slug: string) => ["SOUL.md", join("IDENTITY", `${slug}.md`), "SAFETY.md", "PROMPT.md"];

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function personasDir(output?: string): string {
  if (output) return resolve(output);
  return join(process.env.ZOUROBOROS_STATE_DIR || join(paths().data, "state"), "personas");
}

export function validatePersona(dir: string, slug: string): { ok: boolean; missing: string[]; placeholders: string[] } {
  const base = join(dir, slug);
  const missing = REQUIRED(slug).filter((file) => !existsSync(join(base, file)));
  const placeholders = existsSync(join(base, "PROMPT.md"))
    ? [...new Set(readFileSync(join(base, "PROMPT.md"), "utf8").match(/\[[A-Z][A-Z0-9 _-]{2,}\]/g) ?? [])]
    : [];
  return { ok: missing.length === 0 && placeholders.length === 0, missing, placeholders };
}

/** Add agent.personalities.<slug> to the profile's config.yaml, preserving other settings and comments. */
export function installPersonality(dir: string, slug: string, force = false): { config: string; slug: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || NEUTRAL.has(slug)) throw new Error(`Invalid personality name: ${slug}`);
  if (HERMES_BUILTINS.has(slug) && !force) throw new Error(`${slug} is a Hermes built-in personality; use --force to override it`);
  const check = validatePersona(dir, slug);
  if (!check.ok) throw new Error(`Persona ${slug} is incomplete: ${[...check.missing.map((m) => `missing ${m}`), ...check.placeholders.map((p) => `unfilled ${p}`)].join(", ")}`);
  const config = join(paths().profile, "config.yaml");
  if (!existsSync(config)) throw new Error("Run init first. No distribution profile exists.");
  const document = parseDocument(readFileSync(config, "utf8"));
  if (document.hasIn(["agent", "personalities", slug]) && !force) throw new Error(`Personality ${slug} is already installed; use --force to replace it`);
  const identity = readFileSync(join(dir, slug, "IDENTITY", `${slug}.md`), "utf8");
  const description = identity.match(/^## Role\s*\n+(.+)$/m)?.[1]?.trim() ?? `${slug} persona`;
  const systemPrompt = [readFileSync(join(dir, slug, "PROMPT.md"), "utf8").trim(), readFileSync(join(dir, slug, "SAFETY.md"), "utf8").trim()].join("\n\n");
  document.setIn(["agent", "personalities", slug], { description, system_prompt: systemPrompt });
  writeFileSync(config, document.toString(), { mode: 0o600 });
  return { config, slug };
}

function installedPersonalities(): string[] {
  const config = join(paths().profile, "config.yaml");
  if (!existsSync(config)) return [];
  const value = parseDocument(readFileSync(config, "utf8")).toJS()?.agent?.personalities;
  return value && typeof value === "object" ? Object.keys(value) : [];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      name: { type: "string" }, domain: { type: "string" }, description: { type: "string" },
      expertise: { type: "string" }, rules: { type: "string" }, capabilities: { type: "string" },
      output: { type: "string" }, "with-skill": { type: "boolean", default: false }, force: { type: "boolean", default: false },
    },
  });
  const dir = personasDir(values.output);
  const list = (value: string | undefined, separator: string, fallback: string[]) =>
    value ? value.split(separator).map((item) => item.trim()).filter(Boolean) : fallback;

  if (command === "create") {
    if (!values.name || !values.domain) throw new Error("create requires --name and --domain");
    const slug = slugify(values.name);
    if (!slug) throw new Error("The name must contain letters or digits");
    if (existsSync(join(dir, slug)) && !values.force) throw new Error(`Persona ${slug} already exists in ${dir}; use --force to regenerate it`);
    const config: PersonaConfig = {
      name: values.name, slug, domain: values.domain,
      description: values.description ?? `${values.name} - ${values.domain} assistant`,
      expertise: list(values.expertise, ",", ["Analysis", "Recommendations", "Domain expertise"]),
      requiresApiKey: false,
      safetyRules: list(values.rules, "|", [
        "Always verify information before providing recommendations",
        "Include disclaimers for all advice",
        "Respect user privacy and data security",
      ]),
      capabilities: list(values.capabilities, ",", ["Data analysis", "Recommendations", "Research"]),
    };
    const results = await generatePersona(config, { outputDir: dir, skipSkill: !values["with-skill"] });
    console.log(JSON.stringify({ slug, dir: join(dir, slug), phases: results, next: `Review and edit the files, then: persona.ts install ${slug}` }, null, 2));
  } else if (command === "validate") {
    const slug = positionals[0];
    if (!slug) throw new Error("validate requires a persona slug");
    const result = validatePersona(dir, slug);
    console.log(JSON.stringify({ slug, ...result }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === "install") {
    const slug = positionals[0];
    if (!slug) throw new Error("install requires a persona slug");
    console.log(JSON.stringify({ ...installPersonality(dir, slug, values.force), next: `Start a new Hermes session and run /personality ${slug}` }, null, 2));
  } else if (command === "list") {
    const generated = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "Skills").map((e) => e.name) : [];
    console.log(JSON.stringify({ dir, generated, installed: installedPersonalities() }, null, 2));
  } else {
    console.log("persona-creator\n  create --name NAME --domain DOMAIN [--description TEXT] [--expertise a,b] [--rules \"r1|r2\"] [--capabilities a,b] [--output DIR] [--with-skill] [--force]\n  validate SLUG [--output DIR]\n  install SLUG [--output DIR] [--force]\n  list [--output DIR]");
    if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 2;
  }
}

if (import.meta.main) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
