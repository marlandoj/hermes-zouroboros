// Portable locations for design-md-drift-guard. Nothing is written inside the skill tree.
//   projects config  DESIGN_DRIFT_PROJECTS, else <ZOUROBOROS_CONFIG_DIR>/design-md-drift-guard/projects.json
//   PII scan config  DESIGN_DRIFT_PII_CONFIG, else <ZOUROBOROS_CONFIG_DIR>/design-md-drift-guard/pii.json,
//                    else the shipped placeholder config/pii.json
//   reports          DESIGN_DRIFT_REPORTS_DIR, else <ZOUROBOROS_STATE_DIR>/design-md-drift-guard/reports
//   workspace        ZOUROBOROS_WORKSPACE, else the current directory
// The config and state roots fall back to the hermes-zouroboros profile data directory.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export const SKILL_DIR = resolve(import.meta.dir, "..");

function dataDir(env: Env): string {
  return resolve(env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "hermes-zouroboros"));
}

export function configDir(env: Env = process.env): string {
  return join(env.ZOUROBOROS_CONFIG_DIR || join(dataDir(env), "config"), "design-md-drift-guard");
}

export function projectsPath(env: Env = process.env): string {
  return env.DESIGN_DRIFT_PROJECTS || join(configDir(env), "projects.json");
}

export function piiConfigPath(env: Env = process.env): string {
  if (env.DESIGN_DRIFT_PII_CONFIG) return env.DESIGN_DRIFT_PII_CONFIG;
  const local = join(configDir(env), "pii.json");
  return existsSync(local) ? local : join(SKILL_DIR, "config", "pii.json");
}

export function reportsDir(env: Env = process.env): string {
  return env.DESIGN_DRIFT_REPORTS_DIR || join(env.ZOUROBOROS_STATE_DIR || join(dataDir(env), "state"), "design-md-drift-guard", "reports");
}

export function workspaceRoot(env: Env = process.env): string {
  return resolve(env.ZOUROBOROS_WORKSPACE || process.cwd());
}
