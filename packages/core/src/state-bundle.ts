import {
  existsSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path';
import { parseSerializedConfig, validateConfig } from './config/loader.js';
import type { RuntimeDirectories, ZouroborosConfig } from './types.js';

export const STATE_BUNDLE_FORMAT = 'zouroboros-state-bundle';
export const STATE_BUNDLE_SCHEMA_VERSION = '1.0.0';
export const LEGACY_PORTABLE_SCHEMA_VERSION = '0.1.0';
export const STATE_BUNDLE_MANIFEST = 'manifest.json';

export type StateBundleRole =
  | 'config'
  | 'memory-db'
  | 'memory-wal'
  | 'memory-shm'
  | 'executor-registry'
  | (string & {});

export interface StateBundleFile {
  role: StateBundleRole;
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  required: boolean;
}

export interface StateBundleManifest {
  format: typeof STATE_BUNDLE_FORMAT;
  schemaVersion: typeof STATE_BUNDLE_SCHEMA_VERSION;
  createdAt: string;
  files: StateBundleFile[];
}

export interface StateBundleExportFile {
  role: StateBundleRole;
  sourcePath: string;
  bundlePath: string;
  required: boolean;
}

export interface StateBundleExportOptions {
  bundleDir: string;
  files: StateBundleExportFile[];
  createdAt?: string;
}

export interface StateBundleExportResult {
  bundleDir: string;
  manifest: StateBundleManifest;
  totalSizeBytes: number;
}

export interface StateBundleValidationOptions {
  requiredRoles?: readonly StateBundleRole[];
}

export interface StateBundleValidationResult {
  bundleDir: string;
  manifest: StateBundleManifest;
  totalSizeBytes: number;
}

export interface StateBundleImportOptions extends StateBundleValidationOptions {
  destinations: Partial<Record<StateBundleRole, string>>;
  allowedRoots: readonly string[];
  skipRoles?: readonly StateBundleRole[];
  dryRun?: boolean;
  configRelocation?: StateBundleConfigRelocation;
}

export interface StateBundleConfigRelocation {
  targetDirectories: RuntimeDirectories;
  pathMappings?: Readonly<Record<string, string>>;
}

export interface StateBundleImportResult {
  importedFiles: string[];
  skippedRoles: StateBundleRole[];
  manifest: StateBundleManifest;
}

export interface LegacyPortableStateBundleFile {
  role: StateBundleRole;
  name: string;
  sizeBytes: number;
  checksum: string;
  required: boolean;
}

export interface LegacyPortableStateBundleManifest {
  format: typeof STATE_BUNDLE_FORMAT;
  schemaVersion: typeof LEGACY_PORTABLE_SCHEMA_VERSION;
  createdAt: string;
  files: LegacyPortableStateBundleFile[];
}

interface ValidatedFile {
  file: StateBundleFile;
  content: Buffer;
}

interface ValidatedDestinationFile extends ValidatedFile {
  destination: string;
  allowedRoot: string;
}

interface StateBundleSnapshotFile {
  role: StateBundleRole;
  bundlePath: string;
  required: boolean;
  content: Buffer;
}

export class StateBundleError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'StateBundleError';
  }
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new StateBundleError(
      `${context} contains unsupported fields: ${unexpected.sort().join(', ')}`,
      'INVALID_MANIFEST'
    );
  }
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) {
    throw new StateBundleError('createdAt must be an ISO-8601 timestamp', 'INVALID_MANIFEST');
  }
}

function assertRole(value: unknown): asserts value is StateBundleRole {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new StateBundleError(`Invalid state file role: ${String(value)}`, 'INVALID_ROLE');
  }
}

function assertSafeBundlePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === STATE_BUNDLE_MANIFEST ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value.startsWith('../') ||
    value.includes('/../')
  ) {
    throw new StateBundleError(`Unsafe bundle path: ${String(value)}`, 'PATH_TRAVERSAL');
  }
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new StateBundleError('State file SHA-256 digest is malformed', 'INVALID_MANIFEST');
  }
}

