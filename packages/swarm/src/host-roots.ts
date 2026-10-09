/**
 * Host locations that the 0.1.0 import hard-coded for its source host, resolved at call time
 * from the portable roots in zouroboros-core instead.
 *
 *   workspace  ZOUROBOROS_WORKSPACE / ZO_WORKSPACE, else the current directory
 *   state      ZOUROBOROS_STATE_DIR, else $XDG_STATE_HOME/zouroboros
 *   logs       ZOUROBOROS_LOG_DIR, else <state>/logs
 *   runtime    ZOUROBOROS_RUNTIME_DIR, else $XDG_RUNTIME_DIR/zouroboros, else <state>/runtime
 *
 * A host that keeps the old layout sets ZOUROBOROS_WORKSPACE (and FACTORY_EXTERNAL_ROOT for the
 * external Factory namespace) and gets the previous paths back.
 */
import { join } from 'node:path';
import { resolveRuntimeDirectories } from 'zouroboros-core';

type Env = Record<string, string | undefined>;

const roots = (env: Env) => resolveRuntimeDirectories({ env });

export const workspaceRoot = (env: Env = process.env): string => roots(env).workspace;
export const stateRoot = (env: Env = process.env): string => roots(env).state;
export const logRoot = (env: Env = process.env): string => roots(env).logs;
export const runtimeRoot = (env: Env = process.env): string => roots(env).runtime;

/**
 * Software Factory namespaces. The source tree is FACTORY_SOURCE_ROOT, else the workspace; the
 * external namespace (worktrees and pinned releases) is FACTORY_EXTERNAL_ROOT, else <state>/factory.
 */
export function factoryRoots(env: Env = process.env) {
  const source = env.FACTORY_SOURCE_ROOT || workspaceRoot(env);
  const external = env.FACTORY_EXTERNAL_ROOT || join(stateRoot(env), 'factory');
  return {
    source,
    legacyWorktrees: join(source, '.factory-worktrees'),
    external,
    externalWorktrees: join(external, '.factory-worktrees'),
    externalReleases: join(external, 'releases'),
  };
}

/** Model-routing catalogs published by the model router. */
export function modelRoutingDir(env: Env = process.env): string {
  return join(stateRoot(env), 'model-routing');
}
