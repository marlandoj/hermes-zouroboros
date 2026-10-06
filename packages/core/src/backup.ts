import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { Database } from 'bun:sqlite';
import type { RuntimeDirectories, ZouroborosConfig } from './types.js';
import { loadConfig } from './config/loader.js';
import { resolveRuntimeDirectories } from './config/runtime-directories.js';
import {
  STATE_BUNDLE_FORMAT,
  exportStateBundleSnapshot,
  importPreparedStateFiles,
  importStateBundleWithRequiredSkips,
  type StateBundleFile,
  type StateBundleImportOptions,
  type StateBundleManifest,
  type StateBundleRole,
} from './state-bundle.js';

export type BackupManifest = StateBundleManifest;
export type BackupFile = StateBundleFile;

export interface LegacyBackupFile {
  name: string;
  originalPath: string;
  sizeBytes: number;
}

export interface LegacyBackupManifest {
  version: string;
  createdAt: string;
  hostname: string;
  files: LegacyBackupFile[];
}

export interface BackupResult {
  backupDir: string;
  manifest: BackupManifest;
  totalSizeBytes: number;
}

export interface RestoreResult {
  restoredFiles: string[];
  skippedFiles: string[];
  manifest: BackupManifest | LegacyBackupManifest;
}

export interface RestoreBackupOptions {
  dryRun?: boolean;
  skipConfig?: boolean;
  config?: ZouroborosConfig;
  configPath?: string;
  destinations?: Partial<Record<StateBundleRole, string>>;
  allowedRoots?: readonly string[];
  requiredRoles?: readonly StateBundleRole[];
  targetDirectories?: RuntimeDirectories;
  configPathMappings?: Readonly<Record<string, string>>;
}

export interface RestoreLegacyBackupOptions extends RestoreBackupOptions {
  destinations: Partial<Record<StateBundleRole, string>>;
  allowedRoots: readonly string[];
}

const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 10;

export type BackupDatabaseMode = 'auto' | 'sqlite-snapshot' | 'offline';

const BACKUP_BUNDLE_PATHS: Record<string, string> = {
  'memory-db': 'state/memory.db',
  'memory-wal': 'state/memory.db-wal',
  'memory-shm': 'state/memory.db-shm',
  config: 'config/config.json',
  'executor-registry': 'state/executor-registry.json',
};

const LEGACY_NAME_ROLES: Record<string, StateBundleRole> = {
  'memory.db': 'memory-db',
  'memory.db-wal': 'memory-wal',
  'memory.db-shm': 'memory-shm',
  'config.json': 'config',
  'executor-registry.json': 'executor-registry',
};

export function getBackupDir(config?: ZouroborosConfig): string {
  return config ? join(config.core.dataDir, BACKUP_DIR_NAME) : resolveRuntimeDirectories().backups;
}

function uniqueBackupDirectory(backupRoot: string, name: string): string {
  const root = resolve(backupRoot);
  const initial = resolve(root, name);
  if (dirname(initial) !== root) {
    throw new Error('Backup directory escaped the configured backup root.');
  }
  if (!existsSync(initial)) return initial;
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${initial}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique backup directory below ${backupRoot}`);
}

function validateBackupLabel(label: string | undefined): string {
  if (!label) return '';
  if (
    label.length > 64 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(label) ||
    label.includes('..')
  ) {
    throw new Error('Backup label must be 1-64 safe alphanumeric, dot, underscore, or hyphen characters.');
  }
  return `-${label}`;
}

function stableRead(paths: readonly string[]): Map<string, Buffer> {
  const first = new Map<string, { content: Buffer; size: number; mtimeMs: number }>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const before = statSync(path);
    const content = readFileSync(path);
    const after = statSync(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || content.byteLength !== after.size) {
      throw new Error(`State changed while it was being read: ${path}`);
    }
    first.set(path, { content, size: after.size, mtimeMs: after.mtimeMs });
  }
  for (const [path, snapshot] of first) {
    const before = statSync(path);
    const content = readFileSync(path);
    const after = statSync(path);
    if (
      before.size !== snapshot.size ||
      before.mtimeMs !== snapshot.mtimeMs ||
      after.size !== snapshot.size ||
      after.mtimeMs !== snapshot.mtimeMs ||
      !content.equals(snapshot.content)
    ) {
      throw new Error(`State was not stable during offline backup: ${path}`);
    }
  }
  return new Map([...first].map(([path, snapshot]) => [path, snapshot.content]));
}

function hasSqliteHeader(path: string): boolean {
  if (!existsSync(path) || statSync(path).size < 16) return false;
  return readFileSync(path).subarray(0, 16).toString('binary') === 'SQLite format 3\0';
}

function snapshotSqliteDatabase(sourcePath: string, backupRoot: string): Buffer {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const snapshotPath = join(backupRoot, `.sqlite-snapshot-${randomUUID()}.db`);
  const database = new Database(sourcePath, { readonly: true, strict: true });
  try {
    database.run('VACUUM INTO ?', [snapshotPath]);
    database.close();
    return readFileSync(snapshotPath);
  } catch (error) {
    throw new Error(
      `Could not create a coherent SQLite snapshot: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    try {
      database.close();
    } catch {
      // Closing an already closed SQLite handle is harmless.
    }
    rmSync(snapshotPath, { force: true });
  }
}