function assertSize(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StateBundleError('State file sizeBytes must be a non-negative integer', 'INVALID_MANIFEST');
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new StateBundleError(`Symbolic links are not allowed in state paths: ${current}`, 'SYMLINK_ESCAPE');
    }
  }
}

function assertExistingPathIsCanonical(path: string): void {
  if (existsSync(path) && realpathSync(path) !== resolve(path)) {
    throw new StateBundleError(`Path resolves through a symbolic link: ${path}`, 'SYMLINK_ESCAPE');
  }
}

function assertRegularFile(path: string): void {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) {
    throw new StateBundleError(`Required state file is missing: ${path}`, 'MISSING_FILE');
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new StateBundleError(`State path is not a regular file: ${path}`, 'INVALID_FILE');
  }
}

function containedPath(root: string, child: string): string {
  const absoluteRoot = resolve(root);
  const absoluteChild = resolve(child);
  const fromRoot = relative(absoluteRoot, absoluteChild);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new StateBundleError(`Path escapes its allowed root: ${child}`, 'PATH_TRAVERSAL');
  }
  return absoluteChild;
}

function assertRolePolicy(
  options: StateBundleImportOptions,
  files: readonly ValidatedFile[],
  allowedRequiredSkips: readonly StateBundleRole[] = []
): void {
  const required = new Set(options.requiredRoles ?? []);
  for (const { file } of files) {
    if (file.required) required.add(file.role);
  }
  const allowed = new Set(allowedRequiredSkips);
  const overlap = [...new Set(options.skipRoles ?? [])].filter((role) => required.has(role));
  const forbidden = overlap.filter((role) => !allowed.has(role));
  if (forbidden.length > 0) {
    throw new StateBundleError(
      `Roles cannot be both required and skipped: ${forbidden.sort().join(', ')}`,
      'CONFLICTING_ROLE_POLICY'
    );
  }
}

function parseManifest(raw: unknown): StateBundleManifest {
  if (!isPlainObject(raw)) {
    throw new StateBundleError('State bundle manifest must be an object', 'INVALID_MANIFEST');
  }
  assertExactKeys(raw, ['format', 'schemaVersion', 'createdAt', 'files'], 'State bundle manifest');
  if (raw.format !== STATE_BUNDLE_FORMAT) {
    throw new StateBundleError('Unsupported state bundle format', 'INVALID_MANIFEST');
  }
  if (raw.schemaVersion !== STATE_BUNDLE_SCHEMA_VERSION) {
    throw new StateBundleError(
      `Unsupported state bundle schema version: ${String(raw.schemaVersion)}`,
      'UNSUPPORTED_SCHEMA'
    );
  }
  assertIsoTimestamp(raw.createdAt);
  if (!Array.isArray(raw.files)) {
    throw new StateBundleError('State bundle files must be an array', 'INVALID_MANIFEST');
  }

  const roles = new Set<string>();
  const paths = new Set<string>();
  const files = raw.files.map((item, index): StateBundleFile => {
    if (!isPlainObject(item)) {
      throw new StateBundleError(`State file ${index} must be an object`, 'INVALID_MANIFEST');
    }
    assertExactKeys(item, ['role', 'path', 'name', 'sizeBytes', 'sha256', 'required'], `State file ${index}`);
    assertRole(item.role);
    assertSafeBundlePath(item.path);
    if (typeof item.name !== 'string' || item.name !== basename(item.path)) {
      throw new StateBundleError(`State file ${index} name must equal its path basename`, 'INVALID_MANIFEST');
    }
    assertSize(item.sizeBytes);
    assertDigest(item.sha256);
    if (typeof item.required !== 'boolean') {
      throw new StateBundleError(`State file ${index} required must be boolean`, 'INVALID_MANIFEST');
    }
    if (roles.has(item.role)) {
      throw new StateBundleError(`Duplicate state role: ${item.role}`, 'DUPLICATE_ROLE');
    }
    if (paths.has(item.path)) {
      throw new StateBundleError(`Duplicate bundle path: ${item.path}`, 'DUPLICATE_PATH');
    }
    roles.add(item.role);
    paths.add(item.path);
    return {
      role: item.role,
      path: item.path,
      name: item.name,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      required: item.required,
    };
  });

  return {
    format: STATE_BUNDLE_FORMAT,
    schemaVersion: STATE_BUNDLE_SCHEMA_VERSION,
    createdAt: raw.createdAt,
    files,
  };
}

