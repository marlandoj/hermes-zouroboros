/**
 * Path resolution helpers for Zouroboros.
 *
 * Centralizes how runtime file locations (DBs, checkpoint dirs, workspace root)
 * are resolved so that published packages do not hardcode host-specific paths.
 *
 * Resolution order for each helper:
 *   1. Environment variable (if set)
 *   2. Canonical default under `~/.zouroboros/` (or the XDG-style data dir)
 */

import { join } from 'path';
import { homedir } from 'os';
import { resolveRuntimeDirectories } from './config/runtime-directories.js';

export {
  resolveRuntimeDirectories,
  selectConfigFile,
  RuntimeDirectoryError,
} from './config/runtime-directories.js';
export type {
  RuntimeDirectoryOptions,
  ConfigFileSelectionOptions,
  ConfigFileSelection,
} from './config/runtime-directories.js';

/**
 * Resolve the memory database path.
 *
 * Honors `ZO_MEMORY_DB` (legacy) and `ZOUROBOROS_MEMORY_DB` env vars.
 * Falls back to `~/.zouroboros/memory.db`.
 */
export function getMemoryDbPath(): string {
  return (
    process.env.ZOUROBOROS_MEMORY_DB ||
    process.env.ZO_MEMORY_DB ||
    join(resolveRuntimeDirectories().data, 'memory.db')
  );
}

/**
 * Resolve the checkpoint directory used for context-budget snapshots.
 *
 * Honors `ZO_CHECKPOINT_DIR` and `ZOUROBOROS_CHECKPOINT_DIR`.
 * Falls back to `~/.zouroboros/checkpoints`.
 */
export function getCheckpointDir(): string {
  return (
    process.env.ZOUROBOROS_CHECKPOINT_DIR ||
    process.env.ZO_CHECKPOINT_DIR ||
    join(resolveRuntimeDirectories().data, 'checkpoints')
  );
}

/**
 * Resolve the workspace root (where the user's project files live).
 *
 * Honors `ZO_WORKSPACE` and `ZOUROBOROS_WORKSPACE`.
 * Falls back to the current working directory so that published CLIs work
 * from any project root, not just a fixed host path.
 */
export function getWorkspaceRoot(): string {
  return resolveRuntimeDirectories().workspace;
}

/**
 * Resolve the Zouroboros data directory (`~/.zouroboros` by default).
 *
 * Honors `ZOUROBOROS_DATA_DIR`.
 */
export function getDataDir(): string {
  return resolveRuntimeDirectories().data;
}

/**
 * Resolve a user-home-relative path, used to expand `~/foo` in user-supplied
 * config values. Returns the input unchanged if it does not start with `~`.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
