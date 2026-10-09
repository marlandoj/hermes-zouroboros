#!/usr/bin/env bun
/**
 * supply-chain gate CLI — wires the three pure cores to the real filesystem.
 *
 *   bun gate.ts                 # all checks, advisory (exit 0)
 *   bun gate.ts --actions       # action-pin-audit only
 *   bun gate.ts --mcp           # mcp-inject-scan + inventory/policy only
 *   bun gate.ts --strict        # exit 1 if any critical finding
 *   bun gate.ts --resolve       # resolve mutable tags -> commit SHA via git ls-remote (network)
 *   bun gate.ts --root <dir>    # repo root to scan (default: SUPPLY_CHAIN_ROOT, else cwd's git
 *                               #   root, else ZOUROBOROS_WORKSPACE; none of them -> exit 2)
 *   bun gate.ts --policy <file> # mcp policy (default: SUPPLY_CHAIN_POLICY, else
 *                               #   $ZOUROBOROS_CONFIG_DIR/skill-security-gate/mcp-policy.json if present,
 *                               #   else this skill's mcp-policy.json)
 *   bun gate.ts --hermes-config [file]  # also inventory mcp_servers from the Hermes profile
 *                               #   config.yaml (default: $HERMES_HOME/config.yaml)
 *   bun gate.ts --report-dir <d># where to write the JSON report (default: SUPPLY_CHAIN_REPORT_DIR,
 *                               #   else $ZOUROBOROS_STATE_DIR/skill-security-gate/supply-chain)
 *   bun gate.ts --help
 *
 * Advisory by default: prints a report and exits 0 even with critical findings,
 * so it is safe to run in CI/pre-adoption as a visible signal. --strict makes a
 * critical finding fail the build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseWorkflowUses, auditActionPins, type ShaResolver } from './action-pin-audit.js';
import { scanMcpInjections, type InjectScanInput } from './mcp-inject-scan.js';
import { inventoryConfig, auditMcpPolicy, type McpPolicy, type McpServerEntry } from './mcp-inventory.js';
import type { Category, Finding } from './types.js';
import { buildReport, renderReport, writeReport } from './report.js';
import { buildAttestation, writeAttestation } from './attestation.js';

interface Args {
  help: boolean;
  actions: boolean;
  mcp: boolean;
  strict: boolean;
  resolve: boolean;
  root: string;
  policy?: string;
  reportDir: string;
  attest: boolean;
  /** Hermes profile config.yaml to inventory in addition to .mcp.json files. */
  hermesConfig?: string;
}

type Env = Record<string, string | undefined>;

const SKILL_DIR = resolvePath(import.meta.dir, '..', '..');

function dataDir(env: Env): string {
  return resolvePath(env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'hermes-zouroboros'));
}

export function defaultReportDir(env: Env = process.env): string {
  return env.SUPPLY_CHAIN_REPORT_DIR || join(env.ZOUROBOROS_STATE_DIR || join(dataDir(env), 'state'), 'skill-security-gate', 'supply-chain');
}

export function defaultPolicyPath(env: Env = process.env): string {
  if (env.SUPPLY_CHAIN_POLICY) return env.SUPPLY_CHAIN_POLICY;
  const operator = join(env.ZOUROBOROS_CONFIG_DIR || join(dataDir(env), 'config'), 'skill-security-gate', 'mcp-policy.json');
  return existsSync(operator) ? operator : join(SKILL_DIR, 'mcp-policy.json');
}

class UsageError extends Error {}

const HELP = `usage: bun gate.ts [--actions | --mcp] [--strict] [--resolve] [--attest]
                   [--root <dir>] [--policy <file>] [--hermes-config [file]] [--report-dir <dir>]

Deterministic supply-chain checks: GitHub Action SHA pins, MCP injection scan, MCP inventory + policy.
Advisory by default (exit 0); --strict or SUPPLY_CHAIN_ENFORCE=1 exits 1 on a critical finding.
No network unless --resolve. Exit 2 when no scan root can be determined.`;

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f);
  const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const onlyActions = has('--actions') && !has('--mcp');
  const onlyMcp = has('--mcp') && !has('--actions');
  if (has('--help') || has('-h')) {
    return { help: true, actions: false, mcp: false, strict: false, resolve: false, root: '', reportDir: '', attest: false };
  }
  const root = resolvePath(val('--root') ?? defaultRoot());
  let hermesConfig: string | undefined;
  if (has('--hermes-config')) {
    const next = val('--hermes-config');
    hermesConfig = next && !next.startsWith('--') ? next : join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml');
  }
  return {
    help: false,
    actions: onlyMcp ? false : true,
    mcp: onlyActions ? false : true,
    strict: has('--strict') || process.env.SUPPLY_CHAIN_ENFORCE === '1',
    resolve: has('--resolve'),
    root,
    policy: val('--policy'),
    reportDir: val('--report-dir') ?? defaultReportDir(),
    attest: has('--attest') || process.env.SUPPLY_CHAIN_ATTEST === '1',
    hermesConfig,
  };
}

function defaultRoot(): string {
  if (process.env.SUPPLY_CHAIN_ROOT) return process.env.SUPPLY_CHAIN_ROOT;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) return top;
  } catch {
    /* not a git repo */
  }
  if (process.env.ZOUROBOROS_WORKSPACE) return process.env.ZOUROBOROS_WORKSPACE;
  throw new UsageError('no scan root: pass --root, run inside a git checkout, or set ZOUROBOROS_WORKSPACE');
}

