#!/usr/bin/env bun
/**
 * Visual Verifier — capture script.
 *
 * Captures a full-page screenshot of a URL via the agent-browser CLI:
 * open → hydrate (wait) → screenshot → print the path.
 *
 * hermes-zouroboros: arguments go to agent-browser as an argv array (no shell). Without
 * agent-browser, capture the page with the Hermes browser tool instead and pass the image to
 * station.ts --screenshot.
 *
 * Usage:
 *   bun capture.ts --url "http://localhost:3099/route" --output /tmp/shot.png
 *   bun capture.ts --url "https://example.com" --output /tmp/shot.png --hydrate-ms 5000
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    output: { type: "string" },
    "hydrate-ms": { type: "string", default: process.env.VISUAL_VERIFIER_HYDRATE_MS || "3000" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help || !values.url || !values.output) {
  console.log(`Usage: bun capture.ts --url <url> --output <path> [--hydrate-ms <ms>]

Options:
  --url          URL to capture (required)
  --output       Output PNG path (required)
  --hydrate-ms   Milliseconds to wait after open for hydration (default VISUAL_VERIFIER_HYDRATE_MS or 3000)
  --help         Show this help

Requires the agent-browser CLI on PATH. Without it, take the screenshot with the Hermes
browser tool and pass it to station.ts with --screenshot.
`);
  process.exit(values.help ? 0 : 1);
}

const url = values.url;
const output = values.output;
const hydrateMs = Number.parseInt(values["hydrate-ms"] || "3000", 10);

if (!/^https?:\/\//i.test(url)) {
  console.error(`capture: only http(s) URLs are supported: ${url}`);
  process.exit(1);
}
if (!Bun.which("agent-browser")) {
  console.error("capture: agent-browser CLI not found on PATH. Install it, or capture with the Hermes browser tool and pass the image to station.ts --screenshot.");
  process.exit(1);
}

const outDir = dirname(output);
if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function agentBrowser(args: string[], step: string) {
  const result = spawnSync("agent-browser", args, { timeout: 15_000, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    console.error(`capture: failed to ${step}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
    process.exit(1);
  }
}

agentBrowser(["open", url], `open ${url}`);
if (Number.isFinite(hydrateMs) && hydrateMs > 0) Bun.sleepSync(hydrateMs);
agentBrowser(["screenshot", output, "--full"], `screenshot to ${output}`);

if (!existsSync(output)) {
  console.error(`capture: screenshot was not created at ${output}`);
  process.exit(1);
}
console.log(output);