export function createBackup(options: {
  config?: ZouroborosConfig;
  configPath?: string;
  label?: string;
  databaseMode?: BackupDatabaseMode;
} = {}): BackupResult {
  const runtime = resolveRuntimeDirectories({ configFile: options.configPath });
  const configPath = options.configPath ?? runtime.configFile;
  const config = options.config ?? loadConfig(configPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const label = validateBackupLabel(options.label);
  const backupName = `backup-${timestamp}${label}`;
  const backupDir = uniqueBackupDirectory(getBackupDir(config), backupName);

  const backupRoot = getBackupDir(config);
  const databaseMode = options.databaseMode ?? 'auto';
  const databaseIsSqlite = hasSqliteHeader(config.memory.dbPath);
  if (databaseMode === 'sqlite-snapshot' && !databaseIsSqlite) {
    throw new Error('The configured memory database is not SQLite; sqlite-snapshot mode cannot continue.');
  }
  const useSqliteSnapshot = databaseIsSqlite && databaseMode !== 'offline';
  const sidecars = [`${config.memory.dbPath}-wal`, `${config.memory.dbPath}-shm`];
  if (!databaseIsSqlite && databaseMode === 'auto' && sidecars.some(existsSync)) {
    throw new Error('Non-SQLite state with WAL/SHM sidecars requires explicit offline backup mode.');
  }
  const sourcePaths = [config.memory.dbPath, ...sidecars, configPath, config.swarm.registryPath];
  const stable = useSqliteSnapshot ? stableRead([configPath, config.swarm.registryPath]) : stableRead(sourcePaths);
  const memoryContent = useSqliteSnapshot
    ? snapshotSqliteDatabase(config.memory.dbPath, backupRoot)
    : stable.get(config.memory.dbPath);
  if (config.memory.enabled && !memoryContent) {
    throw new Error(`Required memory database is missing: ${config.memory.dbPath}`);
  }
  const configContent = stable.get(configPath);
  if (!configContent) {
    throw new Error(`Required configuration is missing: ${configPath}`);
  }

  const result = exportStateBundleSnapshot({
    bundleDir: backupDir,
    files: [
      ...(memoryContent ? [{
        role: 'memory-db',
        content: memoryContent,
        bundlePath: BACKUP_BUNDLE_PATHS['memory-db'],
        required: config.memory.enabled,
      } as const] : []),
      ...(!useSqliteSnapshot && stable.has(sidecars[0]) ? [{
        role: 'memory-wal',
        content: stable.get(sidecars[0])!,
        bundlePath: BACKUP_BUNDLE_PATHS['memory-wal'],
        required: false,
      } as const] : []),
      ...(!useSqliteSnapshot && stable.has(sidecars[1]) ? [{
        role: 'memory-shm',
        content: stable.get(sidecars[1])!,
        bundlePath: BACKUP_BUNDLE_PATHS['memory-shm'],
        required: false,
      } as const] : []),
      {
        role: 'config',
        content: configContent,
        bundlePath: BACKUP_BUNDLE_PATHS.config,
        required: true,
      },
      ...(stable.has(config.swarm.registryPath) ? [{
        role: 'executor-registry',
        content: stable.get(config.swarm.registryPath)!,
        bundlePath: BACKUP_BUNDLE_PATHS['executor-registry'],
        required: false,
      } as const] : []),
    ],
  });
  return {
    backupDir: result.bundleDir,
    manifest: result.manifest,
    totalSizeBytes: result.totalSizeBytes,
  };
}

function defaultDestinations(
  config: ZouroborosConfig,
  configPath: string
): Partial<Record<StateBundleRole, string>> {
  return {
    'memory-db': config.memory.dbPath,
    'memory-wal': `${config.memory.dbPath}-wal`,
    'memory-shm': `${config.memory.dbPath}-shm`,
    config: configPath,
    'executor-registry': config.swarm.registryPath,
  };
}

function defaultAllowedRoots(destinations: Partial<Record<StateBundleRole, string>>): string[] {
  return [...new Set(
    Object.values(destinations)
      .filter((path): path is string => typeof path === 'string')
      .map((path) => dirname(resolve(path)))
  )];
}

function resolveRestoreOptions(
  options: RestoreBackupOptions
): {
  importOptions: StateBundleImportOptions;
  config?: ZouroborosConfig;
} {
  if (options.destinations) {
    const targetDirectories = options.targetDirectories ?? (options.config
      ? resolveRuntimeDirectories({
          configFile: options.configPath,
          overrides: {
            config: dirname(options.configPath ?? options.destinations.config ?? resolveRuntimeDirectories().configFile),
            workspace: options.config.core.workspaceRoot,
            data: options.config.core.dataDir,
            backups: getBackupDir(options.config),
          },
        })
      : undefined);
    return {
      importOptions: {
        destinations: options.destinations,
        allowedRoots: options.allowedRoots ?? defaultAllowedRoots(options.destinations),
        skipRoles: options.skipConfig ? ['config'] : [],
        dryRun: options.dryRun,
        configRelocation: targetDirectories ? {
          targetDirectories,
          pathMappings: options.configPathMappings,
        } : undefined,
      },
      config: options.config,
    };
  }
  const runtime = resolveRuntimeDirectories({ configFile: options.configPath });
  const configPath = options.configPath ?? runtime.configFile;
  const config = options.config ?? loadConfig(configPath);
  const destinations = options.destinations ?? defaultDestinations(config, configPath);
  const targetDirectories = options.targetDirectories ?? resolveRuntimeDirectories({
    configFile: configPath,
    overrides: {
      config: dirname(configPath),
      workspace: config.core.workspaceRoot,
      data: config.core.dataDir,
      backups: getBackupDir(config),
    },
  });
  return {
    importOptions: {
      destinations,
      allowedRoots: options.allowedRoots ?? defaultAllowedRoots(destinations),
      skipRoles: options.skipConfig ? ['config'] : [],
      dryRun: options.dryRun,
      configRelocation: {
        targetDirectories,
        pathMappings: options.configPathMappings,
      },
    },
    config,
  };
}

function readRawManifest(backupDir: string): unknown {
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${backupDir}. Not a valid backup.`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
}

function isPortableManifest(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { format?: unknown }).format === STATE_BUNDLE_FORMAT;
}

export function restoreBackup(backupDir: string, options: RestoreBackupOptions = {}): RestoreResult {
  const raw = readRawManifest(backupDir);
  if (!isPortableManifest(raw)) {
    throw new Error(
      'Legacy backup manifests cannot be restored implicitly. Use restoreLegacyBackup with explicit destinations and allowed roots.'
    );
  }
  const manifestRoles = new Set(
    Array.isArray((raw as { files?: unknown }).files)
      ? ((raw as { files: unknown[] }).files)
          .map((file) => typeof file === 'object' && file !== null ? (file as { role?: unknown }).role : undefined)
          .filter((role): role is string => typeof role === 'string')
      : []
  );
  const resolved = resolveRestoreOptions(options);
  const requiredRoles = new Set(options.requiredRoles ?? []);
  if (options.skipConfig) requiredRoles.delete('config');
  else requiredRoles.add('config');
  if (resolved.config?.memory.enabled === true || manifestRoles.has('memory-db')) {
    requiredRoles.add('memory-db');
  }
  resolved.importOptions.requiredRoles = [...requiredRoles];
  const result = importStateBundleWithRequiredSkips(
    backupDir,
    resolved.importOptions,
    options.skipConfig ? ['config'] : []
  );
  return {
    restoredFiles: result.importedFiles,
    skippedFiles: result.skippedRoles.map((role) => {
      const file = result.manifest.files.find((entry) => entry.role === role);
      return `${file?.name ?? role} (skipped)`;
    }),
    manifest: result.manifest,
  };
}

function parseLegacyManifest(raw: unknown): LegacyBackupManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Legacy backup manifest must be an object.');
  }
  const value = raw as Record<string, unknown>;
  const rootKeys = Object.keys(value).sort();
  const expectedRootKeys = ['createdAt', 'files', 'hostname', 'version'];
  if (rootKeys.length !== expectedRootKeys.length || rootKeys.some((key, index) => key !== expectedRootKeys[index])) {
    throw new Error('Legacy backup manifest contains missing or unsupported fields.');
  }
  if (
    value.version !== '2.0.0' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.hostname !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('Legacy backup manifest is malformed.');
  }
  const files = value.files.map((entry, index): LegacyBackupFile => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Legacy backup file ${index} is malformed.`);
    }
    const file = entry as Record<string, unknown>;
    const fileKeys = Object.keys(file).sort();
    const expectedFileKeys = ['name', 'originalPath', 'sizeBytes'];
    if (fileKeys.length !== expectedFileKeys.length || fileKeys.some((key, keyIndex) => key !== expectedFileKeys[keyIndex])) {
      throw new Error(`Legacy backup file ${index} contains missing or unsupported fields.`);
    }
    if (
      typeof file.name !== 'string' ||
      basename(file.name) !== file.name ||
      file.name.includes('\\') ||
      typeof file.originalPath !== 'string' ||
      !isAbsolute(file.originalPath) ||
      typeof file.sizeBytes !== 'number' ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      throw new Error(`Legacy backup file ${index} is malformed.`);
    }
    if (!LEGACY_NAME_ROLES[file.name]) {
      throw new Error(`Unsupported legacy backup file: ${file.name}`);
    }
    return {
      name: file.name,
      originalPath: file.originalPath,
      sizeBytes: file.sizeBytes,
    };
  });
  if (new Set(files.map(({ name }) => name)).size !== files.length) {
    throw new Error('Legacy backup contains duplicate file names.');
  }
  return {
    version: value.version,
    createdAt: value.createdAt,
    hostname: value.hostname,
    files,
  };
}

