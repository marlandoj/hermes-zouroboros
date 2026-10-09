#!/usr/bin/env bun
/**
 * Retry-wrapped one-shot model runner over the Hermes provider/model layer.
 *
 * hermes-zouroboros: replaces the source workspace's /zo/ask SSE runner. Calls go through the
 * profile's executor registry (default hermes-vps, i.e. `hermes -z` through
 * integration/hermes-bridge.sh), so the provider, model and credentials come from the Hermes
 * profile. The bridge returns a final response only, so there is no partial stream to resume:
 * each retry re-sends the prompt (prefer idempotent prompts).
 *
 *   1. Classifies failures from the bridge exit status: timeouts, Hermes failures and empty
 *      output are transient; usage errors, a missing Hermes CLI and interrupts are permanent.
 *   2. Retries transient failures with exponential backoff + jitter.
 *   3. Optional model chain rotation after --same-model-retries attempts on one model.
 *   4. Unfunded providers (HTTP 402, insufficient balance) fail quietly: the model is skipped at
 *      once for the next chain model, with no retry, no backoff and no warning (debug log only).
 *      Skips do not use up --max-attempts. If no funded model is left the outcome is "unfunded".
 *   5. Exit codes: 0 success, 1 permanent failure (including unfunded), 2 retries exhausted, 3 usage error.
 */
import { readFileSync } from "node:fs";
import { ask, debugLog, TRANSIENT_FAILURES, type AskFailure, type AskOutcome, type AskRequest } from "../../../../integration/ask.ts";

