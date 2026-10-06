/**
 * Configuration management for Zouroboros
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import type {
  DeepPartial,
  RequiredCapabilityId,
  RuntimeDirectories,
  RuntimePathKey,
  ZouroborosConfig,
} from '../types.js';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH } from '../constants.js';
import { ZouroborosConfigSchema, formatValidationErrors } from './schema.js';
import { resolveRuntimeDirectories } from './runtime-directories.js';
import { SecretReferenceError, validateSecretReferences } from './secret-reference.js';

export { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH };
export { validateConfigSchema, formatValidationErrors } from './schema.js';
export type { ConfigValidationIssue } from './schema.js';

type Environment = Record<string, string | undefined>;

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: DeepPartial<ZouroborosConfig>;
  directoryOverrides?: Partial<Record<RuntimePathKey, string>>;
  env?: Environment;
  homeDir?: string;
  cwd?: string;
  availableCapabilities?: Iterable<RequiredCapabilityId>;
}

export interface ValidateConfigOptions {
  env?: Environment;
  homeDir?: string;
  availableCapabilities?: Iterable<RequiredCapabilityId>;
  enforceCapabilityAvailability?: boolean;
}

/**
 * Configuration validation error
 */
export class ConfigValidationError extends Error {
  constructor(message: string, public path: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Load configuration from file or return defaults
 */
export function loadConfig(configPathOrOptions: string | LoadConfigOptions = {}): ZouroborosConfig {
  const options = typeof configPathOrOptions === 'string'
    ? { configPath: configPathOrOptions }
    : configPathOrOptions;
  const env = options.env ?? process.env;
  const directories = resolveRuntimeDirectories({
    env,
    homeDir: options.homeDir,
    cwd: options.cwd,
    configFile: options.configPath,
    overrides: options.directoryOverrides,
  });
  let config = createRuntimeDefaultConfig(directories);

  if (existsSync(directories.configFile)) {
    try {
      const content = readFileSync(directories.configFile, 'utf-8');
      const parsed = normalizeSerializedConfig(JSON.parse(content) as DeepPartial<ZouroborosConfig>);
      config = mergeConfigValues(config, parsed);
    } catch (error) {
      throw new ConfigValidationError(
        `Failed to parse config at ${directories.configFile}: ${error instanceof Error ? error.message : String(error)}`,
        directories.configFile
      );
    }
  }

  config = applyEnvironmentValues(config, env);
  if (options.directoryOverrides?.workspace) {
    config.core.workspaceRoot = directories.workspace;
  }
  if (options.directoryOverrides?.data) {
    config.core.dataDir = directories.data;
  }
  if (options.overrides) {
    config = mergeConfigValues(config, options.overrides);
  }
  config = resolveConfiguredPaths(config, options.homeDir ?? env.HOME ?? homedir());

  const validated = validateConfig(config, {
    env,
    homeDir: options.homeDir,
    availableCapabilities: options.availableCapabilities,
  });
  return applyEnvGates(validated, env);
}

function resolveConfiguredPaths(config: ZouroborosConfig, homeDir: string): ZouroborosConfig {
  const next = structuredClone(config);
  const expand = (path: string): string => {
    const expanded = path === '~'
      ? homeDir
      : path.startsWith('~/')
        ? join(homeDir, path.slice(2))
        : path;
    return isAbsolute(expanded) ? resolve(expanded) : expanded;
  };

  next.core.workspaceRoot = expand(next.core.workspaceRoot);
  next.core.dataDir = expand(next.core.dataDir);
  next.memory.dbPath = expand(next.memory.dbPath);
  next.swarm.registryPath = expand(next.swarm.registryPath);
  next.personas.identityDir = expand(next.personas.identityDir);
  next.personas.defaultSoulPath = expand(next.personas.defaultSoulPath);
  return next;
}

function normalizeSerializedConfig(
  config: DeepPartial<ZouroborosConfig>
): DeepPartial<ZouroborosConfig> {
  const permanent = config.memory?.decayConfig?.permanent as unknown;
  if (permanent === null || permanent === 'Infinity') {
    (config.memory!.decayConfig!.permanent as number) = Infinity;
  }
  return config;
}

function createRuntimeDefaultConfig(directories: RuntimeDirectories): ZouroborosConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.core.workspaceRoot = directories.workspace;
  config.core.dataDir = directories.data;
  config.memory.dbPath = join(directories.data, 'memory.db');
  config.swarm.registryPath = join(directories.data, 'executor-registry.json');
  config.personas.identityDir = join(directories.workspace, 'IDENTITY');
  config.personas.defaultSoulPath = join(directories.workspace, 'SOUL.md');
  return config;
}

function parseCapabilityList(value: string): RequiredCapabilityId[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('Required capabilities must be a JSON string array or comma-separated list');
    }
    return parsed as RequiredCapabilityId[];
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean) as RequiredCapabilityId[];
}

