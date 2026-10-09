#!/usr/bin/env bun
/**
 * Visual Verification Station — pipeline orchestrator.
 *
 * Ties capture + verify into a single station call. After a maker produces a visual deliverable
 * (UI/route/site), the post-flight harness calls this station. It captures a screenshot (or takes
 * one given with --screenshot), runs the independent verifier, and emits a structured verdict:
 *   - match → task is visually verified (exit 0)
 *   - mismatch → structured visual diff written for the maker's next iteration (exit 1)
 *
 * The maker does NOT self-declare done on visual tasks — this station is the exit condition.
 *
 * hermes-zouroboros: artifacts and the failure log live under
 * $ZOUROBOROS_STATE_DIR/visual-verifier/<project-or-label>/ (falling back to the profile's state
 * dir), never in the skill tree. The optional panel is N independent verify.ts calls, one per
 * model in VISUAL_VERIFIER_PANEL_MODELS, with the author model removed.
 *
 * Usage:
 *   bun station.ts --url http://localhost:3099/my-route \
 *     --criteria "uses the project palette, hero section present" \
 *     --design-md path/to/DESIGN.md --author "provider:author-model" \
 *     --label "my-route" --project my-project
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { excludeAuthor } from "./independence.ts";

const SCRIPT_DIR = import.meta.dir;

/** ZOUROBOROS_STATE_DIR, else the hermes-zouroboros profile's state directory. */
export function stateRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.ZOUROBOROS_STATE_DIR) return resolve(env.ZOUROBOROS_STATE_DIR);
  const data = env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "hermes-zouroboros");
  return resolve(data, "state");
}

export const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_") || "unlabeled";

interface Diff { issue: string; criterion: string; severity: string; model?: string }
interface Verdict { verdict: string; confidence: number; diffs: Diff[]; summary: string; model?: string }