export interface RetryOptions {
  /** Model ids to rotate through; [""] means the profile's configured model. */
  models: string[];
  provider?: string;
  maxAttempts: number;
  sameModelRetries: number;
  timeoutSec?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  workdir?: string;
  executor?: string;
  verbose?: boolean;
  /** Injection points for tests. */
  askImpl?: (request: AskRequest) => Promise<AskOutcome>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface AttemptRecord { attempt: number; model: string; ok: boolean; ms: number; failure?: AskFailure; detail?: string }

export interface RetryResult {
  ok: boolean;
  output: string;
  model: string;
  attempts: AttemptRecord[];
  /** "permanent" stops immediately; "exhausted" means every attempt failed transiently;
   * "unfunded" means every model left in the chain had an unfunded provider. */
  outcome: "success" | "permanent" | "exhausted" | "unfunded";
}

export function backoffMs(attemptIndex: number, base: number, cap: number, random = Math.random): number {
  const exp = Math.min(cap, base * 2 ** attemptIndex);
  return Math.round(exp + random() * exp * 0.25);
}

/** Model for a 0-based attempt: stay on one model for sameModelRetries attempts, then rotate. */
export function modelForAttempt(models: string[], attemptIndex: number, sameModelRetries: number): string {
  const per = Math.max(1, sameModelRetries);
  return models[Math.min(models.length - 1, Math.floor(attemptIndex / per))] ?? "";
}

export async function askWithRetry(prompt: string, options: RetryOptions): Promise<RetryResult> {
  const call = options.askImpl ?? ask;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const models = options.models.length ? options.models : [""];
  const maxAttempts = Math.max(1, options.maxAttempts);
  const attempts: AttemptRecord[] = [];
  const per = Math.max(1, options.sameModelRetries);
  let modelIndex = 0;
  let onModel = 0;
  for (let index = 0; index < maxAttempts;) {
    const model = models[modelIndex] ?? "";
    const result = await call({
      prompt, model: model || undefined, provider: model ? options.provider : undefined,
      timeoutSec: options.timeoutSec, workdir: options.workdir, executor: options.executor,
    });
    attempts.push({ attempt: attempts.length + 1, model, ok: result.ok, ms: result.ms, failure: result.failure, detail: result.detail });
    if (result.ok) {
      if (options.verbose) console.error(`[ask-retry] attempt ${index + 1}/${maxAttempts} model=${model || "(profile)"} ok ${result.ms}ms`);
      return { ok: true, output: result.output, model, attempts, outcome: "success" };
    }
    if (result.failure === "unfunded") {
      // Expected and quiet: skip to the next model without retrying, backing off or warning.
      debugLog(`ask-retry: model=${model || "(profile)"} unfunded, skipped`);
      if (modelIndex + 1 >= models.length) return { ok: false, output: "", model, attempts, outcome: "unfunded" };
      modelIndex++;
      onModel = 0;
      continue;
    }
    if (options.verbose) console.error(`[ask-retry] attempt ${index + 1}/${maxAttempts} model=${model || "(profile)"} failed: ${result.failure}${result.detail ? ` (${result.detail})` : ""} ${result.ms}ms`);
    if (!result.failure || !TRANSIENT_FAILURES.has(result.failure)) return { ok: false, output: "", model, attempts, outcome: "permanent" };
    index++;
    if (++onModel >= per && modelIndex + 1 < models.length) { modelIndex++; onModel = 0; }
    if (index < maxAttempts) await sleep(backoffMs(index - 1, options.baseDelayMs, options.maxDelayMs, options.random));
  }
  return { ok: false, output: "", model: attempts.at(-1)?.model ?? "", attempts, outcome: "exhausted" };
}

const HELP = `ask-retry — retry-wrapped one-shot model call through the Hermes profile

Usage:
  bun ask-retry.ts [--model ID | --chain "m1,m2"] --input "prompt"   (or prompt on stdin)

Flags:
  --model ID                 model id (default: the Hermes profile's model)
  --chain "m1,m2"            rotate across models after same-model retries exhaust
  --provider NAME            Hermes provider override (requires a model)
  --max-attempts 4           total attempts
  --same-model-retries 2     attempts on one model before rotating the chain
  --timeout-sec 1200         per-attempt ceiling (HERMES_TIMEOUT for the bridge)
  --base-delay-ms 2500 / --max-delay-ms 30000   backoff bounds (jittered)
  --executor ID              registry executor (default hermes-vps)
  --workdir PATH             agent working directory (default: profile workspace)
  --output-format-file F     JSON schema appended to the prompt as the required output shape
  --json                     print the result envelope (output, model, attempt trail)
  --verbose, -v              attempt log to stderr
  --dry-run                  print the resolved configuration, make no call

Unfunded providers (HTTP 402, insufficient balance) are skipped quietly for the next --chain model
(no retry, no warning; HERMES_ZOUROBOROS_DEBUG=1 logs them).

Exit: 0 success, 1 permanent failure or every model unfunded, 2 retries exhausted, 3 usage error.`;

function parse(argv: string[]) {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (flag: string) => argv.includes(flag);
  const num = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid number: ${value}`);
    return parsed;
  };
  const chain = get("--chain");
  return {
    help: has("--help") || has("-h"),
    input: get("--input"),
    models: chain ? chain.split(",").map((m) => m.trim()).filter(Boolean) : [get("--model") ?? ""],
    provider: get("--provider"),
    maxAttempts: num(get("--max-attempts"), 4),
    sameModelRetries: num(get("--same-model-retries"), 2),
    timeoutSec: num(get("--timeout-sec"), 1200),
    baseDelayMs: num(get("--base-delay-ms"), 2500),
    maxDelayMs: num(get("--max-delay-ms"), 30_000),
    executor: get("--executor"),
    workdir: get("--workdir"),
    outputFormatFile: get("--output-format-file"),
    json: has("--json"),
    verbose: has("--verbose") || has("-v"),
    dryRun: has("--dry-run"),
  };
}

if (import.meta.main) {
  let o: ReturnType<typeof parse>;
  try { o = parse(process.argv.slice(2)); } catch (error) { console.error(`error: ${(error as Error).message}`); process.exit(3); }
  if (o.help) { console.log(HELP); process.exit(0); }
  let prompt = o.input ?? (process.stdin.isTTY ? "" : await Bun.stdin.text());
  if (o.outputFormatFile) {
    const schema = JSON.parse(readFileSync(o.outputFormatFile, "utf8"));
    prompt += `\n\nReturn ONLY JSON matching this schema, no prose or markdown fences:\n${JSON.stringify(schema)}`;
  }
  if (!prompt.trim()) { console.error("error: require --input (or a prompt on stdin)"); process.exit(3); }
  if (o.provider && o.models.some((m) => !m)) { console.error("error: --provider requires --model or --chain"); process.exit(3); }
  if (o.dryRun) {
    const { input: _input, ...shown } = o;
    console.log(JSON.stringify({ ...shown, promptChars: prompt.length }, null, 2));
    process.exit(0);
  }
  const result = await askWithRetry(prompt, o);
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(result.output);
  else if (result.outcome !== "unfunded") console.error(`ask-retry: ${result.outcome} after ${result.attempts.length} attempt(s): ${result.attempts.at(-1)?.failure ?? "unknown"}`);
  else debugLog("ask-retry: every model in the chain is unfunded");
  process.exit(result.ok ? 0 : result.outcome === "exhausted" ? 2 : 1);
}
