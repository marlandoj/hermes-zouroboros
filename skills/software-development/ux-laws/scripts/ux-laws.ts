#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

const SKILL_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const BLOCK_PATH = join(SKILL_DIR, "assets", "ux-principles.md");
const CHECKLIST_PATH = join(SKILL_DIR, "assets", "review-checklist.md");
const START = "<!-- ux-laws:start -->";
const END = "<!-- ux-laws:end -->";
const KNOWN_FILES = [
  "AGENTS.md",
  ".hermes.md",
  "HERMES.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".windsurfrules",
  "CONVENTIONS.md",
];

const HELP = `ux-laws: research-based UX principles for agents and reviewers

Usage:
  ux-laws.ts render [--format block|checklist|json]
  ux-laws.ts install --target <dir> [--file <name>] [--dry-run]
  ux-laws.ts status --target <dir>
  ux-laws.ts --help

Commands:
  render    Print the constraint block (default), the review checklist, or JSON.
  install   Insert or replace the marker-fenced block in <dir>/<file>. Default file: AGENTS.md.
            Idempotent: re-running replaces the fenced region. Creates the file if missing.
            <file> must be a relative path inside <dir>.
  status    Report which known instruction files under <dir> exist and whether they carry the block.

Known instruction files: ${KNOWN_FILES.join(", ")}
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function fenced(): string {
  return `${START}\n${readFileSync(BLOCK_PATH, "utf8").trimEnd()}\n${END}\n`;
}

export function parseRules(): { n: number; law: string; rule: string }[] {
  return readFileSync(BLOCK_PATH, "utf8")
    .split("\n")
    .map((l) => l.match(/^(\d+)\. ([^:]+): (.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ n: Number(m[1]), law: m[2], rule: m[3] }));
}

function render(): number {
  const format = arg("--format") ?? "block";
  if (format === "block") process.stdout.write(readFileSync(BLOCK_PATH, "utf8"));
  else if (format === "checklist") process.stdout.write(readFileSync(CHECKLIST_PATH, "utf8"));
  else if (format === "json") process.stdout.write(JSON.stringify(parseRules(), null, 2) + "\n");
  else {
    process.stderr.write(`unknown format: ${format}\n`);
    return 1;
  }
  return 0;
}

export function upsert(content: string): { next: string; action: "created" | "replaced" | "appended" | "unchanged" } {
  const block = fenced();
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s >= 0 && e > s) {
    const next = content.slice(0, s) + block.trimEnd() + content.slice(e + END.length);
    return { next, action: next === content ? "unchanged" : "replaced" };
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return { next: content + sep + block, action: content.length === 0 ? "created" : "appended" };
}

function install(): number {
  const target = arg("--target");
  if (!target) {
    process.stderr.write("install requires --target <dir>\n");
    return 1;
  }
  const file = arg("--file") ?? "AGENTS.md";
  if (isAbsolute(file) || normalize(file).split(/[\\/]/).includes("..")) {
    process.stderr.write(`--file must be a relative path inside --target: ${file}\n`);
    return 1;
  }
  const path = join(resolve(target), file);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { next, action } = upsert(existing);
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${action}: ${path} (dry run)\n`);
    return 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (action !== "unchanged") writeFileSync(path, next);
  process.stdout.write(`${action}: ${path}\n`);
  return 0;
}

function status(): number {
  const target = arg("--target");
  if (!target) {
    process.stderr.write("status requires --target <dir>\n");
    return 1;
  }
  const root = resolve(target);
  for (const f of KNOWN_FILES) {
    const path = join(root, f);
    if (!existsSync(path)) continue;
    const has = readFileSync(path, "utf8").includes(START);
    process.stdout.write(`${has ? "present" : "absent "}  ${f}\n`);
  }
  return 0;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const handlers: Record<string, () => number> = { render, install, status };
  const handler = handlers[cmd];
  if (!handler) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
  }
  process.exit(handler());
}