function readManifestFile(bundleDir: string): unknown {
  if (!isAbsolute(bundleDir)) {
    throw new StateBundleError('State bundle directory must be absolute', 'INVALID_BUNDLE_ROOT');
  }
  assertNoSymlinkComponents(bundleDir);
  if (!existsSync(bundleDir) || !lstatSync(bundleDir).isDirectory()) {
    throw new StateBundleError(`State bundle directory does not exist: ${bundleDir}`, 'MISSING_BUNDLE');
  }
  const manifestPath = join(bundleDir, STATE_BUNDLE_MANIFEST);
  assertRegularFile(manifestPath);
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new StateBundleError(
      `State bundle manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_MANIFEST'
    );
  }
}

function validateConfigContent(file: StateBundleFile, content: Buffer): void {
  if (file.role !== 'config') return;
  try {
    parseSerializedConfig(JSON.parse(content.toString('utf8')) as unknown);
  } catch (error) {
    throw new StateBundleError(
      `Bundled configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CONFIG'
    );
  }
}

function mapConfiguredAbsolutePath(
  sourcePath: string,
  mappings: readonly { source: string; target: string }[],
  label: string
): string {
  if (!isAbsolute(sourcePath)) {
    throw new StateBundleError(`${label} must be absolute before relocation`, 'INVALID_CONFIG');
  }
  for (const mapping of mappings) {
    const fromSource = relative(mapping.source, sourcePath);
    if (fromSource === '' || (!fromSource.startsWith(`..${sep}`) && fromSource !== '..' && !isAbsolute(fromSource))) {
      return resolve(mapping.target, fromSource);
    }
  }
  throw new StateBundleError(
    `Bundled configuration path cannot be mapped to the target runtime: ${label}=${sourcePath}`,
    'UNMAPPABLE_CONFIG_PATH'
  );
}

function relocateConfigContent(
  content: Buffer,
  options: StateBundleImportOptions
): Buffer {
  const relocation = options.configRelocation;
  if (!relocation) {
    throw new StateBundleError(
      'Importing a configuration role requires explicit target runtime directories',
      'CONFIG_RELOCATION_REQUIRED'
    );
  }
  let config: ZouroborosConfig;
  try {
    config = parseSerializedConfig(JSON.parse(content.toString('utf8')) as unknown);
  } catch (error) {
    throw new StateBundleError(
      `Bundled configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CONFIG'
    );
  }

  const target = relocation.targetDirectories;
  const explicitMappings = Object.entries(relocation.pathMappings ?? {}).map(([source, destination]) => {
    if (!isAbsolute(source) || !isAbsolute(destination)) {
      throw new StateBundleError('Configuration path mappings must use absolute paths', 'INVALID_CONFIG_MAPPING');
    }
    return { source: resolve(source), target: resolve(destination) };
  });
  const mappings = [
    ...explicitMappings,
    { source: resolve(config.core.workspaceRoot), target: target.workspace },
    { source: resolve(config.core.dataDir), target: target.data },
  ].sort((left, right) => right.source.length - left.source.length);

  config.core.workspaceRoot = target.workspace;
  config.core.dataDir = target.data;
  config.memory.dbPath = options.destinations['memory-db']
    ? resolve(options.destinations['memory-db']!)
    : mapConfiguredAbsolutePath(config.memory.dbPath, mappings, 'memory.dbPath');
  config.swarm.registryPath = options.destinations['executor-registry']
    ? resolve(options.destinations['executor-registry']!)
    : mapConfiguredAbsolutePath(config.swarm.registryPath, mappings, 'swarm.registryPath');
  config.personas.identityDir = mapConfiguredAbsolutePath(
    config.personas.identityDir,
    mappings,
    'personas.identityDir'
  );
  config.personas.defaultSoulPath = mapConfiguredAbsolutePath(
    config.personas.defaultSoulPath,
    mappings,
    'personas.defaultSoulPath'
  );
  for (const [name, reference] of Object.entries(config.core.secretReferences)) {
    if (reference.kind === 'file') {
      reference.path = mapConfiguredAbsolutePath(reference.path, mappings, `core.secretReferences.${name}.path`);
    }
  }

  try {
    config = validateConfig(config);
  } catch (error) {
    throw new StateBundleError(
      `Relocated configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_RELOCATED_CONFIG'
    );
  }
  return Buffer.from(JSON.stringify(config, (_key, value) => value === Infinity ? 'Infinity' : value, 2));
}

