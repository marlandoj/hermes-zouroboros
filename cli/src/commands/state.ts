import { Command } from 'commander';
import chalk from 'chalk';
import {
  createBackup,
  loadConfig,
  migrateStateBundle,
  resolveRuntimeDirectories,
  restoreBackup,
  validateStateBundle,
  type StateBundleRole,
} from 'zouroboros-core';

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function runtimeContext(command: Command) {
  const global = globalOptions(command);
  const configPath = resolveRuntimeDirectories({ configFile: global.config }).configFile;
  return { global, configPath, config: loadConfig(configPath) };
}

function print(command: Command, payload: unknown, message: string): void {
  if (globalOptions(command).json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.green(message));
}

export const stateCommand = new Command('state')
  .description('Export, validate, migrate, and import portable Zouroboros state')
  .addCommand(
    new Command('export')
      .description('Export configured state to a versioned portable bundle')
      .option('-l, --label <label>', 'Optional safe bundle label')
      .action((options, command) => {
        const { config, configPath } = runtimeContext(command);
        const result = createBackup({ config, configPath, label: options.label });
        print(command, {
          operation: 'export',
          bundleDir: result.backupDir,
          totalSizeBytes: result.totalSizeBytes,
          manifest: result.manifest,
        }, `State exported to ${result.backupDir}`);
      })
  )
  .addCommand(
    new Command('validate')
      .description('Validate a portable state bundle without writing destination state')
      .argument('<bundle-dir>', 'Absolute state bundle directory')
      .option('--required-role <roles...>', 'Roles that must exist in the bundle')
      .action((bundleDir: string, options, command) => {
        const result = validateStateBundle(bundleDir, {
          requiredRoles: options.requiredRole as StateBundleRole[] | undefined,
        });
        print(command, { operation: 'validate', valid: true, ...result }, `State bundle is valid: ${result.bundleDir}`);
      })
  )
  .addCommand(
    new Command('migrate')
      .description('Migrate a supported portable state bundle to the current schema')
      .argument('<source-bundle>', 'Absolute source bundle directory')
      .argument('<destination-bundle>', 'Absolute destination bundle directory')
      .action((sourceBundle: string, destinationBundle: string, _options, command) => {
        const result = migrateStateBundle(sourceBundle, destinationBundle);
        print(command, {
          operation: 'migrate',
          bundleDir: result.bundleDir,
          totalSizeBytes: result.totalSizeBytes,
          manifest: result.manifest,
        }, `State bundle migrated to ${result.bundleDir}`);
      })
  )
  .addCommand(
    new Command('import')
      .description('Validate and transactionally import a portable state bundle')
      .argument('<bundle-dir>', 'Absolute state bundle directory')
      .option('--dry-run', 'Validate and show destinations without writing')
      .option('--skip-config', 'Import state without replacing the selected configuration')
      .action((bundleDir: string, options, command) => {
        const { config, configPath } = runtimeContext(command);
        const result = restoreBackup(bundleDir, {
          config,
          configPath,
          dryRun: options.dryRun,
          skipConfig: options.skipConfig,
        });
        print(command, {
          operation: 'import',
          dryRun: Boolean(options.dryRun),
          importedFiles: result.restoredFiles,
          skippedFiles: result.skippedFiles,
          manifest: result.manifest,
        }, `${options.dryRun ? 'Validated import for' : 'Imported state from'} ${bundleDir}`);
      })
  );
