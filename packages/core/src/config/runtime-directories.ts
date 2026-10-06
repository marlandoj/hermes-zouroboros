import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import type {
  ConfigSource,
  RuntimeDirectories,
  RuntimePathKey,
  RuntimePathSource,
} from '../types.js';

type Environment = Record<string, string | undefined>;

export interface RuntimeDirectoryOptions {
  env?: Environment;
  homeDir?: string;
  cwd?: string;
  configFile?: string;
  overrides?: Partial<Record<RuntimePathKey, string>>;
}

export interface ConfigFileSelectionOptions {
  env?: Environment;
  homeDir?: string;
  xdgConfigDir: string;
  explicitPath?: string;
}

export interface ConfigFileSelection {
  path: string;
  source: ConfigSource;
  exists: boolean;
}

export class RuntimeDirectoryError extends Error {
  constructor(message: string, public readonly pathKey: RuntimePathKey | 'configFile') {
    super(message);
    this.name = 'RuntimeDirectoryError';
  }
}

const ENVIRONMENT_KEYS: Record<
  RuntimePathKey,
  { canonical: string; legacy: string }
> = {
  config: { canonical: 'ZOUROBOROS_CONFIG_DIR', legacy: 'ZO_CONFIG_DIR' },
  data: { canonical: 'ZOUROBOROS_DATA_DIR', legacy: 'ZO_DATA_DIR' },
  cache: { canonical: 'ZOUROBOROS_CACHE_DIR', legacy: 'ZO_CACHE_DIR' },
  state: { canonical: 'ZOUROBOROS_STATE_DIR', legacy: 'ZO_STATE_DIR' },
  logs: { canonical: 'ZOUROBOROS_LOG_DIR', legacy: 'ZO_LOG_DIR' },
  runtime: { canonical: 'ZOUROBOROS_RUNTIME_DIR', legacy: 'ZO_RUNTIME_DIR' },
  workspace: { canonical: 'ZOUROBOROS_WORKSPACE', legacy: 'ZO_WORKSPACE' },
  backups: { canonical: 'ZOUROBOROS_BACKUP_DIR', legacy: 'ZO_BACKUP_DIR' },
};

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
}

function absolutePath(path: string, pathKey: RuntimePathKey | 'configFile', homeDir: string): string {
  const expanded = expandHome(path.trim(), homeDir);
  if (!expanded || !isAbsolute(expanded)) {
    throw new RuntimeDirectoryError(`${pathKey} path must resolve to an absolute path`, pathKey);
  }
  return resolve(expanded);
}

function environmentPath(
  key: RuntimePathKey,
  env: Environment,
  homeDir: string
): { path: string; source: RuntimePathSource } | undefined {
  const names = ENVIRONMENT_KEYS[key];
  if (env[names.canonical]) {
    return {
      path: absolutePath(env[names.canonical]!, key, homeDir),
      source: 'canonical-env',
    };
  }
  if (env[names.legacy]) {
    return {
      path: absolutePath(env[names.legacy]!, key, homeDir),
      source: 'legacy-env',
    };
  }
  return undefined;
}

function selectPath(
  key: RuntimePathKey,
  options: RuntimeDirectoryOptions,
  fallback: string,
  fallbackSource: RuntimePathSource,
  env: Environment,
  homeDir: string
): { path: string; source: RuntimePathSource } {
  const explicit = options.overrides?.[key];
  if (explicit) {
    return { path: absolutePath(explicit, key, homeDir), source: 'explicit' };
  }
  return environmentPath(key, env, homeDir) ?? {
    path: absolutePath(fallback, key, homeDir),
    source: fallbackSource,
  };
}

