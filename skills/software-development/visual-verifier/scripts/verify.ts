#!/usr/bin/env bun
/**
 * Visual Verifier — independent verifier.
 *
 * Reads a screenshot IMAGE with a vision-capable model and compares it against seed acceptance
 * criteria, project DESIGN.md tokens and, optionally, a prior screenshot. The verifier model is
 * never the author model (see independence.ts).
 *
 * hermes-zouroboros: the distribution's ask-governor is text-only, so this script keeps a direct
 * OpenAI-compatible chat-completions call for the image. Endpoint, model and key come from the
 * Hermes profile environment (VISUAL_VERIFIER_* first, then the profile's OPENAI_* values); the
 * script never reads a key from a file and fails cleanly without one.
 *
 * Usage:
 *   bun verify.ts --screenshot shot.png --criteria "uses the project palette" \
 *     --design-md path/to/DESIGN.md --author "provider:author-model" --label "my-route"
 */
import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseVerifier } from "./independence.ts";

export const DEFAULT_MODEL = "gpt-4o";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** Chat-completions URL from a base URL; a full .../chat/completions URL is used as given. */
export function completionsUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.VISUAL_VERIFIER_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function usage(code: number): never {
  console.log(`Usage: bun verify.ts --screenshot <png> --criteria "<text>" [options]

Options:
  --screenshot        Path to screenshot PNG (required)
  --criteria          Acceptance criteria text (required)
  --design-md         Path to project DESIGN.md (optional, adds token reference)
  --prior-screenshot  Path to a prior screenshot for regression comparison (optional)
  --author            Author model id; the verifier is never this model (optional)
  --label             Task label for logging (default "unlabeled")
  --model             Verifier model (default: VISUAL_VERIFIER_MODEL or ${DEFAULT_MODEL})
  --help              Show this help

Environment (from the Hermes profile):
  VISUAL_VERIFIER_API_KEY | OPENAI_API_KEY     key for the vision endpoint (required)
  VISUAL_VERIFIER_BASE_URL | OPENAI_BASE_URL   OpenAI-compatible base URL (default ${DEFAULT_BASE_URL})
  VISUAL_VERIFIER_MODEL                        vision model id
  VISUAL_VERIFIER_AUTHOR_MODEL                 author model when --author is not given
  VISUAL_VERIFIER_FALLBACK_MODELS              comma-separated alternates if the model is the author
  VISUAL_VERIFIER_TIMEOUT_MS                   request timeout (default 90000)

Output (JSON on stdout, exit 0):
  { "verdict": "match"|"mismatch", "confidence": 0-1, "diffs": [...], "summary": "...", "model": "..." }
Exit 1 on any error (missing input or key, author conflict, model failure, unparseable reply).
`);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`verify: ${message}`);
  process.exit(1);
}

