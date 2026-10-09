// Shared rules for the leak gate, skill importer and parity check.
// Findings never carry matched secret or personal-data text; callers print rule IDs and locations.
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '../..');
export const defaultConfigPath = join(repoRoot, 'provenance/leak-gate.json');

export interface PatternRule { id: string; regex: string }
export interface ReviewedException { path: string; sha256: string; rules: string[]; reason: string }
/**
 * A narrow, reasoned allowance: in the listed files, a finding for one of the listed rules is
 * dropped only when it disappears after masking the allowed context on that line. The context is
 * a regex, or the source entry names recorded in provenance/skills-parity.json.
 */
export interface ContextAllowance {
  id: string;
  files: string[];
  rules: string[];
  context: { regex: string } | { sourceEntryNames: true };
  reason: string;
}
export interface LeakGateConfig {
  schema: string;
  blockedPaths: { extensions: string; fileNames: string; pathSegments: string[] };
  hostPathPatterns: PatternRule[];
  personalData: {
    salt: string;
    hashes: { label: string; sha256: string }[];
    emailAllowDomains: string[];
    emailAllowLocalParts: string[];
    phoneRegex: string;
  };
  /**
   * Source-host persona names and the operator's business brands: HMAC-SHA256 keyed with a secret
   * salt (never committed), same normalization. Without the salt these rules skip; see identitySalt().
   */
  identityData?: { scheme?: string; hashes: { label: string; sha256: string }[] };
  /** Runtime only, never stored in the config file: the secret identity salt, if one was found. */
  identitySalt?: string;
  /** Private, CGNAT/tailnet and tailnet IPv6 address ranges. */
  networkPatterns?: PatternRule[];
  secretPatterns: PatternRule[];
  reviewedExceptions: ReviewedException[];
  contextAllowances?: ContextAllowance[];
}

/** Masks for the context allowances that apply to one file (built by the caller). */
export interface ContextMask { rules: string[]; pattern: RegExp }

export type FindingKind = 'blocked-path' | 'host-path' | 'personal-data' | 'private-network' | 'secret' | 'provenance' | 'parity';
export interface Finding { kind: FindingKind; rule: string; file: string; line?: number; detail?: string }

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Default location of the local identity salt, outside the repository. */
export const defaultIdentitySaltPath = () => join(homedir(), '.config/hermes-zouroboros/leak-gate-salt');
export const IDENTITY_SCHEME = 'hmac-sha256/secret-salt/v1';

/**
 * The secret identity salt: LEAK_GATE_SALT, else the file named by LEAK_GATE_SALT_FILE, else
 * ~/.config/hermes-zouroboros/leak-gate-salt. Returns undefined when none exists (forks, fresh
 * clones). A salt file readable by group or others is refused rather than used.
 */
export function identitySalt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.LEAK_GATE_SALT?.trim();
  if (fromEnv) return fromEnv;
  const path = env.LEAK_GATE_SALT_FILE || defaultIdentitySaltPath();
  if (!existsSync(path)) return undefined;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`identity salt file ${path} must be mode 0600 (chmod 600 it)`);
  return readFileSync(path, 'utf8').trim() || undefined;
}

export function loadConfig(path = defaultConfigPath, salt: string | undefined | false = undefined): LeakGateConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as LeakGateConfig;
  if (config.schema !== 'hermes-zouroboros/leak-gate/v1') throw new Error(`Unsupported leak-gate config schema in ${path}`);
  if (config.identityData && config.identityData.scheme !== IDENTITY_SCHEME) throw new Error(`identityData in ${path} must use scheme ${IDENTITY_SCHEME}`);
  const resolved = salt === false ? undefined : salt ?? identitySalt();
  if (resolved) config.identitySalt = resolved;
  return config;
}

/** True when identity rules can run: there are identity hashes and a secret salt to check them with. */
export const identityRulesActive = (config: LeakGateConfig) => Boolean(config.identitySalt && config.identityData?.hashes.length);

/** Path-only rule: returns the blocking rule ID for a repo-relative path, or undefined. */
export function blockedPathRule(path: string, config: LeakGateConfig): string | undefined {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  if (new RegExp(config.blockedPaths.extensions, 'i').test(name)) return 'blocked-path:extension';
  if (new RegExp(config.blockedPaths.fileNames, 'i').test(name)) return 'blocked-path:file-name';
  const segment = parts.slice(0, -1).find((part) => config.blockedPaths.pathSegments.includes(part.toLowerCase()));
  if (segment) return `blocked-path:segment:${segment}`;
  return undefined;
}

/** Reviewed exceptions are pinned to content: a changed file needs a fresh review. */
export function exceptionFor(path: string, content: Buffer, rule: string, config: LeakGateConfig): ReviewedException | undefined {
  const digest = sha256(content);
  return config.reviewedExceptions.find((entry) => entry.path === path && entry.sha256 === digest
    && entry.rules.some((allowed) => allowed === rule || rule.startsWith(`${allowed}:`)));
}

