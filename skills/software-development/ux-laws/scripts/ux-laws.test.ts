import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fenced, parseRules, upsert } from "./ux-laws.ts";

const SCRIPT = join(import.meta.dir, "ux-laws.ts");
const SKILL_DIR = resolve(import.meta.dir, "..");
let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ux-laws-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(...args: string[]) {
  return spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
}

test("the block parses into twenty numbered rules", () => {
  const rules = parseRules();
  expect(rules.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(rules[0]!.law).toBe("Hick's Law");
  expect(rules[19]!.law).toBe("Chunking");
  const json = JSON.parse(run("render", "--format", "json").stdout);
  expect(json).toHaveLength(20);
});

test("checklist has one question per rule, in the same order", () => {
  const checklist = run("render", "--format", "checklist");
  expect(checklist.status).toBe(0);
  const items = checklist.stdout.split("\n").filter((l) => l.startsWith("- [ ] "));
  expect(items).toHaveLength(20);
  const firstWords = parseRules().map((r) => r.law.replace(/^Law of /, "").replace(/(?:'s)? (?:Law|Effect|Rule|Threshold|Principle|Razor)$/, ""));
  items.forEach((item, i) => expect(item).toContain(`${firstWords[i]}:`));
});

test("every principle in the reference names a source and an evidence class", () => {
  const ref = readFileSync(join(SKILL_DIR, "references/ux-laws.md"), "utf8");
  const sections = ref.split(/^## \d+\. /m).slice(1);
  expect(sections).toHaveLength(20);
  for (const section of sections) {
    expect(section).toContain("**Sources.**");
    expect(section).toMatch(/\*\*Evidence\.\*\* (Empirical|Observational|Heuristic)/);
  }
  expect(ref).toContain("## Tensions");
});

test("install creates, then replaces in place, and is idempotent", () => {
  expect(run("install", "--target", dir).stdout).toStartWith("created:");
  const path = join(dir, "AGENTS.md");
  const first = readFileSync(path, "utf8");
  expect(first).toBe(fenced());
  expect(run("install", "--target", dir).stdout).toStartWith("unchanged:");

  writeFileSync(path, "# Project\n\n<!-- ux-laws:start -->\nold\n<!-- ux-laws:end -->\n\nTail\n");
  expect(run("install", "--target", dir).stdout).toStartWith("replaced:");
  const replaced = readFileSync(path, "utf8");
  expect(replaced).toStartWith("# Project\n\n<!-- ux-laws:start -->");
  expect(replaced).toEndWith("<!-- ux-laws:end -->\n\nTail\n");
  expect(replaced.match(/ux-laws:start/g)).toHaveLength(1);
});

test("install appends to an existing file and honours --dry-run", () => {
  const path = join(dir, ".hermes.md");
  writeFileSync(path, "# Notes");
  expect(run("install", "--target", dir, "--file", ".hermes.md", "--dry-run").stdout).toStartWith("appended:");
  expect(readFileSync(path, "utf8")).toBe("# Notes");
  run("install", "--target", dir, "--file", ".hermes.md");
  expect(readFileSync(path, "utf8")).toBe(`# Notes\n\n${fenced()}`);
  expect(upsert("x\n").action).toBe("appended");
});

test("install refuses a file outside the target", () => {
  for (const file of ["../escape.md", "/tmp/escape.md"]) {
    const result = run("install", "--target", dir, "--file", file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("relative path inside --target");
  }
  expect(existsSync(join(dir, "..", "escape.md"))).toBe(false);
});

test("status reports which instruction files carry the block", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
  run("install", "--target", dir);
  const out = run("status", "--target", dir).stdout;
  expect(out).toContain("present  AGENTS.md");
  expect(out).toContain("absent   CLAUDE.md");
  expect(out).not.toContain(".cursorrules");
});

test("unknown commands and formats fail", () => {
  expect(run("bogus").status).toBe(1);
  expect(run("render", "--format", "xml").status).toBe(1);
  expect(run("install").status).toBe(1);
  expect(run("--help").stdout).toContain(".hermes.md");
});