function applyEnvironmentValues(config: ZouroborosConfig, env: Environment): ZouroborosConfig {
  const next = structuredClone(config);
  next.core.workspaceRoot = env.ZOUROBOROS_WORKSPACE ?? env.ZO_WORKSPACE ?? next.core.workspaceRoot;
  next.core.dataDir = env.ZOUROBOROS_DATA_DIR ?? env.ZO_DATA_DIR ?? next.core.dataDir;
  next.core.logLevel = (env.ZOUROBOROS_LOG_LEVEL ?? env.ZO_LOG_LEVEL ?? next.core.logLevel) as ZouroborosConfig['core']['logLevel'];
  next.core.defaultTimezone = env.ZOUROBOROS_TIMEZONE ?? env.ZO_TIMEZONE ?? next.core.defaultTimezone;
  next.memory.dbPath = env.ZOUROBOROS_MEMORY_DB ?? env.ZO_MEMORY_DB ?? next.memory.dbPath;
  next.swarm.registryPath = env.ZOUROBOROS_EXECUTOR_REGISTRY ?? env.ZO_EXECUTOR_REGISTRY ?? next.swarm.registryPath;

  const requiredCapabilities = env.ZOUROBOROS_REQUIRED_CAPABILITIES ?? env.ZO_REQUIRED_CAPABILITIES;
  if (requiredCapabilities !== undefined) {
    try {
      next.core.requiredCapabilities = parseCapabilityList(requiredCapabilities);
    } catch (error) {
      throw new ConfigValidationError(
        error instanceof Error ? error.message : String(error),
        'core.requiredCapabilities'
      );
    }
  }
  return next;
}

let _vectorDisabledWarned = false;

/**
 * Apply environment-driven gates to a fully-merged config.
 *
 * Currently:
 *   - If `memory.vectorEnabled` is true but neither OPENAI_API_KEY nor
 *     ZO_OPENAI_API_KEY is set, soft-degrade by flipping it to false.
 *     Memory still works (text/SQL/FTS); vector retrieval, HyDE, and graph
 *     cohesion are skipped. Warns once per process.
 *
 * Set ZOUROBOROS_VECTOR_FORCE=1 to bypass the gate (for tests / users who
 * route embeddings through a non-OpenAI proxy that they expose at a custom
 * endpoint).
 */
export function applyEnvGates(
  config: ZouroborosConfig,
  env: Environment = process.env
): ZouroborosConfig {
  if (!config.memory.vectorEnabled) return config;
  if (env.ZOUROBOROS_VECTOR_FORCE === '1') return config;

  const hasKey = !!(env.OPENAI_API_KEY || env.ZO_OPENAI_API_KEY);
  if (hasKey) return config;

  if (!_vectorDisabledWarned) {
    _vectorDisabledWarned = true;
    console.warn(
      '[zouroboros] OPENAI_API_KEY not set — vector search auto-disabled for this session. ' +
      'Memory will operate in text/FTS-only mode. Export the key and restart to re-enable semantic retrieval.'
    );
  }

  return {
    ...config,
    memory: { ...config.memory, vectorEnabled: false },
  };
}

/** Reset warning state (for tests). */
export function _resetEnvGateWarning(): void {
  _vectorDisabledWarned = false;
}

/**
 * Save configuration to file
 */
export function saveConfig(
  config: ZouroborosConfig,
  configPath: string = resolveRuntimeDirectories().configFile
): void {
  const validated = validateConfig(config);
  validated.updatedAt = new Date().toISOString();
  
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(
    configPath,
    JSON.stringify(validated, (_key, value) => value === Infinity ? 'Infinity' : value, 2),
    'utf-8'
  );
}

