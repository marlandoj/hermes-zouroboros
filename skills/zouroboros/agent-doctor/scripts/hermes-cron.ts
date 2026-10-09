/**
 * Read access to the Hermes profile's scheduled agents (cron jobs) and the only write path the
 * doctor and healer use: the Hermes CLI (`hermes cron edit|pause`), which takes Hermes' own jobs
 * lock. jobs.json is never written directly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { paths, runtimeEnv } from "../../../../integration/profile.ts";

export interface HermesJob {
  id: string;
  name?: string;
  prompt?: string;
  skills?: string[];
  skill?: string | null;
  model?: string | null;
  provider?: string | null;
  script?: string | null;
  no_agent?: boolean;
  workdir?: string | null;
  schedule?: { kind?: string; expr?: string; minutes?: number; run_at?: string; display?: string };
  repeat?: { times?: number | null; completed?: number };
  enabled?: boolean;
  state?: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  failure_streak?: number;
  deliver?: string | null;
}

/** The distribution profile's HERMES_HOME (HERMES_ZOUROBOROS_HOME selects the profile). */
export function hermesHome(): string {
  return paths().profile;
}

export function jobsFile(home = hermesHome()): string {
  return join(home, "cron", "jobs.json");
}

/** Jobs from jobs.json (`{"jobs": [...]}`, or a bare list); [] when the profile has none. */
export function loadJobs(file = jobsFile()): HermesJob[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];
  return list.filter((job: unknown): job is HermesJob => typeof (job as HermesJob)?.id === "string");
}

/** The profile's default model (config.yaml `model.default`, or a bare `model:` string). */
export function profileDefaultModel(home = hermesHome()): string {
  const file = join(home, "config.yaml");
  if (!existsSync(file)) return "";
  try {
    const config = parse(readFileSync(file, "utf8")) as { model?: unknown };
    if (typeof config?.model === "string") return config.model;
    const model = config?.model as { default?: unknown } | undefined;
    return typeof model?.default === "string" ? model.default : "";
  } catch {
    return "";
  }
}

/** Runnable means enabled and not paused or finished. */
export function isActive(job: HermesJob): boolean {
  return job.enabled !== false && !["paused", "completed", "disabled"].includes(job.state ?? "");
}

/** Script path as Hermes resolves it: absolute, or relative to $HERMES_HOME/scripts. */
export function scriptPath(script: string, home = hermesHome()): string {
  return isAbsolute(script) ? script : resolve(home, "scripts", script);
}

/** Saved outputs for a job, newest last (cron/output/<id>/<timestamp>.md). */
export function recentOutputs(jobId: string, limit = 3, home = hermesHome()): string[] {
  const dir = join(home, "cron", "output", jobId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort().slice(-limit)
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

export interface CronCommandResult { ok: boolean; command: string[]; status: number | null; stderr: string }

/** Run `hermes cron <args>` against the profile. HERMES_BIN may name another executable. */
export function hermesCron(args: string[]): CronCommandResult {
  const binary = process.env.HERMES_BIN || "hermes";
  const command = [binary, "cron", ...args];
  const env = { ...runtimeEnv(), HERMES_HOME: hermesHome() } as Record<string, string>;
  const result = spawnSync(binary, ["cron", ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { ok: result.status === 0, command, status: result.status, stderr: (result.stderr || "").slice(0, 300) };
}
