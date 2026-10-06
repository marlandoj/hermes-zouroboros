import { Command } from 'commander';
import chalk from 'chalk';
import {
  getConfigValue,
  loadConfig,
  resolveRuntimeDirectories,
  saveConfig,
  setConfigValue,
} from 'zouroboros-core';

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function selectedConfigPath(command: Command): string {
  return resolveRuntimeDirectories({ configFile: globalOptions(command).config }).configFile;
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function assertConfigKey(key: string): void {
  const parts = key.split('.');
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(part)) ||
    parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
  ) {
    throw new Error(`Invalid configuration key: ${key}`);
  }
}

export const configCommand = new Command('config')
  .description('Manage Zouroboros configuration')
  .addCommand(
    new Command('validate')
      .description('Validate configuration, required capabilities, and secret references')
      .option('--available-capability <ids...>', 'Capabilities available on this host')
      .action((options, command) => {
        const configPath = selectedConfigPath(command);
        const config = loadConfig({
          configPath,
          availableCapabilities: options.availableCapability,
        });
        const result = {
          valid: true,
          configPath,
          version: config.version,
          requiredCapabilities: config.core.requiredCapabilities,
        };
        if (globalOptions(command).json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Configuration is valid: ${configPath}`));
      })
  )
  .addCommand(
    new Command('get')
      .description('Get a configuration value')
      .argument('<key>', 'Configuration key (dot notation)')
      .action((key: string, _options, command) => {
        assertConfigKey(key);
        const config = loadConfig(selectedConfigPath(command));
        const value = getConfigValue(config, key);
        if (value === undefined) {
          throw new Error(`Configuration key not found: ${key}`);
        }
        if (globalOptions(command).json) {
          console.log(JSON.stringify({ key, value }, null, 2));
          return;
        }
        console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
      })
  )
  .addCommand(
    new Command('set')
      .description('Set a configuration value')
      .argument('<key>', 'Configuration key (dot notation)')
      .argument('<value>', 'Value to set')
      .action((key: string, value: string, _options, command) => {
        assertConfigKey(key);
        const configPath = selectedConfigPath(command);
        const config = setConfigValue(loadConfig(configPath), key, parseValue(value));
        saveConfig(config, configPath);
        if (globalOptions(command).json) {
          console.log(JSON.stringify({ updated: true, configPath, key, value: getConfigValue(config, key) }, null, 2));
          return;
        }
        console.log(chalk.green(`Set ${key} in ${configPath}`));
      })
  )
  .addCommand(
    new Command('list')
      .description('List all configuration values')
      .alias('ls')
      .action((_options, command) => {
        const config = loadConfig(selectedConfigPath(command));
        if (globalOptions(command).json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }
        console.log(chalk.cyan('\nZouroboros Configuration:\n'));
        console.log(JSON.stringify(config, null, 2));
        console.log();
      })
  );