function readLegacyBackupFiles(backupDir: string): {
  manifest: LegacyBackupManifest;
  files: Array<{ role: StateBundleRole; required: boolean; content: Buffer }>;
} {
  const resolvedBackupDir = resolve(backupDir);
  if (
    !existsSync(resolvedBackupDir) ||
    !lstatSync(resolvedBackupDir).isDirectory() ||
    realpathSync(resolvedBackupDir) !== resolvedBackupDir
  ) {
    throw new Error(`Legacy backup directory is missing or uses a symbolic-link path: ${backupDir}`);
  }
  const manifestPath = join(resolvedBackupDir, 'manifest.json');
  if (
    !existsSync(manifestPath) ||
    lstatSync(manifestPath).isSymbolicLink() ||
    !lstatSync(manifestPath).isFile() ||
    realpathSync(manifestPath) !== manifestPath
  ) {
    throw new Error('Legacy backup manifest is missing or unsafe.');
  }
  const manifest = parseLegacyManifest(readRawManifest(resolvedBackupDir));
  const expectedNames = new Set(['manifest.json', ...manifest.files.map(({ name }) => name)]);
  const actualEntries = readdirSync(resolvedBackupDir, { withFileTypes: true });
  const unexpected = actualEntries
    .filter((entry) => !expectedNames.has(entry.name) || !entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length > 0 || actualEntries.length !== expectedNames.size) {
    throw new Error(`Legacy backup directory contains missing or unsupported entries: ${unexpected.join(', ') || 'manifest inventory mismatch'}`);
  }
  const files = manifest.files.map((file) => {
    const source = join(resolvedBackupDir, file.name);
    if (
      !existsSync(source) ||
      lstatSync(source).isSymbolicLink() ||
      !lstatSync(source).isFile() ||
      realpathSync(source) !== source
    ) {
      throw new Error(`Legacy backup file is missing or unsafe: ${file.name}`);
    }
    const before = statSync(source);
    const first = readFileSync(source);
    const middle = statSync(source);
    const second = readFileSync(source);
    const after = statSync(source);
    if (
      before.size !== file.sizeBytes ||
      middle.size !== file.sizeBytes ||
      after.size !== file.sizeBytes ||
      first.byteLength !== file.sizeBytes ||
      !first.equals(second) ||
      before.mtimeMs !== middle.mtimeMs ||
      middle.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`Legacy backup file size or contents changed during migration: ${file.name}`);
    }
    return {
      role: LEGACY_NAME_ROLES[file.name],
      required: file.name === 'config.json' || file.name === 'memory.db',
      content: first,
    };
  });
  return { manifest, files };
}

