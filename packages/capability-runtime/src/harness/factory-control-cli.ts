import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canonicalPayloadDigest } from "../fingerprint.js";
import type { SignedActionApproval } from "../contracts/types.js";
import { readFactoryControlConfig, verifyFactoryControlActivation } from "./factory-control-config.js";
import { FactoryControlRuntime, readFactoryControlStatus } from "./factory-control-runtime.js";

export interface FactoryControlCliResult {
  readonly exitCode: number;
  readonly output: string;
}

const HELP = `factory-control — Factory-only capability-runtime canary operator CLI

USAGE:
  factory-control preflight --config <absolute-path>
  factory-control status --config <absolute-path>
  factory-control render --config <absolute-path> --ticket <ZOU-N> --result-file <absolute-path>
  factory-control import-decision --config <absolute-path> --decision-file <absolute-path>
  factory-control rollback --config <absolute-path>

The CLI never signs an action. Import requires an externally signed exact-action decision.`;

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function rollbackFactoryControlConfig(path: string): ReturnType<typeof readFactoryControlConfig> {
  const config = readFactoryControlConfig(path);
  const { content_digest: _, ...unsigned } = config;
  const offUnsigned = { ...unsigned, mode: "off" as const };
  const off = { ...offUnsigned, content_digest: canonicalPayloadDigest(offUnsigned) };
  const payload = `${JSON.stringify(off, null, 2)}\n`;
  const tempPath = `${path}.rollback-${process.pid}`;
  writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(tempPath, 0o600);
  try {
    readFactoryControlConfig(tempPath);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
  return readFactoryControlConfig(path);
}

export async function runFactoryControlCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FactoryControlCliResult> {
  const command = argv[0];
  if (command === undefined || command === "help" || argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, output: HELP };
  }
  try {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: "string" },
        ticket: { type: "string" },
        "result-file": { type: "string" },
        "decision-file": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const configPath = required(values.config, "--config");
    const config = readFactoryControlConfig(configPath);
    if (command === "preflight") {
      const reasons = verifyFactoryControlActivation(config, {
        now: new Date(),
        source_commit: env.ZCR_FACTORY_CONTROL_SOURCE_COMMIT,
      });
      return {
        exitCode: reasons.length === 0 ? 0 : 2,
        output: JSON.stringify({ ok: reasons.length === 0, mode: config.mode, config_digest: config.content_digest, reasons }, null, 2),
      };
    }
    if (command === "status") {
      return { exitCode: 0, output: JSON.stringify({ mode: config.mode, config_digest: config.content_digest, ...readFactoryControlStatus(config.state_dir) }, null, 2) };
    }
    if (command === "rollback") {
      const off = rollbackFactoryControlConfig(configPath);
      return { exitCode: 0, output: JSON.stringify({ ok: true, mode: off.mode, config_digest: off.content_digest }, null, 2) };
    }
    const runtime = new FactoryControlRuntime<never>({
      config,
      source_commit: env.ZCR_FACTORY_CONTROL_SOURCE_COMMIT,
      continuation: () => { throw new Error("Factory control CLI cannot execute the host continuation"); },
    });
    try {
      if (command === "render") {
        const ticket = required(values.ticket, "--ticket");
        const resultFile = required(values["result-file"], "--result-file");
        const dispatchResult = JSON.parse(readFileSync(resultFile, "utf8")) as unknown;
        const prepared = await runtime.prepare({ ticket_identifier: ticket, dispatch_result: dispatchResult });
        return { exitCode: 0, output: JSON.stringify(prepared, null, 2) };
      }
      if (command === "import-decision") {
        const decisionFile = required(values["decision-file"], "--decision-file");
        const signed = JSON.parse(readFileSync(decisionFile, "utf8")) as SignedActionApproval;
        const snapshot = await runtime.importDecision(signed);
        return {
          exitCode: 0,
          output: JSON.stringify({
            action_id: snapshot.action.record_id,
            state: snapshot.action.state,
            dispatch_boundary: snapshot.action.dispatch_boundary,
            content_digest: snapshot.action.content_digest,
          }, null, 2),
        };
      }
      throw new Error(`unknown Factory control command: ${command}`);
    } finally {
      runtime.close();
    }
  } catch (error) {
    return { exitCode: 1, output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) };
  }
}