function relocateConfigFiles(
  files: readonly ValidatedFile[],
  options: StateBundleImportOptions
): ValidatedFile[] {
  const skipped = new Set(options.skipRoles ?? []);
  return files.map((entry) => {
    if (entry.file.role !== 'config' || skipped.has('config')) return entry;
    return { ...entry, content: relocateConfigContent(entry.content, options) };
  });
}

function validateCurrentBundle(
  bundleDir: string,
  options: StateBundleValidationOptions = {}
): { manifest: StateBundleManifest; files: ValidatedFile[] } {
  const root = resolve(bundleDir);
  const manifest = parseManifest(readManifestFile(root));
  const requiredRoles = new Set(options.requiredRoles ?? []);
  for (const file of manifest.files) {
    if (file.required) requiredRoles.add(file.role);
  }
  for (const role of requiredRoles) {
    if (!manifest.files.some((file) => file.role === role)) {
      throw new StateBundleError(`Required state role is missing: ${role}`, 'MISSING_ROLE');
    }
  }

  const files = manifest.files.map((file): ValidatedFile => {
    const sourcePath = containedPath(root, join(root, file.path));
    assertRegularFile(sourcePath);
    const content = readFileSync(sourcePath);
    if (content.byteLength !== file.sizeBytes) {
      throw new StateBundleError(`Size mismatch for ${file.path}`, 'SIZE_MISMATCH');
    }
    if (sha256(content) !== file.sha256) {
      throw new StateBundleError(`Checksum mismatch for ${file.path}`, 'CHECKSUM_MISMATCH');
    }
    validateConfigContent(file, content);
    return { file, content };
  });
  return { manifest, files };
}

function validateExportFiles(files: readonly StateBundleExportFile[]): ValidatedFile[] {
  const roles = new Set<string>();
  const paths = new Set<string>();
  const validated: ValidatedFile[] = [];
  for (const input of files) {
    assertRole(input.role);
    assertSafeBundlePath(input.bundlePath);
    if (!isAbsolute(input.sourcePath)) {
      throw new StateBundleError(`Source path must be absolute: ${input.sourcePath}`, 'INVALID_SOURCE_PATH');
    }
    if (roles.has(input.role)) {
      throw new StateBundleError(`Duplicate state role: ${input.role}`, 'DUPLICATE_ROLE');
    }
    if (paths.has(input.bundlePath)) {
      throw new StateBundleError(`Duplicate bundle path: ${input.bundlePath}`, 'DUPLICATE_PATH');
    }
    roles.add(input.role);
    paths.add(input.bundlePath);
    if (!existsSync(input.sourcePath)) {
      if (input.required) {
        throw new StateBundleError(`Required state file is missing: ${input.sourcePath}`, 'MISSING_FILE');
      }
      continue;
    }
    assertRegularFile(input.sourcePath);
    const content = readFileSync(input.sourcePath);
    const file: StateBundleFile = {
      role: input.role,
      path: input.bundlePath,
      name: basename(input.bundlePath),
      sizeBytes: content.byteLength,
      sha256: sha256(content),
      required: input.required,
    };
    validated.push({ file, content });
  }
  return validated.sort(
    (left, right) => left.file.role.localeCompare(right.file.role) || left.file.path.localeCompare(right.file.path)
  );
}