export function migrateLegacyBackup(backupDir: string, destinationDir: string): BackupResult {
  const legacy = readLegacyBackupFiles(backupDir);
  const migrated = exportStateBundleSnapshot({
    bundleDir: resolve(destinationDir),
    createdAt: legacy.manifest.createdAt,
    files: legacy.files.map((file) => ({
      ...file,
      bundlePath: BACKUP_BUNDLE_PATHS[file.role],
    })),
  });
  return {
    backupDir: migrated.bundleDir,
    manifest: migrated.manifest,
    totalSizeBytes: migrated.totalSizeBytes,
  };
}

export function restoreLegacyBackup(
  backupDir: string,
  options: RestoreLegacyBackupOptions
): RestoreResult {
  const legacy = readLegacyBackupFiles(backupDir);
  const manifest = legacy.manifest;
  const prepared = legacy.files;
  const roles = new Set(prepared.map(({ role }) => role));
  const resolved = resolveRestoreOptions(options);
  const requiredRoles = new Set(options.requiredRoles ?? []);
  if (options.skipConfig) requiredRoles.delete('config');
  else requiredRoles.add('config');
  if (resolved.config?.memory.enabled === true || roles.has('memory-db')) requiredRoles.add('memory-db');
  resolved.importOptions.requiredRoles = [...requiredRoles];
  const imported = importPreparedStateFiles(
    prepared,
    resolved.importOptions,
    options.skipConfig ? ['config'] : []
  );
  return {
    restoredFiles: imported.importedFiles,
    skippedFiles: imported.skippedRoles.map((role) => `${role} (skipped)`),
    manifest,
  };
}