function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      screenshot: { type: "string" },
      criteria: { type: "string" },
      "design-md": { type: "string" },
      "prior-screenshot": { type: "string" },
      author: { type: "string" },
      label: { type: "string", default: "unlabeled" },
      project: { type: "string" },
      "output-dir": { type: "string" },
      "hydrate-ms": { type: "string", default: process.env.VISUAL_VERIFIER_HYDRATE_MS || "3000" },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help || (!values.url && !values.screenshot) || !values.criteria) {
    console.log(`Usage: bun station.ts (--url <url> | --screenshot <png>) --criteria "<text>" [options]

Options:
  --url               URL to capture with agent-browser
  --screenshot        Use an existing screenshot instead of capturing (for example one taken
                      with the Hermes browser tool)
  --criteria          Acceptance criteria text (required)
  --design-md         Path to project DESIGN.md (optional)
  --prior-screenshot  Path to prior screenshot for regression check (optional)
  --author            Author model id (the verifier is never this model)
  --label             Task label (default "unlabeled")
  --project           Project name; groups artifacts and the failure log (default: label)
  --output-dir        Artifact directory (default $ZOUROBOROS_STATE_DIR/visual-verifier/<project-or-label>/)
  --hydrate-ms        Hydration wait in ms before screenshot (default VISUAL_VERIFIER_HYDRATE_MS or 3000)
  --model             Verifier model (default VISUAL_VERIFIER_MODEL; see verify.ts --help)
  --help              Show this help

Environment:
  VISUAL_VERIFIER=0               skip the station (exit 0, nothing written)
  VISUAL_VERIFIER_PANEL_MODELS    comma-separated models; each verifies independently and the
                                  task passes only if every verifier reports a match

Exit codes:
  0 = visual match (task verified) or station disabled
  1 = visual mismatch (rework diff written for the maker)
  2 = station error (capture or verify failed)

Artifacts:
  screenshot-<label>.png    The captured screenshot
  verdict-<label>.json      The verifier's structured verdict
  visual-diff-<label>.json  On mismatch: the rework diff for the maker
  visual-failures.jsonl     Mismatch log, always under the state dir for the project
`);
    process.exit(values.help ? 0 : 1);
  }

  if (/^(0|false|off|no)$/i.test((process.env.VISUAL_VERIFIER ?? "").trim())) {
    console.log("Visual verifier disabled (VISUAL_VERIFIER=0); station skipped.");
    process.exit(0);
  }

  const label = values.label;
  const safeLabel = safeName(label);
  const stateDir = join(stateRoot(), "visual-verifier", safeName(values.project || label));
  const outputDir = values["output-dir"] ? resolve(values["output-dir"]) : stateDir;
  const screenshotPath = join(outputDir, `screenshot-${safeLabel}.png`);
  const verdictPath = join(outputDir, `verdict-${safeLabel}.json`);
  const diffPath = join(outputDir, `visual-diff-${safeLabel}.json`);
  const failuresLogPath = join(stateDir, "visual-failures.jsonl");

  // Panel models, minus the author; a single verifier otherwise.
  const panel = (process.env.VISUAL_VERIFIER_PANEL_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const author = values.author || process.env.VISUAL_VERIFIER_AUTHOR_MODEL || "";
  const verifiers: (string | undefined)[] = panel.length ? excludeAuthor(panel, author) : [values.model];
  if (verifiers.length === 0) {
    console.error("❌ Station: every VISUAL_VERIFIER_PANEL_MODELS entry is the author model; no independent verifier left");
    process.exit(2);
  }

  mkdirSync(outputDir, { recursive: true });

  // Step 1: screenshot
  if (values.screenshot) {
    if (!existsSync(values.screenshot)) {
      console.error(`❌ Station: screenshot not found: ${values.screenshot}`);
      process.exit(2);
    }
    if (resolve(values.screenshot) !== screenshotPath) copyFileSync(values.screenshot, screenshotPath);
  } else {
    console.log(`📸 Capturing screenshot of ${values.url}...`);
    const capture = spawnSync(process.execPath,
      [join(SCRIPT_DIR, "capture.ts"), "--url", values.url!, "--output", screenshotPath, "--hydrate-ms", String(values["hydrate-ms"])],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, encoding: "utf-8" });
    if (capture.status !== 0 || !existsSync(screenshotPath)) {
      console.error(`❌ Station: capture failed: ${(capture.stderr || capture.error?.message || `exit ${capture.status}`).trim()}`);
      process.exit(2);
    }
  }
  console.log(`✅ Screenshot: ${screenshotPath}`);

  // Step 2: independent verifier(s)
  console.log(`🔍 Running ${verifiers.length} visual verifier(s) (≠author constraint active)...`);
  const verdicts: Verdict[] = [];
  for (const model of verifiers) {
    const args = [join(SCRIPT_DIR, "verify.ts"), "--screenshot", screenshotPath, "--criteria", values.criteria, "--label", label];
    if (values["design-md"]) args.push("--design-md", values["design-md"]);
    if (values["prior-screenshot"]) args.push("--prior-screenshot", values["prior-screenshot"]);
    if (author) args.push("--author", author);
    if (model) args.push("--model", model);
    const result = spawnSync(process.execPath, args, { encoding: "utf-8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) {
      console.error(`❌ Station: verifier${model ? ` ${model}` : ""} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
      process.exit(2);
    }
    try {
      verdicts.push(JSON.parse(result.stdout) as Verdict);
    } catch {
      console.error(`❌ Station: could not parse verifier output: ${result.stdout.slice(0, 200)}`);
      process.exit(2);
    }
  }

  // A panel passes only when every verifier reports a clean match.
  const verdict: Verdict = verdicts.length === 1 ? verdicts[0]! : {
    verdict: verdicts.every((v) => v.verdict === "match" && !(v.diffs ?? []).length) ? "match" : "mismatch",
    confidence: Math.min(...verdicts.map((v) => v.confidence ?? 0)),
    diffs: verdicts.flatMap((v) => (v.diffs ?? []).map((d) => ({ ...d, model: v.model }))),
    summary: verdicts.map((v) => `${v.model ?? "verifier"}: ${v.summary}`).join(" | "),
  };
  writeFileSync(verdictPath, JSON.stringify(verdicts.length === 1 ? verdict : { ...verdict, panel: verdicts }, null, 2));

  // Step 3: match or mismatch
  const diffs = verdict.diffs ?? [];
  if (verdict.verdict === "match" && diffs.length === 0) {
    console.log(`\n✅ Visual verification PASSED for "${label}"`);
    console.log(`   Confidence: ${verdict.confidence}`);
    console.log(`   Summary: ${verdict.summary}`);
    console.log(`\n📋 Task is visually verified — the maker may declare done.`);
    process.exit(0);
  }

  console.log(`\n❌ Visual verification FAILED for "${label}"`);
  console.log(`   Confidence: ${verdict.confidence}`);
  console.log(`   ${diffs.length} issue(s) found:\n`);
  for (const d of diffs) {
    const severity = String(d.severity ?? "medium");
    const icon = severity === "high" ? "🔴" : severity === "medium" ? "🟡" : "🟢";
    console.log(`   ${icon} [${severity.toUpperCase()}] ${d.issue}`);
    console.log(`      Violates: ${d.criterion}\n`);
  }

  const reworkDiff = {
    timestamp: new Date().toISOString(),
    label,
    project: values.project,
    url: values.url,
    screenshot: screenshotPath,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    summary: verdict.summary,
    diffs,
    instruction:
      "The visual verifier found the above issues. Fix them and re-run the station. Do NOT self-declare done until the station returns a match.",
  };
  writeFileSync(diffPath, JSON.stringify(reworkDiff, null, 2));
  console.log(`📝 Rework diff written: ${diffPath}`);

  // Failure log, reviewed with the extract-patterns gate (the station never writes instincts).
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(failuresLogPath, `${JSON.stringify({
    timestamp: reworkDiff.timestamp,
    label,
    project: values.project,
    url: values.url,
    diffs,
    confidence: verdict.confidence,
    models: verdicts.map((v) => v.model).filter(Boolean),
  })}\n`);
  console.log(`📊 Failure logged: ${failuresLogPath}`);
  console.log(`\n🔄 The maker must rework based on the visual diff above.`);
  process.exit(1);
}

if (import.meta.main) main();