function validateSnapshotFiles(files: readonly StateBundleSnapshotFile[]): ValidatedFile[] {
  const roles = new Set<string>();
  const paths = new Set<string>();
  const validated = files.map((input): ValidatedFile => {
    assertRole(input.role);
    assertSafeBundlePath(input.bundlePath);
    if (roles.has(input.role)) {
      throw new StateBundleError(`Duplicate state role: ${input.role}`, 'DUPLICATE_ROLE');
    }
    if (paths.has(input.bundlePath)) {
      throw new StateBundleError(`Duplicate bundle path: ${input.bundlePath}`, 'DUPLICATE_PATH');
    }
    roles.add(input.role);
    paths.add(input.bundlePath);
    return {
      file: {
        role: input.role,
        path: input.bundlePath,
        name: basename(input.bundlePath),
        sizeBytes: input.content.byteLength,
        sha256: sha256(input.content),
        required: input.required,
      },
      content: Buffer.from(input.content),
    };
  });
  return validated.sort(
    (left, right) => left.file.role.localeCompare(right.file.role) || left.file.path.localeCompare(right.file.path)
  );
}

function writeExclusiveFile(path: string, content: Uint8Array): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function writeBundleSnapshot(
  bundleDirValue: string,
  files: readonly ValidatedFile[],
  createdAtValue?: string
): StateBundleExportResult {
  if (!isAbsolute(bundleDirValue)) {
    throw new StateBundleError('State bundle directory must be absolute', 'INVALID_BUNDLE_ROOT');
  }
  const bundleDir = resolve(bundleDirValue);
  if (existsSync(bundleDir)) {
    throw new StateBundleError(`State bundle destination already exists: ${bundleDir}`, 'DESTINATION_EXISTS');
  }
  const parent = dirname(bundleDir);
  assertNoSymlinkComponents(parent);
  const createdAt = createdAtValue ?? new Date().toISOString();
  assertIsoTimestamp(createdAt);
  const manifest: StateBundleManifest = {
    format: STATE_BUNDLE_FORMAT,
    schemaVersion: STATE_BUNDLE_SCHEMA_VERSION,
    createdAt,
    files: files.map(({ file }) => file),
  };

  const stagingDir = `${bundleDir}.tmp-${randomUUID()}`;
  try {
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(stagingDir);
    assertExistingPathIsCanonical(stagingDir);
    for (const { file, content } of files) {
      const destination = containedPath(stagingDir, join(stagingDir, file.path));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      assertNoSymlinkComponents(dirname(destination));
      assertExistingPathIsCanonical(dirname(destination));
      writeExclusiveFile(destination, content);
    }
    writeExclusiveFile(
      join(stagingDir, STATE_BUNDLE_MANIFEST),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    );
    assertNoSymlinkComponents(parent);
    assertExistingPathIsCanonical(parent);
    if (existsSync(bundleDir)) {
      throw new StateBundleError(`State bundle destination appeared during export: ${bundleDir}`, 'DESTINATION_EXISTS');
    }
    renameSync(stagingDir, bundleDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return {
    bundleDir,
    manifest,
    totalSizeBytes: files.reduce((sum, { file }) => sum + file.sizeBytes, 0),
  };
}

export function exportStateBundleSnapshot(options: {
  bundleDir: string;
  files: readonly StateBundleSnapshotFile[];
  createdAt?: string;
}): StateBundleExportResult {
  return writeBundleSnapshot(options.bundleDir, validateSnapshotFiles(options.files), options.createdAt);
}

export function exportStateBundle(options: StateBundleExportOptions): StateBundleExportResult {
  const files = validateExportFiles(options.files);
  return writeBundleSnapshot(options.bundleDir, files, options.createdAt);
}

export function validateStateBundle(
  bundleDir: string,
  options: StateBundleValidationOptions = {}
): StateBundleValidationResult {
  const validated = validateCurrentBundle(bundleDir, options);
  return {
    bundleDir: resolve(bundleDir),
    manifest: validated.manifest,
    totalSizeBytes: validated.files.reduce((sum, { file }) => sum + file.sizeBytes, 0),
  };
}

function validateDestinations(
  files: readonly ValidatedFile[],
  options: StateBundleImportOptions
): ValidatedDestinationFile[] {
  if (options.allowedRoots.length === 0) {
    throw new StateBundleError('At least one allowed destination root is required', 'MISSING_ALLOWED_ROOT');
  }
  const roots = options.allowedRoots.map((root) => {
    if (!isAbsolute(root)) {
      throw new StateBundleError(`Allowed root must be absolute: ${root}`, 'INVALID_DESTINATION');
    }
    assertNoSymlinkComponents(root);
    return resolve(root);
  });
  const skipRoles = new Set(options.skipRoles ?? []);
  const destinations = new Set<string>();
  const planned: ValidatedDestinationFile[] = [];

  for (const entry of files) {
    if (skipRoles.has(entry.file.role)) continue;
    const destinationValue = options.destinations[entry.file.role];
    if (!destinationValue) {
      if (entry.file.required || options.requiredRoles?.includes(entry.file.role)) {
        throw new StateBundleError(
          `No destination supplied for required role: ${entry.file.role}`,
          'MISSING_DESTINATION'
        );
      }
      continue;
    }
    if (!isAbsolute(destinationValue)) {
      throw new StateBundleError(`Destination must be absolute: ${destinationValue}`, 'INVALID_DESTINATION');
    }
    const destination = resolve(destinationValue);
    const allowedRoot = roots.find((root) => {
      try {
        containedPath(root, destination);
        return true;
      } catch {
        return false;
      }
    });
    if (!allowedRoot) {
      throw new StateBundleError(`Destination is outside allowed roots: ${destination}`, 'PATH_TRAVERSAL');
    }
    assertNoSymlinkComponents(destination);
    if (existsSync(destination) && !lstatSync(destination).isFile()) {
      throw new StateBundleError(`Destination is not a regular file: ${destination}`, 'INVALID_DESTINATION');
    }
    if (destinations.has(destination)) {
      throw new StateBundleError(`Multiple roles target the same destination: ${destination}`, 'DUPLICATE_DESTINATION');
    }
    destinations.add(destination);
    planned.push({ ...entry, destination, allowedRoot });
  }
  return planned;
}

function assertDestinationBoundary(destination: string, allowedRoot: string): void {
  containedPath(allowedRoot, destination);
  assertNoSymlinkComponents(allowedRoot);
  assertNoSymlinkComponents(dirname(destination));
  assertExistingPathIsCanonical(allowedRoot);
  assertExistingPathIsCanonical(dirname(destination));
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new StateBundleError(`Destination became a symbolic link: ${destination}`, 'SYMLINK_ESCAPE');
  }
}

function createDestinationDirectory(path: string, createdDirectories: string[]): void {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertNoSymlinkComponents(current);
  for (const directory of missing.reverse()) {
    assertNoSymlinkComponents(dirname(directory));
    mkdirSync(directory, { mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      throw new StateBundleError(`Destination directory is unsafe: ${directory}`, 'SYMLINK_ESCAPE');
    }
    createdDirectories.push(directory);
  }
}

function writeStateFilesTransactionally(files: readonly ValidatedDestinationFile[]): string[] {
  const transactionId = randomUUID();
  const staged: Array<{
    destination: string;
    temporary: string;
    allowedRoot: string;
    previous?: string;
  }> = [];
  const committed: typeof staged = [];
  const createdDirectories: string[] = [];
  try {
    for (const file of files) {
      const parent = dirname(file.destination);
      createDestinationDirectory(parent, createdDirectories);
      assertDestinationBoundary(file.destination, file.allowedRoot);
      const temporary = join(parent, `.${basename(file.destination)}.zouroboros-${transactionId}.tmp`);
      writeExclusiveFile(temporary, file.content);
      staged.push({
        destination: file.destination,
        temporary,
        allowedRoot: file.allowedRoot,
      });
    }
    for (const item of staged) {
      assertDestinationBoundary(item.destination, item.allowedRoot);
      if (existsSync(item.destination)) {
        item.previous = `${item.destination}.zouroboros-${transactionId}.bak`;
        if (existsSync(item.previous)) {
          throw new StateBundleError(`Rollback path already exists: ${item.previous}`, 'TRANSACTION_CONFLICT');
        }
        renameSync(item.destination, item.previous);
      }
      assertDestinationBoundary(item.destination, item.allowedRoot);
      renameSync(item.temporary, item.destination);
      committed.push(item);
    }
    for (const item of committed) {
      if (item.previous) {
        try {
          rmSync(item.previous, { force: true });
        } catch {
          // The imported state is committed; retain the rollback copy if cleanup is unavailable.
        }
      }
    }
    return committed.map((item) => item.destination);
  } catch (error) {
    for (const item of [...committed].reverse()) {
      rmSync(item.destination, { force: true });
      if (item.previous && existsSync(item.previous)) renameSync(item.previous, item.destination);
    }
    for (const item of staged) {
      rmSync(item.temporary, { force: true });
      if (item.previous && existsSync(item.previous) && !existsSync(item.destination)) {
        renameSync(item.previous, item.destination);
      }
    }
    for (const directory of [...createdDirectories].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // A concurrently created entry prevents unsafe recursive cleanup.
      }
    }
    throw error;
  }
}

export function importStateBundle(
  bundleDir: string,
  options: StateBundleImportOptions
): StateBundleImportResult {
  return importStateBundleWithRequiredSkips(bundleDir, options);
}

export function importStateBundleWithRequiredSkips(
  bundleDir: string,
  options: StateBundleImportOptions,
  allowedRequiredSkips: readonly StateBundleRole[] = []
): StateBundleImportResult {
  const validated = validateCurrentBundle(bundleDir, options);
  assertRolePolicy(options, validated.files, allowedRequiredSkips);
  const relocatedFiles = relocateConfigFiles(validated.files, options);
  const planned = validateDestinations(relocatedFiles, options);
  const skipRoles = new Set(options.skipRoles ?? []);
  const plannedRoles = new Set(planned.map(({ file }) => file.role));
  const skippedRoles = validated.files
    .map(({ file }) => file.role)
    .filter((role) => skipRoles.has(role) || !plannedRoles.has(role));
  const importedFiles = options.dryRun
    ? planned.map(({ destination }) => destination)
    : writeStateFilesTransactionally(planned);
  return { importedFiles, skippedRoles, manifest: validated.manifest };
}

export function importPreparedStateFiles(
  files: readonly { role: StateBundleRole; required: boolean; content: Buffer }[],
  options: StateBundleImportOptions,
  allowedRequiredSkips: readonly StateBundleRole[] = []
): { importedFiles: string[]; skippedRoles: StateBundleRole[] } {
  const roles = new Set<string>();
  const validated = files.map((entry): ValidatedFile => {
    assertRole(entry.role);
    if (roles.has(entry.role)) {
      throw new StateBundleError(`Duplicate state role: ${entry.role}`, 'DUPLICATE_ROLE');
    }
    roles.add(entry.role);
    const file: StateBundleFile = {
      role: entry.role,
      path: `legacy/${entry.role}`,
      name: entry.role,
      sizeBytes: entry.content.byteLength,
      sha256: sha256(entry.content),
      required: entry.required,
    };
    validateConfigContent(file, entry.content);
    return { file, content: entry.content };
  });
  for (const role of options.requiredRoles ?? []) {
    if (!roles.has(role)) {
      throw new StateBundleError(`Required state role is missing: ${role}`, 'MISSING_ROLE');
    }
  }
  assertRolePolicy(options, validated, allowedRequiredSkips);
  const relocatedFiles = relocateConfigFiles(validated, options);
  const planned = validateDestinations(relocatedFiles, options);
  const skipRoles = new Set(options.skipRoles ?? []);
  const plannedRoles = new Set(planned.map(({ file }) => file.role));
  const skippedRoles = validated
    .map(({ file }) => file.role)
    .filter((role) => skipRoles.has(role) || !plannedRoles.has(role));
  const importedFiles = options.dryRun
    ? planned.map(({ destination }) => destination)
    : writeStateFilesTransactionally(planned);
  return { importedFiles, skippedRoles };
}

function parseLegacyPortableManifest(raw: unknown): LegacyPortableStateBundleManifest {
  if (!isPlainObject(raw)) {
    throw new StateBundleError('Legacy portable manifest must be an object', 'INVALID_MANIFEST');
  }
  assertExactKeys(raw, ['format', 'schemaVersion', 'createdAt', 'files'], 'Legacy portable manifest');
  if (raw.format !== STATE_BUNDLE_FORMAT || raw.schemaVersion !== LEGACY_PORTABLE_SCHEMA_VERSION) {
    throw new StateBundleError('Unsupported source schema for migration', 'UNSUPPORTED_SCHEMA');
  }
  assertIsoTimestamp(raw.createdAt);
  if (!Array.isArray(raw.files)) {
    throw new StateBundleError('Legacy portable files must be an array', 'INVALID_MANIFEST');
  }
  const roles = new Set<string>();
  const names = new Set<string>();
  const files = raw.files.map((item, index): LegacyPortableStateBundleFile => {
    if (!isPlainObject(item)) {
      throw new StateBundleError(`Legacy portable file ${index} must be an object`, 'INVALID_MANIFEST');
    }
    assertExactKeys(item, ['role', 'name', 'sizeBytes', 'checksum', 'required'], `Legacy portable file ${index}`);
    assertRole(item.role);
    assertSafeBundlePath(item.name);
    assertSize(item.sizeBytes);
    assertDigest(item.checksum);
    if (typeof item.required !== 'boolean') {
      throw new StateBundleError(`Legacy portable file ${index} required must be boolean`, 'INVALID_MANIFEST');
    }
    if (roles.has(item.role) || names.has(item.name)) {
      throw new StateBundleError('Legacy portable roles and names must be unique', 'DUPLICATE_ROLE');
    }
    roles.add(item.role);
    names.add(item.name);
    return {
      role: item.role,
      name: item.name,
      sizeBytes: item.sizeBytes,
      checksum: item.checksum,
      required: item.required,
    };
  });
  return {
    format: STATE_BUNDLE_FORMAT,
    schemaVersion: LEGACY_PORTABLE_SCHEMA_VERSION,
    createdAt: raw.createdAt,
    files,
  };
}

export function migrateStateBundle(sourceBundleDir: string, destinationBundleDir: string): StateBundleExportResult {
  const raw = readManifestFile(sourceBundleDir);
  if (isPlainObject(raw) && raw.schemaVersion === STATE_BUNDLE_SCHEMA_VERSION) {
    const current = validateCurrentBundle(sourceBundleDir);
    return writeBundleSnapshot(destinationBundleDir, current.files, current.manifest.createdAt);
  }

  const legacy = parseLegacyPortableManifest(raw);
  const sourceRoot = resolve(sourceBundleDir);
  const migratedFiles = legacy.files.map((file): ValidatedFile => {
    const sourcePath = containedPath(sourceRoot, join(sourceRoot, file.name));
    assertRegularFile(sourcePath);
    const content = readFileSync(sourcePath);
    if (content.byteLength !== file.sizeBytes || sha256(content) !== file.checksum) {
      throw new StateBundleError(`Legacy portable file failed integrity validation: ${file.name}`, 'CHECKSUM_MISMATCH');
    }
    validateConfigContent({
      role: file.role,
      path: file.name,
      name: basename(file.name),
      sizeBytes: file.sizeBytes,
      sha256: file.checksum,
      required: file.required,
    }, content);
    return {
      file: {
        role: file.role,
        path: file.name,
        name: basename(file.name),
        sizeBytes: content.byteLength,
        sha256: sha256(content),
        required: file.required,
      },
      content,
    };
  });
  return writeBundleSnapshot(destinationBundleDir, migratedFiles, legacy.createdAt);
}