/** Resolve a mutable tag to its commit SHA via `git ls-remote` (network, opt-in). */
function createGitLsRemoteResolver(): ShaResolver {
  return (owner, repo, ref) => {
    try {
      const url = `https://github.com/${owner}/${repo}.git`;
      const out = execFileSync('git', ['ls-remote', url, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`], {
        encoding: 'utf8',
        timeout: 20000,
      });
      const rows = out.split('\n').filter(Boolean).map((l) => l.split('\t'));
      // Prefer the dereferenced tag commit (^{}) over the tag object.
      const deref = rows.find((r) => r[1]?.endsWith('^{}'));
      const sha = (deref ?? rows[0])?.[0]?.trim();
      return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
      return null;
    }
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.swarm', 'dist', 'build', '.next', 'coverage']);

function findFiles(root: string, match: (name: string, full: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) findFiles(full, match, out);
    else if (match(name, full)) out.push(full);
  }
  return out;
}

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
}

// ── action-pin check ────────────────────────────────────────────────────────
function runActionPin(root: string, useResolver: boolean): Finding[] {
  const wfDir = join(root, '.github', 'workflows');
  if (!existsSync(wfDir)) return [];
  const files = findFiles(wfDir, (n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  const resolver = useResolver ? createGitLsRemoteResolver() : undefined;
  const findings: Finding[] = [];
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    const refs = parseWorkflowUses(content, rel(root, f));
    findings.push(...auditActionPins(refs, resolver));
  }
  return findings;
}

// ── mcp checks (inventory/policy + injection) ─────────────────────────────────
const DESC_FIELDS = ['note', 'description', 'instructions', 'summary'];

function collectDescriptions(serverCfg: Record<string, unknown>): string {
  return DESC_FIELDS.map((k) => (typeof serverCfg[k] === 'string' ? (serverCfg[k] as string) : ''))
    .filter(Boolean)
    .join('\n');
}

function localSourcePath(entry: McpServerEntry, root: string): string | undefined {
  if (entry.source !== 'local') return undefined;
  const cand = entry.command && entry.command.includes('/') ? entry.command : (entry.args ?? []).find((a) => !a.startsWith('-') && a.includes('/'));
  if (!cand) return undefined;
  const abs = cand.startsWith('/') ? cand : resolvePath(root, cand);
  return existsSync(abs) ? abs : undefined;
}

function loadPolicy(policyPath: string | undefined): McpPolicy {
  const path = policyPath ?? defaultPolicyPath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as McpPolicy;
    } catch {
      /* fall through to default */
    }
  }
  return { policies: {}, default: 'approve' };
}

/** Read a .mcp.json (JSON) or a Hermes config.yaml (`mcp_servers:`) as an `{ mcpServers }` object. */
function readMcpConfig(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  if (!/\.ya?ml$/i.test(file)) return JSON.parse(text);
  const doc = parseYaml(text) as Record<string, unknown> | null;
  const servers = doc && typeof doc === 'object' ? doc.mcp_servers : undefined;
  return servers && typeof servers === 'object' ? { mcpServers: servers } : {};
}

function runMcp(root: string, policyPath: string | undefined, hermesConfig?: string): Finding[] {
  const configs = findFiles(root, (n) => n === '.mcp.json');
  if (hermesConfig && existsSync(hermesConfig)) configs.push(resolvePath(hermesConfig));
  const policy = loadPolicy(policyPath);
  const entries: McpServerEntry[] = [];
  const injectInputs: InjectScanInput[] = [];

  for (const cfgFile of configs) {
    let parsed: unknown;
    try {
      parsed = readMcpConfig(cfgFile);
    } catch {
      continue;
    }
    const relFile = rel(root, cfgFile);
    const fileEntries = inventoryConfig(relFile, parsed);
    entries.push(...fileEntries);

    const serversObj = ((parsed as any)?.mcpServers ?? (parsed as any)?.servers ?? {}) as Record<string, any>;
    for (const e of fileEntries) {
      const rawCfg = (serversObj[e.id] ?? {}) as Record<string, unknown>;
      const descriptionsText = collectDescriptions(rawCfg);
      const srcPath = localSourcePath(e, root);
      let sourceText: string | undefined;
      if (srcPath) {
        try {
          sourceText = readFileSync(srcPath, 'utf8').slice(0, 200_000);
        } catch {
          /* unreadable */
        }
      }
      injectInputs.push({ serverId: `${e.id} (${relFile})`, descriptionsText, sourceText });
    }
  }

  return [...auditMcpPolicy(entries, policy), ...scanMcpInjections(injectInputs)];
}

function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  const checksRun: Category[] = [];
  const findings: Finding[] = [];

  if (args.actions) {
    checksRun.push('action-pin');
    findings.push(...runActionPin(args.root, args.resolve));
  }
  if (args.mcp) {
    checksRun.push('mcp-policy', 'mcp-inject');
    findings.push(...runMcp(args.root, args.policy, args.hermesConfig));
  }

  const report = buildReport(checksRun, findings);
  console.log(renderReport(report));

  let reportPath = '';
  try {
    reportPath = writeReport(report, args.reportDir);
    console.log(`\nReport: ${reportPath}`);
  } catch (err) {
    console.error(`(warn) could not write report: ${(err as Error).message}`);
  }

  if (args.attest) {
    try {
      const attestation = buildAttestation(report, report.timestamp, reportPath || null);
      const attestationPath = writeAttestation(attestation, args.reportDir);
      console.log(`Attestation: ${attestationPath}`);
      console.log(`Attestation digest: ${attestation.sourceDigest}`);
      console.log(`MCP review required: ${attestation.reviewRequired}`);
    } catch (err) {
      console.error(`(warn) could not write attestation: ${(err as Error).message}`);
      if (args.strict) process.exit(1);
    }
  }

  if (args.strict && !report.passed) {
    console.error(`\n--strict: ${report.summary.critical} critical finding(s) -> exit 1`);
    process.exit(1);
  }
}

if (import.meta.main) main();
