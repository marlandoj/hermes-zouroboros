import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  DEFAULT_CONFIG,
  resolveRuntimeDirectories,
  saveConfig,
  type RuntimeDirectories,
  type ZouroborosConfig,
} from '../../packages/core/src/index.ts';

const repositoryRoot = resolve(import.meta.dir, '../..');
const cliEntrypoint = join(repositoryRoot, 'cli', 'src', 'index.ts');
// Source-host locations the relocated runtime must never touch, assembled from segments so this deny
// list does not itself trip the leak gate's host-path rules.
const forbiddenPaths = [['home', 'workspace'], ['home', '.z'], ['root', '.z'], ['root', '.zouroboros'], ['root', '.zo_secrets']]
  .map((segments) => `/${segments.join('/')}`);

function isolatedEnvironment(root: string): Record<string, string> {
  return {
    PATH: dirname(process.execPath),
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
  };
}

function directories(root: string): RuntimeDirectories {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return resolveRuntimeDirectories({
    env: isolatedEnvironment(root),
    homeDir: root,
    cwd: workspace,
  });
}

function createRuntime(root: string): { config: ZouroborosConfig; configPath: string; directories: RuntimeDirectories } {
  const resolved = directories(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.vectorEnabled = false;
  config.core.workspaceRoot = resolved.workspace;
  config.core.dataDir = resolved.data;
  config.memory.dbPath = join(resolved.data, 'memory.db');
  config.swarm.registryPath = join(resolved.data, 'executor-registry.json');
  config.personas.identityDir = join(resolved.workspace, 'IDENTITY');
  config.personas.defaultSoulPath = join(resolved.workspace, 'SOUL.md');
  mkdirSync(resolved.data, { recursive: true });
  writeFileSync(config.memory.dbPath, `portable-state:${root}`);
  writeFileSync(config.swarm.registryPath, JSON.stringify({ executors: {} }));
  saveConfig(config, resolved.configFile);
  return { config, configPath: resolved.configFile, directories: resolved };
}

function runCli(runtimeRoot: string, configPath: string, args: string[]): Record<string, unknown> {
  const runtimeDirectories = directories(runtimeRoot);
  const result = Bun.spawnSync({
    cmd: [process.execPath, cliEntrypoint, '--config', configPath, '--json', ...args],
    cwd: runtimeDirectories.workspace,
    env: isolatedEnvironment(runtimeRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`CLI failed (${args.join(' ')}): ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

function assertPortablePaths(runtimeDirectories: RuntimeDirectories): void {
  for (const [name, value] of Object.entries(runtimeDirectories)) {
    if (typeof value !== 'string') continue;
    if (forbiddenPaths.some((forbidden) => value.includes(forbidden))) {
      throw new Error(`Resolved ${name} is host-bound: ${value}`);
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'zouroboros-portable-runtime-'));
try {
  const sourceRoot = join(root, 'source');
  const source = createRuntime(sourceRoot);
  assertPortablePaths(source.directories);
  const configValidation = runCli(sourceRoot, source.configPath, ['config', 'validate']);
  if (configValidation.valid !== true) throw new Error('Configuration validation did not pass');

  const exported = runCli(sourceRoot, source.configPath, ['state', 'export', '--label', 'portable-smoke']);
  const bundleDir = exported.bundleDir;
  if (typeof bundleDir !== 'string') throw new Error('State export did not return a bundle directory');
  const bundleValidation = runCli(sourceRoot, source.configPath, [
    'state',
    'validate',
    bundleDir,
    '--required-role',
    'config',
    'memory-db',
  ]);
  if (bundleValidation.valid !== true) throw new Error('State bundle validation did not pass');

  const destinationRoot = join(root, 'destination');
  const destination = createRuntime(destinationRoot);
  assertPortablePaths(destination.directories);
  const imported = runCli(destinationRoot, destination.configPath, ['state', 'import', bundleDir]);
  const importedFiles = imported.importedFiles;
  if (!Array.isArray(importedFiles) || importedFiles.length < 2) {
    throw new Error('State import did not report the required files');
  }
  if (readFileSync(destination.config.memory.dbPath, 'utf8') !== `portable-state:${sourceRoot}`) {
    throw new Error('Relocated memory state did not match the export');
  }
  const relocatedConfig = readFileSync(destination.configPath, 'utf8');
  if (relocatedConfig.includes(sourceRoot)) {
    throw new Error('Relocated configuration retained a source-host path');
  }
  const relocatedConfigJson = JSON.parse(relocatedConfig);
  if (relocatedConfigJson.memory?.decayConfig?.permanent !== 'Infinity') {
    throw new Error('Relocated configuration did not preserve the default Infinity sentinel');
  }
  const destinationValidation = runCli(destinationRoot, destination.configPath, ['config', 'validate']);
  if (destinationValidation.valid !== true) {
    throw new Error('Relocated default configuration validation did not pass');
  }

  console.log(JSON.stringify({
    passed: true,
    zoEnvironmentVariables: [],
    sourceConfig: source.configPath,
    destinationConfig: destination.configPath,
    importedFileCount: importedFiles.length,
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