export function tokens(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function personalHashes(text: string, salt: string): string[] {
  return grams(text).map((gram) => sha256(salt + gram));
}

function grams(text: string): string[] {
  const words = tokens(text);
  return [...words, ...words.slice(1).map((word, index) => `${words[index]} ${word}`)];
}

/** Identity hashes: HMAC-SHA256 of each normalized unigram and bigram, keyed with the secret salt. */
export function identityHashes(text: string, secret: string): string[] {
  return grams(text).map((gram) => identityHash(gram, secret));
}
export const identityHash = (normalizedToken: string, secret: string) => createHmac('sha256', secret).update(normalizedToken).digest('hex');

const emailPattern = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Context masks for `file`; source entry names come from the parity manifest the caller passes. */
export function contextMasks(file: string, config: LeakGateConfig, sourceEntryNames: string[] = []): ContextMask[] {
  return (config.contextAllowances ?? []).filter((allowance) => allowance.files.includes(file)).flatMap((allowance) => {
    if ('regex' in allowance.context) return [{ rules: allowance.rules, pattern: new RegExp(allowance.context.regex, 'g') }];
    const names = [...new Set(sourceEntryNames)].sort((a, b) => b.length - a.length).map(escapeRegex);
    return names.length ? [{ rules: allowance.rules, pattern: new RegExp(`(?<![A-Za-z0-9])(?:${names.join('|')})(?![A-Za-z0-9])`, 'g') }] : [];
  });
}

/** Content rules for one text file. Each finding records only rule ID and line number. */
export function scanText(path: string, text: string, config: LeakGateConfig, masks: ContextMask[] = []): Finding[] {
  const findings: Finding[] = [];
  const denied = new Map(config.personalData.hashes.map((entry) => [entry.sha256, entry.label]));
  const identity = identityRulesActive(config) ? new Map(config.identityData!.hashes.map((entry) => [entry.sha256, entry.label])) : undefined;
  const hostRules = config.hostPathPatterns.map((rule) => ({ id: rule.id, regex: new RegExp(rule.regex) }));
  const networkRules = (config.networkPatterns ?? []).map((rule) => ({ id: rule.id, regex: new RegExp(rule.regex) }));
  const labelsOf = (line: string) => new Set([
    ...personalHashes(line, config.personalData.salt).map((hash) => denied.get(hash)),
    ...(identity ? identityHashes(line, config.identitySalt!).map((hash) => identity.get(hash)) : []),
  ].filter((label): label is string => Boolean(label)));
  const secretRules = config.secretPatterns.map((rule) => ({ id: rule.id, regex: new RegExp(rule.regex) }));
  const phone = new RegExp(config.personalData.phoneRegex);
  const lines = text.split('\n');
  lines.forEach((content, index) => {
    const line = index + 1;
    for (const rule of hostRules) if (rule.regex.test(content)) findings.push({ kind: 'host-path', rule: `host-path:${rule.id}`, file: path, line });
    for (const rule of networkRules) if (rule.regex.test(content)) findings.push({ kind: 'private-network', rule: `private-network:${rule.id}`, file: path, line });
    for (const rule of secretRules) if (rule.regex.test(content)) findings.push({ kind: 'secret', rule: `secret:${rule.id}`, file: path, line });
    const labels = labelsOf(content);
    for (const label of labels) {
      const rule = `personal-data:${label}`;
      const applicable = masks.filter((mask) => mask.rules.includes(rule));
      if (applicable.length && !labelsOf(applicable.reduce((line, mask) => line.replace(mask.pattern, ' '), content)).has(label)) continue;
      findings.push({ kind: 'personal-data', rule, file: path, line });
    }
    for (const match of content.matchAll(emailPattern)) {
      const [local, domain] = match[0].toLowerCase().split('@') as [string, string];
      const allowedDomain = config.personalData.emailAllowDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
      if (!allowedDomain && !config.personalData.emailAllowLocalParts.includes(local)) {
        findings.push({ kind: 'personal-data', rule: 'personal-data:email-address', file: path, line });
        break;
      }
    }
    if (phone.test(content)) findings.push({ kind: 'personal-data', rule: 'personal-data:phone-number', file: path, line });
  });
  return findings;
}

export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}

function isGitTopLevel(root: string): boolean {
  try {
    return resolve(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) === resolve(root);
  } catch { return false; }
}

/** Files that would be committed: tracked plus untracked-not-ignored. Falls back to a walk outside Git. */
export function listFiles(root: string): string[] {
  if (isGitTopLevel(root)) {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
    return [...new Set(out.split('\0').filter(Boolean))].filter((file) => existsSync(join(root, file)) || lstatExists(join(root, file))).sort();
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export function readFile(root: string, file: string): Buffer | undefined {
  const full = join(root, file);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !statSync(full).isFile()) return undefined;
  return readFileSync(full);
}
