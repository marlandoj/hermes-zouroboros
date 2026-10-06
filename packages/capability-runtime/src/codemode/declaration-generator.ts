import type { ModelVisibleCapability } from "../contracts/capability.js";
import type {
  ArgumentSchemaNode,
  CapabilitySchemaSource,
  FacadeEntry,
  FacadeGenerationInput,
  FacadeParameter,
  GeneratedFacade,
} from "./contracts.js";

const RESERVED_IDENTIFIERS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "let", "static", "await", "async",
  "implements", "interface", "package", "private", "protected", "public",
  "arguments", "eval", "constructor", "prototype", "__proto__", "toString",
  "valueOf", "hasOwnProperty",
]);

const MAX_SCHEMA_DEPTH = 4;
const MAX_DESCRIPTION_LENGTH = 300;
const SCALAR_FALLBACK = "string | number | boolean";

/** Neutralize hostile descriptions before embedding them in JSDoc comments. */
function sanitizeForComment(description: string): string {
  return description
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\*\//g, "*\\/")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
}

function baseIdentifier(operation: string): string {
  let identifier = operation.replace(/[^A-Za-z0-9_$]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  if (identifier.length === 0) identifier = "operation";
  if (/^[0-9]/.test(identifier)) identifier = `op_${identifier}`;
  if (RESERVED_IDENTIFIERS.has(identifier)) identifier = `${identifier}_op`;
  return identifier;
}

function uniqueIdentifier(operation: string, taken: Set<string>): string {
  const base = baseIdentifier(operation);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  const identifier = `${base}_${suffix}`;
  taken.add(identifier);
  return identifier;
}

interface RenderedType {
  readonly rendered: string;
  readonly degraded: boolean;
}

function renderSchemaType(node: ArgumentSchemaNode, depth: number, seen: Set<ArgumentSchemaNode>): RenderedType {
  if (depth > MAX_SCHEMA_DEPTH) return { rendered: "unknown", degraded: true };
  if (seen.has(node)) return { rendered: "unknown", degraded: true };
  if (node.$ref !== undefined) return { rendered: "unknown", degraded: true };
  if (node.enum !== undefined) {
    if (node.enum.length === 0 || node.enum.some((value) => !["string", "number", "boolean"].includes(typeof value))) {
      return { rendered: "unknown", degraded: true };
    }
    return {
      rendered: node.enum.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value))).join(" | "),
      degraded: false,
    };
  }
  if (node.type === "string" || node.type === "number" || node.type === "boolean") {
    return { rendered: node.type, degraded: false };
  }
  if (node.type === "integer") return { rendered: "number", degraded: false };
  if (node.type === "array") {
    if (node.items === undefined) return { rendered: "unknown", degraded: true };
    const nested = new Set(seen);
    nested.add(node);
    const items = renderSchemaType(node.items, depth + 1, nested);
    return { rendered: `readonly (${items.rendered})[]`, degraded: items.degraded };
  }
  if (node.type === "object") {
    if (node.properties === undefined) return { rendered: "unknown", degraded: true };
    const nested = new Set(seen);
    nested.add(node);
    const required = new Set(node.required ?? []);
    let degraded = false;
    const fields = Object.entries(node.properties).map(([key, child]) => {
      const rendered = renderSchemaType(child, depth + 1, nested);
      degraded = degraded || rendered.degraded;
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `${safeKey}${required.has(key) ? "" : "?"}: ${rendered.rendered}`;
    });
    return { rendered: `{ ${fields.join("; ")} }`, degraded };
  }
  return { rendered: "unknown", degraded: true };
}

function renderParameters(
  capability: ModelVisibleCapability,
  schemas: CapabilitySchemaSource | undefined,
): { readonly parameters: FacadeParameter[]; readonly requiresValidation: boolean } {
  let resolved = null;
  if (schemas !== undefined) {
    try {
      resolved = schemas.resolve(capability.operation, capability.schema_digest);
    } catch {
      resolved = null;
    }
    if (resolved !== null && resolved.schema_digest !== capability.schema_digest) resolved = null;
  }
  const parameters: FacadeParameter[] = [];
  let requiresValidation = false;
  const names = [
    ...capability.required_arguments.map((name) => ({ name, required: true })),
    ...capability.optional_arguments.map((name) => ({ name, required: false })),
  ];
  for (const { name, required } of names) {
    const node = resolved?.arguments[name];
    if (schemas !== undefined && resolved === null) {
      parameters.push({ name, rendered_type: "unknown", required, degraded_to_unknown: true });
      requiresValidation = true;
      continue;
    }
    if (node === undefined) {
      parameters.push({ name, rendered_type: SCALAR_FALLBACK, required, degraded_to_unknown: false });
      continue;
    }
    const rendered = renderSchemaType(node, 1, new Set());
    if (rendered.degraded) requiresValidation = true;
    parameters.push({
      name,
      rendered_type: rendered.rendered,
      required,
      degraded_to_unknown: rendered.degraded,
    });
  }
  return { parameters, requiresValidation };
}

function renderEntryDeclaration(entry: FacadeEntry): string {
  const lines: string[] = [];
  const comment = entry.description === undefined ? entry.operation : `${entry.operation} — ${entry.description}`;
  lines.push(`  /** ${sanitizeForComment(comment)} */`);
  const fields = entry.parameters.map((parameter) => {
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameter.name) ? parameter.name : JSON.stringify(parameter.name);
    return `${safeKey}${parameter.required ? "" : "?"}: ${parameter.rendered_type}`;
  });
  const argsType = fields.length === 0 ? "Record<never, never>" : `{ ${fields.join("; ")} }`;
  lines.push(`  ${entry.identifier}(args: ${argsType}): Promise<CapabilityCallResult>;`);
  return lines.join("\n");
}

/**
 * Generate a bounded typed facade from broker-projected capabilities only.
 * The input is the broker's model-visible projection, so anything not
 * introduced and currently authorized never appears in the declarations.
 */
export function generateFacade(input: FacadeGenerationInput): GeneratedFacade {
  const taken = new Set<string>();
  const entries: FacadeEntry[] = [];
  for (const capability of input.capabilities) {
    const identifier = uniqueIdentifier(capability.operation, taken);
    const { parameters, requiresValidation } = renderParameters(capability, input.schemas);
    entries.push({
      identifier,
      operation: capability.operation,
      handle_id: capability.handle_id,
      parameters,
      requires_validation: requiresValidation,
      ...(capability.description === undefined ? {} : { description: sanitizeForComment(capability.description) }),
    });
  }
  const declarations = [
    "type CapabilityCallResult =",
    "  | { ok: true; value: { output: unknown } }",
    "  | { ok: false; reason_codes: readonly string[] };",
    "",
    "interface Capabilities {",
    entries.map(renderEntryDeclaration).join("\n"),
    "}",
    "",
    "declare const capabilities: Capabilities;",
  ].join("\n");
  return {
    entries,
    declarations,
    source_capability_count: input.capabilities.length,
  };
}