export function selectConfigFile(options: ConfigFileSelectionOptions): ConfigFileSelection {
  const env = options.env ?? process.env;
  const homeDir = absolutePath(options.homeDir ?? env.HOME ?? homedir(), 'configFile', homedir());
  const candidates: Array<{ path: string; source: ConfigSource; requireExisting: boolean }> = [
    ...(options.explicitPath
      ? [{ path: options.explicitPath, source: 'explicit' as const, requireExisting: false }]
      : []),
    ...(env.ZOUROBOROS_CONFIG_FILE
      ? [{ path: env.ZOUROBOROS_CONFIG_FILE, source: 'canonical-env' as const, requireExisting: false }]
      : []),
    ...(env.ZO_CONFIG_FILE
      ? [{ path: env.ZO_CONFIG_FILE, source: 'legacy-env' as const, requireExisting: false }]
      : []),
    { path: join(options.xdgConfigDir, 'config.json'), source: 'xdg-file', requireExisting: true },
    { path: join(homeDir, '.zouroboros', 'config.json'), source: 'legacy-file', requireExisting: true },
  ];

  for (const candidate of candidates) {
    const path = absolutePath(candidate.path, 'configFile', homeDir);
    if (!candidate.requireExisting || existsSync(path)) {
      return { path, source: candidate.source, exists: existsSync(path) };
    }
  }

  return {
    path: absolutePath(join(options.xdgConfigDir, 'config.json'), 'configFile', homeDir),
    source: 'default',
    exists: false,
  };
}

export function resolveRuntimeDirectories(options: RuntimeDirectoryOptions = {}): RuntimeDirectories {
  const env = options.env ?? process.env;
  const homeDir = absolutePath(options.homeDir ?? env.HOME ?? homedir(), 'configFile', homedir());
  const cwd = absolutePath(options.cwd ?? process.cwd(), 'workspace', homeDir);

  const xdgConfigRoot = env.XDG_CONFIG_HOME
    ? absolutePath(env.XDG_CONFIG_HOME, 'config', homeDir)
    : join(homeDir, '.config');
  const xdgDataRoot = env.XDG_DATA_HOME
    ? absolutePath(env.XDG_DATA_HOME, 'data', homeDir)
    : join(homeDir, '.local', 'share');
  const xdgCacheRoot = env.XDG_CACHE_HOME
    ? absolutePath(env.XDG_CACHE_HOME, 'cache', homeDir)
    : join(homeDir, '.cache');
  const xdgStateRoot = env.XDG_STATE_HOME
    ? absolutePath(env.XDG_STATE_HOME, 'state', homeDir)
    : join(homeDir, '.local', 'state');

  const config = selectPath('config', options, join(xdgConfigRoot, 'zouroboros'), 'xdg', env, homeDir);
  const data = selectPath('data', options, join(xdgDataRoot, 'zouroboros'), 'xdg', env, homeDir);
  const cache = selectPath('cache', options, join(xdgCacheRoot, 'zouroboros'), 'xdg', env, homeDir);
  const state = selectPath('state', options, join(xdgStateRoot, 'zouroboros'), 'xdg', env, homeDir);
  const logs = selectPath('logs', options, join(state.path, 'logs'), 'derived', env, homeDir);
  const runtimeFallback = env.XDG_RUNTIME_DIR
    ? join(absolutePath(env.XDG_RUNTIME_DIR, 'runtime', homeDir), 'zouroboros')
    : join(state.path, 'runtime');
  const runtime = selectPath('runtime', options, runtimeFallback, 'derived', env, homeDir);
  const workspace = selectPath('workspace', options, cwd, 'cwd', env, homeDir);
  const backups = selectPath('backups', options, join(data.path, 'backups'), 'derived', env, homeDir);
  const configFile = selectConfigFile({
    env,
    homeDir,
    xdgConfigDir: config.path,
    explicitPath: options.configFile,
  });

  const sources: Record<RuntimePathKey, RuntimePathSource> = {
    config: config.source,
    data: data.source,
    cache: cache.source,
    state: state.source,
    logs: logs.source,
    runtime: runtime.source,
    workspace: workspace.source,
    backups: backups.source,
  };

  return {
    config: config.path,
    data: data.path,
    cache: cache.path,
    state: state.path,
    logs: logs.path,
    runtime: runtime.path,
    workspace: workspace.path,
    backups: backups.path,
    configFile: configFile.path,
    configSource: configFile.source,
    sources,
  };
}