/** Base64 image; files over 15 MB are re-encoded as JPEG in a private temp dir when ffmpeg exists. */
function loadImage(path: string): { mime: string; base64: string } {
  const sizeMb = statSync(path).size / (1024 * 1024);
  if (sizeMb <= 15) return { mime: "image/png", base64: readFileSync(path).toString("base64") };
  const dir = mkdtempSync(join(tmpdir(), "visual-verifier-"));
  try {
    const out = join(dir, "compressed.jpg");
    const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path, "-q:v", "5", out], { stdio: "ignore" });
    if (result.status !== 0 || !existsSync(out)) fail(`screenshot is ${sizeMb.toFixed(1)} MB and could not be compressed (ffmpeg missing or failed)`);
    return { mime: "image/jpeg", base64: readFileSync(out).toString("base64") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function designTokens(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  const md = readFileSync(path, "utf-8");
  // Heuristic: keep the token/color lines.
  const lines = md.split("\n").filter((line) => /#[0-9a-fA-F]{3,8}|oklch|color|token|--|palette/i.test(line)).slice(0, 50).join("\n");
  return lines || md.slice(0, 2000);
}

async function main() {
  const { values } = parseArgs({
    options: {
      screenshot: { type: "string" },
      criteria: { type: "string" },
      "design-md": { type: "string" },
      "prior-screenshot": { type: "string" },
      author: { type: "string" },
      label: { type: "string", default: "unlabeled" },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (!values.screenshot || !values.criteria) usage(1);

  // Verifier ≠ author: checked before anything else, so a conflict never reaches a model.
  const requested = values.model || process.env.VISUAL_VERIFIER_MODEL || DEFAULT_MODEL;
  const author = values.author || process.env.VISUAL_VERIFIER_AUTHOR_MODEL || "";
  const choice = chooseVerifier(requested, author, list(process.env.VISUAL_VERIFIER_FALLBACK_MODELS));
  if (!choice.ok) fail(choice.reason);
  if (choice.substituted) console.error(`verify: '${requested}' is the author model; verifying with '${choice.model}' instead`);

  if (!existsSync(values.screenshot)) fail(`screenshot not found: ${values.screenshot}`);
  const apiKey = process.env.VISUAL_VERIFIER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) fail("no vision API key: set VISUAL_VERIFIER_API_KEY or OPENAI_API_KEY in the Hermes profile environment");

  const image = loadImage(values.screenshot);
  const prior = values["prior-screenshot"] && existsSync(values["prior-screenshot"]) ? loadImage(values["prior-screenshot"]) : undefined;
  const tokens = designTokens(values["design-md"]);

  const promptText = `You are an independent visual verifier. You must NOT rubber-stamp the work — your job is to catch rendered-output failures that text-based checks miss.

TASK LABEL: ${values.label}

ACCEPTANCE CRITERIA (the screenshot must satisfy these):
${values.criteria}

${tokens ? `PROJECT DESIGN TOKENS (from DESIGN.md — the screenshot should use these, not defaults):\n${tokens}\n` : ""}${prior ? "\nThe SECOND image is a PRIOR screenshot of the same page. If the current (first) screenshot has regressed from it, flag that.\n" : ""}
Instructions:
1. Look at the screenshot carefully.
2. Check each acceptance criterion against what you actually see rendered.
3. If DESIGN tokens are provided, verify the rendered colors/layout match the project palette, NOT default Tailwind/CSS tokens.
4. Return ONLY a JSON object with this exact shape:
{
  "verdict": "match" | "mismatch",
  "confidence": <number 0.0 to 1.0>,
  "diffs": [
    { "issue": "<what's wrong>", "criterion": "<which AC or token is violated>", "severity": "high" | "medium" | "low" }
  ],
  "summary": "<one-line summary>"
}

If everything looks correct, return verdict "match" with empty diffs.
If something is wrong, return verdict "mismatch" with the diffs array populated.
Do not include any text outside the JSON.`;

  const content: unknown[] = [
    { type: "text", text: promptText },
    { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: "high" } },
  ];
  if (prior) content.push({ type: "image_url", image_url: { url: `data:${prior.mime};base64,${prior.base64}`, detail: "low" } });

  const timeoutMs = Number(process.env.VISUAL_VERIFIER_TIMEOUT_MS || 90_000);
  let response: Response;
  try {
    response = await fetch(completionsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: choice.model, messages: [{ role: "user", content }], max_tokens: 2000, temperature: 0.1 }),
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000),
    });
  } catch (error) {
    fail(`model call failed: ${(error as Error).message}`);
  }
  if (!response.ok) fail(`model returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

  const data = await response.json().catch(() => ({})) as { choices?: { message?: { content?: string } }[] };
  const reply = data.choices?.[0]?.message?.content || "";
  let verdict: { verdict?: unknown; confidence?: unknown; diffs?: unknown; summary?: unknown };
  try {
    const json = reply.match(/\{[\s\S]*\}/);
    if (!json) throw new Error("no JSON found");
    verdict = JSON.parse(json[0]);
  } catch {
    fail(`could not parse the model reply as JSON: ${reply.slice(0, 300)}`);
  }
  if (verdict.verdict !== "match" && verdict.verdict !== "mismatch") fail(`model reply has no valid verdict: ${reply.slice(0, 300)}`);
  console.log(JSON.stringify({
    verdict: verdict.verdict,
    confidence: typeof verdict.confidence === "number" ? verdict.confidence : 0,
    diffs: Array.isArray(verdict.diffs) ? verdict.diffs : [],
    summary: typeof verdict.summary === "string" ? verdict.summary : "",
    model: choice.model,
  }, null, 2));
}

if (import.meta.main) await main();