export function listBackups(config?: ZouroborosConfig): {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
}[] {
  const backupRoot = getBackupDir(config);
  if (!existsSync(backupRoot)) return [];

  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => {
      const dir = join(backupRoot, entry.name);
      try {
        const raw = readRawManifest(dir) as { createdAt?: unknown; files?: unknown };
        if (typeof raw.createdAt !== 'string' || !Array.isArray(raw.files)) return null;
        const sizes = raw.files.map((file) =>
          typeof file === 'object' && file !== null ? (file as { sizeBytes?: unknown }).sizeBytes : undefined
        );
        if (sizes.some((size) => typeof size !== 'number')) return null;
        return {
          name: entry.name,
          path: dir,
          createdAt: raw.createdAt,
          sizeBytes: sizes.reduce<number>((sum, size) => sum + (size as number), 0),
          fileCount: raw.files.length,
        };
      } catch {
        return null;
      }
    })
    .filter((backup): backup is NonNullable<typeof backup> => backup !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.name.localeCompare(left.name));
}

export function pruneBackups(config?: ZouroborosConfig, keep: number = MAX_BACKUPS): number {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error('Backup retention count must be a non-negative integer.');
  }
  const backups = listBackups(config);
  const toRemove = backups.slice(keep);
  for (const backup of toRemove) {
    rmSync(backup.path, { recursive: true, force: true });
  }
  return toRemove.length;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