/**
 * Merge partial config with defaults
 */
export function mergeConfig(partial: DeepPartial<ZouroborosConfig>): ZouroborosConfig {
  return applyEnvGates(validateConfig(mergeConfigValues(DEFAULT_CONFIG, partial)));
}

function mergeConfigValues(
  base: ZouroborosConfig,
  partial: DeepPartial<ZouroborosConfig>
): ZouroborosConfig {
  return deepMergeConfig(base, partial) as ZouroborosConfig;
}

export function parseSerializedConfig(config: unknown): ZouroborosConfig {
  if (!isConfigRecord(config)) {
    throw new ConfigValidationError('Config must be an object', '');
  }
  const migrated = normalizeSerializedConfig(
    structuredClone(config) as DeepPartial<ZouroborosConfig>
  );
  if (isConfigRecord(migrated.core)) {
    if (migrated.core.requiredCapabilities === undefined) {
      migrated.core.requiredCapabilities = structuredClone(DEFAULT_CONFIG.core.requiredCapabilities);
    }
    if (migrated.core.secretReferences === undefined) {
      migrated.core.secretReferences = structuredClone(DEFAULT_CONFIG.core.secretReferences);
    }
  }
  return validateConfig(migrated);
}

const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMergeConfig(base: unknown, partial: unknown, path = ''): unknown {
  if (partial === undefined) return structuredClone(base);
  if (Array.isArray(partial)) return structuredClone(partial);
  if (!isConfigRecord(partial)) return partial;
  if (
    isConfigRecord(base) &&
    typeof partial.kind === 'string' &&
    typeof base.kind === 'string' &&
    partial.kind !== base.kind
  ) {
    return structuredClone(partial);
  }

  const merged: Record<string, unknown> = isConfigRecord(base)
    ? structuredClone(base)
    : {};
  for (const [key, value] of Object.entries(partial)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      const location = path ? `${path}.${key}` : key;
      throw new ConfigValidationError(`Forbidden configuration key: ${location}`, location);
    }
    const location = path ? `${path}.${key}` : key;
    merged[key] = deepMergeConfig(merged[key], value, location);
  }
  return merged;
}

/**
 * Retired configuration keys that older operator configs may still carry.
 * They are stripped (with a one-time warning per key per process) before
 * schema validation, so a stale key never bricks startup — while the strict
 * schema continues to reject genuinely unknown keys (typo protection).
 *
 * - initializedAt           — superseded by createdAt/updatedAt
 * - memory.ollamaUrl        — on-host Ollama removed 2026-05-29 (host has no
 * - memory.ollamaModel        GPU; remote tiers arm via ZO_EMBED_BASE_URL etc.)
 */
const RETIRED_CONFIG_KEYS: ReadonlyArray<readonly string[]> = [
  ['initializedAt'],
  ['memory', 'ollamaUrl'],
  ['memory', 'ollamaModel'],
];

const RETIRED_KEY_HINTS: Record<string, string> = {
  initializedAt: 'superseded by createdAt/updatedAt',
  'memory.ollamaUrl': 'on-host Ollama was removed 2026-05-29; the host has no GPU',
  'memory.ollamaModel': 'on-host Ollama was removed 2026-05-29; the host has no GPU',
};

const _warnedRetiredKeys = new Set<string>();

/** Reset retired-key warning state (for tests). */
export function _resetRetiredKeyWarnings(): void {
  _warnedRetiredKeys.clear();
}

function stripRetiredConfigKeys(config: unknown): unknown {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return config;
  const next = structuredClone(config) as Record<string, unknown>;
  for (const path of RETIRED_CONFIG_KEYS) {
    const dotted = path.join('.');
    let node: unknown = next;
    for (const segment of path.slice(0, -1)) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) { node = undefined; break; }
      node = (node as Record<string, unknown>)[segment];
    }
    if (typeof node !== 'object' || node === null) continue;
    const leaf = path[path.length - 1];
    if (!(leaf in (node as Record<string, unknown>))) continue;
    delete (node as Record<string, unknown>)[leaf];
    if (!_warnedRetiredKeys.has(dotted)) {
      _warnedRetiredKeys.add(dotted);
      console.warn(
        `[zouroboros] Ignoring retired config key "${dotted}" ` +
        `(${RETIRED_KEY_HINTS[dotted] ?? 'no longer used'}). ` +
        'Remove it from config.json to silence this warning.'
      );
    }
  }
  return next;
}

