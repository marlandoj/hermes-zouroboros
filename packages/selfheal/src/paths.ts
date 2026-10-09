/**
 * Self-heal state, results and log locations.
 *
 * Every path is resolved at call time so a run honours the environment it was started with.
 * Without the portable-root variables the legacy workspace-relative defaults are kept.
 *
 *   ZOUROBOROS_SELFHEAL_DIR   explicit self-heal state directory
 *   ZOUROBOROS_STATE_DIR      portable state root → <state>/selfheal
 *   ZOUROBOROS_LOG_DIR        portable log root (invocation logs)
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

/** Scorecards, RAG-health traces and other self-heal state. */
export function getSelfHealDir(): string {
  if (process.env.ZOUROBOROS_SELFHEAL_DIR) return process.env.ZOUROBOROS_SELFHEAL_DIR;
  if (process.env.ZOUROBOROS_STATE_DIR) return join(process.env.ZOUROBOROS_STATE_DIR, 'selfheal');
  return join(getWorkspaceRoot(), '.zo/selfheal');
}

/** Evolution results. Legacy default: <workspace>/Seeds/zouroboros/results. */
export function getSelfHealResultsDir(): string {
  if (process.env.ZOUROBOROS_SELFHEAL_DIR || process.env.ZOUROBOROS_STATE_DIR) return join(getSelfHealDir(), 'results');
  return join(getWorkspaceRoot(), 'Seeds/zouroboros/results');
}

/** Append-only invocation log for a self-heal CLI. Without ZOUROBOROS_LOG_DIR: <tmpdir>/<name>.log. */
export function getSelfHealLogPath(name: string): string {
  if (process.env.ZOUROBOROS_LOG_DIR) return join(process.env.ZOUROBOROS_LOG_DIR, `${name}.log`);
  return join(tmpdir(), `${name}.log`);
}

/**
 * Autoloop entrypoint used by evolve's autoloop mode. Legacy default: the workspace's nested
 * Zouroboros workflow skill.
 */
export function getAutoloopScript(workspace = getWorkspaceRoot()): string {
  return process.env.ZOUROBOROS_AUTOLOOP_SCRIPT
    || join(workspace, 'Skills/zouroboros/skills/workflow/scripts/autoloop/autoloop.ts');
}
