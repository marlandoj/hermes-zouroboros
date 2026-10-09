import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument, stringify } from 'yaml';
import { createHermesRegistry } from './hermes-executor.ts';

export const repoRoot = resolve(import.meta.dir, '..');
export const skillsDir = join(repoRoot, 'skills');
export function paths() {
  const data = resolve(process.env.HERMES_ZOUROBOROS_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'hermes-zouroboros'));
  return { data, profile: join(data, 'hermes'), db: join(data, 'memory.db'), registry: join(data, 'executors.json'), settings: join(data, 'settings.json') };
}
export function settings(): { workspace: string } {
  const p = paths();
  if (!existsSync(p.settings)) throw new Error('Run init first. No distribution profile exists.');
  const value = JSON.parse(readFileSync(p.settings, 'utf8'));
  if (typeof value.workspace !== 'string' || !existsSync(value.workspace) || !statSync(value.workspace).isDirectory()) throw new Error('Configured workspace is unavailable.');
  return value;
}
/** Optional non-interactive model selection for `init` (Hermes `hermes setup` is interactive). */
export interface InitOptions { model?: string; provider?: string }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate init model options; throws before any profile file is written. */
export function validateInitOptions(options: InitOptions): InitOptions {
  const model = options.model?.trim() || undefined;
  const provider = options.provider?.trim() || undefined;
  if (provider && !model) throw new Error('--provider requires --model');
  if (model && !MODEL_ID.test(model)) throw new Error('--model must be a model id (letters, digits and . _ : / @ + -)');
  if (provider && !PROVIDER_NAME.test(provider)) throw new Error('--provider must be a Hermes provider name (letters, digits and . _ -)');
  return { model, provider };
}

/**
 * One-line notice when ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS is unset or holds no valid domain:
 * the public candidate-corpus guard then cannot recognise employer-domain addresses.
 */
export function restrictedEmailDomainsNotice(env: Record<string, string | undefined> = process.env): string | undefined {
  const valid = (env.ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS ?? '').split(',')
    .some((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain.trim().toLowerCase().replace(/^@/, '')));
  return valid ? undefined : 'Notice: ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS is not set, so the public candidate-corpus guard will not block employer-domain email addresses until you set it (comma-separated domains; see docs/operations.md).';
}

export function initialize(workspace: string, options: InitOptions = {}) {
  const p = paths();
  const { model, provider } = validateInitOptions(options);
  // Refuse replacement before writing any profile files.
  if ([p.settings, p.registry, join(p.profile, 'config.yaml')].some(existsSync)) throw new Error('Profile already exists; preserve it and edit configuration explicitly.');
  const work = resolve(workspace);
  if (!existsSync(work) || !statSync(work).isDirectory()) throw new Error('Workspace must already exist and be a directory.');
  mkdirSync(p.profile, { recursive: true, mode: 0o700 });
  // The MCP server only prepares campaigns; execution is the opt-in `cli.ts swarm` command, which
  // reads HERMES_ZOUROBOROS_ALLOW_SWARM from its own environment. A literal 0 here (as the operator
  // installer writes) also avoids Hermes warning about an unset ${env:…} ref on every command.
  const env = { HERMES_ZOUROBOROS_HOME: p.data, HERMES_ZOUROBOROS_ALLOW_SWARM: '0' };
  const config: Record<string, unknown> = {
    ...(model ? { model: { default: model, ...(provider ? { provider } : {}) } } : {}),
    mcp_servers: {
      zouroboros: { command: process.execPath, args: [join(repoRoot, 'integration/mcp.ts')], env, timeout: 900, connect_timeout: 30 },
    },
    skills: { external_dirs: [skillsDir] },
  };
  const registry = createHermesRegistry(repoRoot);
  writeFileSync(p.registry, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(p.profile, 'config.yaml'), stringify(config), { mode: 0o600, flag: 'wx' });
  writeFileSync(p.settings, JSON.stringify({ workspace: work }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return p;
}
export function runtimeEnv(): Record<string, string | undefined> {
  const p = paths();
  return { ...process.env, HERMES_HOME: p.profile, ZOUROBOROS_MEMORY_DB: p.db, ZO_MEMORY_DB: p.db,
    SWARM_EXECUTOR_REGISTRY: p.registry, ZOUROBOROS_WORKSPACE_ROOT: settings().workspace,
    ZOUROBOROS_WORKSPACE: settings().workspace, ZOUROBOROS_DATA_DIR: p.data,
    ZOUROBOROS_STATE_DIR: join(p.data, 'state'), ZOUROBOROS_CONFIG_DIR: join(p.data, 'config'),
    ZOUROBOROS_CACHE_DIR: join(p.data, 'cache'), ZOUROBOROS_LOG_DIR: join(p.data, 'logs') };
}
/** Add the distribution skills tree to an existing profile's skills.external_dirs, preserving other settings and comments. */
export function registerSkills(): { config: string; changed: boolean } {
  const config = join(paths().profile, 'config.yaml');
  if (!existsSync(config)) throw new Error('Run init first. No distribution profile exists.');
  const document = parseDocument(readFileSync(config, 'utf8'));
  const current: unknown = document.toJS()?.skills?.external_dirs;
  const dirs = typeof current === 'string' ? [current] : Array.isArray(current) ? current : [];
  if (dirs.some((dir) => typeof dir === 'string' && resolve(dir) === skillsDir)) return { config, changed: false };
  document.setIn(['skills', 'external_dirs'], [...dirs, skillsDir]);
  writeFileSync(config, document.toString(), { mode: 0o600 });
  return { config, changed: true };
}