/**
 * Validate configuration structure using Zod schemas.
 * Throws ConfigValidationError with actionable messages on failure.
 */
export function validateConfig(
  config: unknown,
  options: ValidateConfigOptions = {}
): ZouroborosConfig {
  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('Config must be an object', '');
  }

  const result = ZouroborosConfigSchema.safeParse(stripRetiredConfigKeys(config));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ConfigValidationError(formatValidationErrors(issues), issues[0]?.path ?? '');
  }

  const validated = result.data as ZouroborosConfig;
  try {
    validateSecretReferences(validated.core.secretReferences, {
      env: options.env,
      homeDir: options.homeDir,
    });
  } catch (error) {
    if (error instanceof SecretReferenceError) {
      throw new ConfigValidationError(error.message, `core.secretReferences.${error.referenceName}`);
    }
    throw error;
  }

  const enforceCapabilityAvailability =
    options.enforceCapabilityAvailability === true || options.availableCapabilities !== undefined;
  if (
    enforceCapabilityAvailability &&
    validated.core.requiredCapabilities.length > 0 &&
    options.availableCapabilities === undefined
  ) {
    throw new ConfigValidationError(
      'Capability availability must be provided when required capabilities are configured',
      'core.requiredCapabilities'
    );
  }

  if (options.availableCapabilities !== undefined) {
    const available = new Set(options.availableCapabilities);
    const missing = validated.core.requiredCapabilities.filter((capability) => !available.has(capability));
    if (missing.length > 0) {
      throw new ConfigValidationError(
        `Required capabilities are unavailable: ${missing.join(', ')}`,
        'core.requiredCapabilities'
      );
    }
  }

  return validated;
}

export function enforceCapabilityAvailability(
  config: ZouroborosConfig,
  availableCapabilities: Iterable<RequiredCapabilityId>,
): ZouroborosConfig {
  return validateConfig(config, { availableCapabilities });
}

/**
 * Get a nested config value by path
 */
export function getConfigValue<T>(config: ZouroborosConfig, path: string): T | undefined {
  const parts = path.split('.');
  let current: unknown = config;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current as T;
}

/**
 * Set a nested config value by path
 */
export function setConfigValue<T>(
  config: ZouroborosConfig,
  path: string,
  value: T
): ZouroborosConfig {
  const parts = path.split('.');
  const newConfig = structuredClone(config);
  let current: Record<string, unknown> = newConfig as unknown as Record<string, unknown>;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  newConfig.updatedAt = new Date().toISOString();

  return validateConfig(newConfig);
}

/**
 * Initialize configuration with interactive prompts
 */
export async function initConfig(options: {
  force?: boolean;
  workspaceRoot?: string;
  dataDir?: string;
  configPath?: string;
} = {}): Promise<ZouroborosConfig> {
  const directories = resolveRuntimeDirectories({
    configFile: options.configPath,
    overrides: {
      ...(options.workspaceRoot ? { workspace: options.workspaceRoot } : {}),
      ...(options.dataDir ? { data: options.dataDir } : {}),
    },
  });
  const configPath = directories.configFile;

  if (existsSync(configPath) && !options.force) {
    throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
  }

  const config = createRuntimeDefaultConfig(directories);
  config.createdAt = new Date().toISOString();
  config.updatedAt = new Date().toISOString();

  if (options.workspaceRoot) {
    config.core.workspaceRoot = options.workspaceRoot;
  }

  if (options.dataDir) {
    config.core.dataDir = options.dataDir;
    config.memory.dbPath = join(options.dataDir, 'memory.db');
    config.swarm.registryPath = join(options.dataDir, 'executor-registry.json');
  }

  // Ensure data directory exists
  if (!existsSync(config.core.dataDir)) {
    mkdirSync(config.core.dataDir, { recursive: true });
  }

  saveConfig(config, configPath);
  return config;
}
