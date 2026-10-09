#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import {
  consultSpecialists,
  renderSpecialistOutputs,
  resolveSpecialistConsultMode,
  type SpecialistConsultPhase,
  type SpecialistModelIdentity,
} from "../../../../packages/swarm/src/persona/specialist-consult.ts";
import {
  createHermesInvoker,
  hermesDirectory,
  hermesPersonalities,
  loadRegistry,
  registryPath,
  resolveAssociation,
  reviewerPool,
} from "./registry.ts";

type SelectorDimension = string;

interface CliOptions {
  template: string;
  capabilities: string[];
  selectors: Partial<Record<SelectorDimension, string>>;
  phase: SpecialistConsultPhase;
  mode: "off" | "shadow" | "enforce";
  taskId: string;
  task: string;
  implementationOutput?: string;
  modelName?: string;
  implementerModelName?: string;
  implementerVendor?: string;
  reviewerModels: SpecialistModelIdentity[];
  outputPath?: string;
  registry?: string;
}

function usage(): string {
  return [
    "Usage: bun persona-consult.ts --template <id@version> --phase <advise|review> --mode <off|shadow|enforce> [options]",
    "",
    "Options:",
    "  --capability <id>          Repeatable or comma-separated capability",
    "  --selector <key=value>     Repeatable selector such as engine=unity",
    "  --task <text>              Task text",
    "  --task-file <path>         Read task text from an absolute path",
    "  --implementation-file <p> Read implementation result for review",
    "  --task-id <id>             Evidence task identifier",
    "  --model <model-id>         Adviser model override",
    "  --implementer-model <id>   Actual implementation model; required for enforce review",
    "  --implementer-vendor <id>  Explicit vendor when the implementer model is not recognized",
    "  --reviewer-model <v=id>    Repeatable reviewer candidate; defaults to the governed pool",
    "  --output <path>            Write JSON evidence to an absolute path",
    "  --registry <path>          Association registry (default: PERSONA_CONSULT_REGISTRY,",
    "                             then $ZOUROBOROS_CONFIG_DIR/persona-consult/associations.json,",
    "                             then the bundled example registry)",
    "  --list-templates           Print the registry's template references and exit",
    "",
    "Specialist personas are the Hermes profile's agent.personalities entries, matched by exact name.",
    "Reviewer candidates come from --reviewer-model or PERSONA_CONSULT_REVIEWER_MODELS (vendor=model, comma-separated).",
  ].join("\n");
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  let template = "";
  let phase: SpecialistConsultPhase | "" = "";
  let modeValue: string | undefined;
  let task = "";
  let taskId = "direct-chat-consult";
  let implementationOutput: string | undefined;
  let modelName: string | undefined;
  let implementerModelName: string | undefined;
  let implementerVendor: string | undefined;
  let outputPath: string | undefined;
  let registry: string | undefined;
  const reviewerModels: SpecialistModelIdentity[] = [];
  const capabilities: string[] = [];
  const selectors: Partial<Record<SelectorDimension, string>> = {};

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--template") template = requiredValue(args, i++, flag);
    else if (flag === "--phase") phase = requiredValue(args, i++, flag) as SpecialistConsultPhase;
    else if (flag === "--mode") modeValue = requiredValue(args, i++, flag);
    else if (flag === "--capability") capabilities.push(...requiredValue(args, i++, flag).split(",").filter(Boolean));
    else if (flag === "--selector") {
      const [dimension, value, extra] = requiredValue(args, i++, flag).split("=");
      if (!dimension || !value || extra !== undefined) throw new Error("--selector must use key=value syntax");
      selectors[dimension as SelectorDimension] = value;
    } else if (flag === "--task") task = requiredValue(args, i++, flag);
    else if (flag === "--task-file") task = readFileSync(requiredValue(args, i++, flag), "utf8");
    else if (flag === "--implementation-file") implementationOutput = readFileSync(requiredValue(args, i++, flag), "utf8");
    else if (flag === "--task-id") taskId = requiredValue(args, i++, flag);
    else if (flag === "--model") modelName = requiredValue(args, i++, flag);
    else if (flag === "--implementer-model") implementerModelName = requiredValue(args, i++, flag);
    else if (flag === "--implementer-vendor") implementerVendor = requiredValue(args, i++, flag);
    else if (flag === "--reviewer-model") {
      const raw = requiredValue(args, i++, flag);
      const separator = raw.indexOf("=");
      if (separator < 1 || separator === raw.length - 1) throw new Error("--reviewer-model must use vendor=model-id syntax");
      reviewerModels.push({ vendor: raw.slice(0, separator), modelName: raw.slice(separator + 1) });
    }
    else if (flag === "--output") outputPath = requiredValue(args, i++, flag);
    else if (flag === "--registry") registry = requiredValue(args, i++, flag);
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!template) throw new Error("--template is required");
  if (phase !== "advise" && phase !== "review") throw new Error("--phase must be advise or review");
  const mode = resolveSpecialistConsultMode(modeValue);
  if (!task.trim()) throw new Error("--task or --task-file is required");
  if (phase === "review" && !implementationOutput?.trim()) {
    throw new Error("--implementation-file is required for review");
  }
  if (mode === "enforce" && phase === "advise" && !modelName) {
    throw new Error("--model is required for enforce advice");
  }
  if (mode === "enforce" && phase === "review" && !implementerModelName) {
    throw new Error("--implementer-model is required for enforce review");
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error("duplicate capabilities are not allowed");
  return {
    template, capabilities, selectors, phase, mode, taskId, task, implementationOutput,
    modelName, implementerModelName, implementerVendor, reviewerModels, outputPath, registry,
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--list-templates")) {
    const index = argv.indexOf("--registry");
    const registry = loadRegistry(registryPath(index >= 0 ? argv[index + 1] : undefined));
    for (const [key, template] of Object.entries(registry.templates).sort()) console.log(`${key}\t${template.description ?? ""}`);
    return;
  }
  const options = parseArgs(argv);
  const registry = loadRegistry(registryPath(options.registry));
  const association = resolveAssociation(
    registry,
    options.template,
    options.capabilities,
    options.selectors as Record<string, string>,
  );
  const personalities = hermesPersonalities();
  const pool = options.reviewerModels.length > 0 ? options.reviewerModels : reviewerPool();
  const result = await consultSpecialists({
    listPersonas: async () => hermesDirectory(personalities),
    invokePersona: createHermesInvoker(personalities),
    mode: options.mode,
    phase: options.phase,
    taskId: options.taskId,
    task: options.task,
    implementationOutput: options.implementationOutput,
    modelName: options.modelName,
    implementerModelName: options.implementerModelName,
    implementerVendor: options.implementerVendor,
    reviewerPolicy: { candidates: pool },
    assignments: association.selectedRoles.map((role) => ({
      roleId: role.roleId,
      personaName: role.personaName,
      required: role.required,
      phases: role.phases,
      requiredScopes: role.requiredScopes,
      invocationCap: role.invocationCap,
    })),
  });
  const payload = {
    templateReference: association.key,
    associationVersion: association.associationVersion,
    associationSha256: association.associationSha256,
    omittedRoles: association.omittedRoles,
    result,
    renderedOutput: renderSpecialistOutputs(result),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.outputPath) writeFileSync(options.outputPath, serialized);
  console.log(serialized.trimEnd());
  if (!result.ok) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
