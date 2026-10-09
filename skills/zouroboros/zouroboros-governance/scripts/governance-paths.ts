// Portable state and configuration locations for the governance skill.
// Mirrors integration/profile.ts runtimeEnv() without importing it, so the skill stays self-contained:
// an explicit ZOUROBOROS_STATE_DIR / ZOUROBOROS_CONFIG_DIR wins, otherwise the hermes-zouroboros
// profile data directory ($HERMES_ZOUROBOROS_HOME, default $XDG_DATA_HOME/hermes-zouroboros) is used.
import { homedir } from "node:os";
import * as path from "node:path";

export function governanceDataDir(): string {
  return path.resolve(process.env.HERMES_ZOUROBOROS_HOME
    || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "hermes-zouroboros"));
}

/** Append-only governance records (audit log, detached anchor). */
export function governanceStateDir(): string {
  return path.join(path.resolve(process.env.ZOUROBOROS_STATE_DIR || path.join(governanceDataDir(), "state")), "governance");
}

/** Owner-only key material and trust registries; kept apart from the records they protect. */
export function governanceConfigDir(): string {
  return path.join(path.resolve(process.env.ZOUROBOROS_CONFIG_DIR || path.join(governanceDataDir(), "config")), "governance");
}

/** Shipped canonical governing documents (ZOUROBOROS.md, CONSTITUTION.md). */
export const SHIPPED_GOVERNING_ROOT = path.resolve(import.meta.dir, "..", "references");
