import { Command } from 'commander';
import chalk from 'chalk';
import {
  createBackup,
  formatBytes,
  listBackups,
  loadConfig,
  migrateLegacyBackup,
  pruneBackups,
  resolveRuntimeDirectories,
  restoreBackup,
} from 'zouroboros-core';

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

function context(command: Command) {
  const global = command.optsWithGlobals() as GlobalOptions;
  const configPath = resolveRuntimeDirectories({ configFile: global.config }).configFile;
  return { global, configPath, config: loadConfig(configPath) };
}

export const backupCommand = new Command('backup')
  .description('Backup and restore Zouroboros data')
  .addCommand(
    new Command('create')
      .description('Create a new backup of memory DB, config, and registry')
      .option('-l, --label <label>', 'Optional label for the backup')
      .action((options, command) => {
        const { global, configPath, config } = context(command);
        const result = createBackup({ config, configPath, label: options.label });
        const output = {
          created: true,
          backupDir: result.backupDir,
          manifest: result.manifest,
          totalSizeBytes: result.totalSizeBytes,
        };
        if (global.json) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }
        console.log(chalk.green('\nBackup created successfully\n'));
        console.log(`  Location: ${chalk.cyan(result.backupDir)}`);
        console.log(`  Files:    ${result.manifest.files.length}`);
        console.log(`  Size:     ${formatBytes(result.totalSizeBytes)}\n`);
      })
  )
  .addCommand(
    new Command('migrate-legacy')
      .description('Convert a legacy backup into a portable state bundle without importing it')
      .argument('<source>', 'Legacy backup directory')
      .argument('<destination>', 'New portable state-bundle directory')
      .action((source: string, destination: string, _options, command) => {
        const global = command.optsWithGlobals() as GlobalOptions;
        const result = migrateLegacyBackup(source, destination);
        const output = {
          migrated: true,
          bundleDir: result.backupDir,
          manifest: result.manifest,
          totalSizeBytes: result.totalSizeBytes,
        };
        if (global.json) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }
        console.log(chalk.green(`Converted legacy backup to ${result.backupDir}`));
      })
  )
  .addCommand(
    new Command('restore')
      .description('Restore from a portable backup')
      .argument('<name>', 'Backup name or absolute path')
      .option('--dry-run', 'Show what would be restored without making changes')
      .option('--skip-config', 'Skip restoring the config file')
      .action((name: string, options, command) => {
        const { global, configPath, config } = context(command);
        const match = listBackups(config).find((backup) => backup.name === name);
        const backupDir = match?.path ?? name;
        const result = restoreBackup(backupDir, {
          config,
          configPath,
          dryRun: options.dryRun,
          skipConfig: options.skipConfig,
        });
        const output = {
          restored: !options.dryRun,
          dryRun: Boolean(options.dryRun),
          restoredFiles: result.restoredFiles,
          skippedFiles: result.skippedFiles,
          manifest: result.manifest,
        };
        if (global.json) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }
        console.log(chalk.green(`\n${options.dryRun ? 'Would restore' : 'Restored'} ${result.restoredFiles.length} file(s)\n`));
      })
  )
  .addCommand(
    new Command('list')
      .description('List available backups')
      .alias('ls')
      .action((_options, command) => {
        const { global, config } = context(command);
        const backups = listBackups(config);
        if (global.json) {
          console.log(JSON.stringify({ backups }, null, 2));
          return;
        }
        if (backups.length === 0) {
          console.log(chalk.yellow('\nNo backups found.\n'));
          return;
        }
        for (const backup of backups) {
          console.log(`${backup.name}  ${backup.createdAt}  ${formatBytes(backup.sizeBytes)}`);
        }
      })
  )
  .addCommand(
    new Command('prune')
      .description('Remove old backups, keeping the most recent N')
      .option('-k, --keep <count>', 'Number of backups to keep', '10')
      .action((options, command) => {
        const { global, config } = context(command);
        const keep = Number.parseInt(options.keep, 10);
        if (!Number.isInteger(keep) || keep < 1) {
          throw new Error('--keep must be a positive integer');
        }
        const pruned = pruneBackups(config, keep);
        if (global.json) {
          console.log(JSON.stringify({ pruned, kept: keep }, null, 2));
          return;
        }
        console.log(chalk.green(`Pruned ${pruned} old backup(s); kept ${keep}`));
      })
  );
