#!/usr/bin/env bun
/**
 * Optional Hermes `pre_tool_call` shell hook (matcher: terminal) that gates terminal-side skill
 * adoption: commands that clone, copy, move or extract something into a `skills` directory.
 *
 * Hermes already scans skills it installs itself (`hermes skills install`, hub sources) and skills
 * the agent writes with its skill tool. A terminal `git clone`/`cp -r` into a skills directory
 * bypasses both. This hook closes that gap with deterministic, offline checks only:
 *
 *   remote or archive source (git clone, curl/wget, unzip, tar) into a skills dir
 *       -> cannot be pre-checked, so it would block: quarantine first, run gate.sh, then copy.
 *   local directory or .md file copied/moved/synced into a skills dir
 *       -> action-pin audit of .github/workflows, MCP inventory/policy + injection scan of any
 *          .mcp.json, directive/hidden-unicode scan of markdown, and the lifecycle gate when the
 *          source carries a skill-lifecycle.json. Any critical finding or non-PASS lifecycle
 *          result would block.
 *   `hermes skills install ...`  -> allowed; Hermes' own skills_guard scans it.
 *
 * Modes (--mode beats SKILL_SECURITY_GATE_HOOK_MODE; default off):
 *   off       read nothing, print nothing.
 *   advisory  never blocks; records each would-block decision as one JSON line in
 *             ${SKILL_SECURITY_GATE_HOOK_LOG:-$ZOUROBOROS_LOG_DIR/skill-security-gate-hook.jsonl}.
 *   enforce   prints {"decision":"block","reason":...} for a would-block decision.
 *
 * Fails open: unparseable input, an unknown tool or any internal error prints nothing and exits 0.
 * Command parsing is a best-effort tripwire (no variable, glob or subshell expansion), not a sandbox.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { auditActionPins, parseWorkflowUses } from './supply-chain/action-pin-audit.js';
import { scanMcpInjection } from './supply-chain/mcp-inject-scan.js';
import { auditMcpPolicy, inventoryConfig, type McpPolicy } from './supply-chain/mcp-inventory.js';
import type { Finding } from './supply-chain/types.js';
import { validateLifecycleSubject } from './lifecycle/gate.js';

type Mode = 'off' | 'advisory' | 'enforce';
type Env = Record<string, string | undefined>;

export type Adoption =
  | { kind: 'remote'; tool: string; source: string; dest: string }
  | { kind: 'local'; tool: string; sources: string[]; dest: string };

export interface HookDecision {
  block: boolean;
  reason: string;
  adoption?: Adoption;
  findings?: string[];
}

const USAGE = `usage: bun adoption-hook.ts [--mode off|advisory|enforce] < hook-payload.json
Hermes pre_tool_call hook (matcher: terminal). Default mode: off (SKILL_SECURITY_GATE_HOOK_MODE).`;

const SKILLS_SEGMENT = /(^|\/)skills(\/|$)/i;
const MAX_SCAN_FILES = 2_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

// ── command parsing ───────────────────────────────────────────────────────────

/** Split a shell command into simple-command token lists (quotes honoured; no expansion). */
export function splitCommands(command: string): string[][] {
  const out: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const pushToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (c === ' ' || c === '\t') pushToken();
    else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') pushCommand();
    else {
      cur += c;
      has = true;
    }
  }
  pushCommand();
  return out;
}

const GIT_CLONE_VALUE_OPTS = new Set([
  '-b', '--branch', '--depth', '-o', '--origin', '-c', '--config', '--reference', '--filter', '-j', '--jobs',
  '--template', '--separate-git-dir', '--shallow-since', '--shallow-exclude', '-u', '--upload-pack', '--server-option',
]);

function positionals(args: string[], valueOpts: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (valueOpts.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function optionValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (n.startsWith('--') && args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
      if (!n.startsWith('--') && args[i].startsWith(n) && args[i].length > n.length) return args[i].slice(n.length);
    }
  }
  return undefined;
}

const intoSkills = (path: string | undefined): path is string => Boolean(path && SKILLS_SEGMENT.test(path));

/** Classify one terminal command; null when it does not adopt anything into a skills directory. */
export function classifyAdoption(command: string, cwd = ''): Adoption | null {
  for (let tokens of splitCommands(command)) {
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0] === 'sudo' || tokens[0] === 'env')) tokens = tokens.slice(1);
    const [cmd, ...args] = tokens;
    if (!cmd) continue;
    const tool = basename(cmd);

    if (tool === 'hermes' && args[0] === 'skills') continue; // Hermes' own skills_guard covers it

    if (tool === 'git') {
      const at = args.indexOf('clone');
      if (at < 0) continue;
      const pos = positionals(args.slice(at + 1), GIT_CLONE_VALUE_OPTS);
      const source = pos[0];
      if (!source) continue;
      const dest = pos[1] ?? join(cwd, basename(source).replace(/\.git$/, ''));
      if (intoSkills(dest)) return { kind: 'remote', tool: 'git clone', source, dest };
      continue;
    }

    if (tool === 'unzip') {
      const dest = optionValue(args, ['-d']);
      if (intoSkills(dest ?? cwd)) return { kind: 'remote', tool, source: positionals(args, new Set(['-d']))[0] ?? '', dest: dest ?? cwd };
      continue;
    }
    if (tool === 'tar' || tool === 'bsdtar') {
      const extracting = args.some(
        (a, i) => (i === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(a)) || /^-[A-Za-z]*x[A-Za-z]*$/.test(a) || a === '--extract' || a === '--get',
      );
      const dest = optionValue(args, ['-C', '--directory']) ?? cwd;
      if (extracting && intoSkills(dest)) return { kind: 'remote', tool, source: optionValue(args, ['-f', '--file']) ?? '', dest };
      continue;
    }
    if (tool === 'curl' || tool === 'wget') {
      const dest = optionValue(args, tool === 'curl' ? ['-o', '--output'] : ['-O', '--output-document', '-P', '--directory-prefix']);
      if (intoSkills(dest)) return { kind: 'remote', tool, source: positionals(args)[0] ?? '', dest };
      continue;
    }

    if (tool === 'cp' || tool === 'mv' || tool === 'rsync') {
      const target = optionValue(args, ['-t', '--target-directory']);
      const valueOpts = tool === 'rsync' ? new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f']) : new Set(['-t', '--target-directory']);
      const pos = positionals(args, valueOpts);
      const dest = target ?? pos[pos.length - 1];
      const sources = target ? pos : pos.slice(0, -1);
      if (!sources.length || !intoSkills(dest)) continue;
      if (sources.some((s) => /^[^/]+@[^:]+:|^[a-z]+:\/\//i.test(s) || (tool === 'rsync' && /^[^/]+:/.test(s)))) {
        return { kind: 'remote', tool, source: sources.join(' '), dest };
      }
      return { kind: 'local', tool, sources, dest };
    }
  }
  return null;
}

// ── deterministic checks over a local source ──────────────────────────────────

function listFiles(root: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) listFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const read = (file: string) => {
  try {
    return readFileSync(file, 'utf8').slice(0, 200_000);
  } catch {
    return '';
  }
};

function loadPolicy(env: Env, skillDir: string): McpPolicy {
  const configDir = env.ZOUROBOROS_CONFIG_DIR || join(dataDir(env), 'config');
  for (const path of [env.SUPPLY_CHAIN_POLICY, join(configDir, 'skill-security-gate', 'mcp-policy.json'), join(skillDir, 'mcp-policy.json')]) {
    if (path && existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as McpPolicy;
      } catch {
        /* next */
      }
    }
  }
  return { policies: {}, default: 'approve' };
}

/** Run the offline checks over one local source path; returns blocking problems. */
export function checkLocalSource(source: string, env: Env = process.env): string[] {
  const problems: string[] = [];
  if (!existsSync(source)) return problems;
  const st = statSync(source);
  const files = st.isDirectory() ? listFiles(source) : [source];
  const rel = (f: string) => (f.startsWith(`${source}/`) ? f.slice(source.length + 1) : basename(f));
  const findings: Finding[] = [];

  for (const f of files) {
    const r = rel(f);
    if (/\.md$/i.test(f)) findings.push(...scanMcpInjection({ serverId: r, sourceText: read(f) }));
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(r)) findings.push(...auditActionPins(parseWorkflowUses(read(f), r)));
    if (basename(f) === '.mcp.json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(read(f));
      } catch {
        continue;
      }
      const entries = inventoryConfig(r, parsed);
      findings.push(...auditMcpPolicy(entries, loadPolicy(env, resolve(import.meta.dir, '..'))));
      const servers = ((parsed as any)?.mcpServers ?? (parsed as any)?.servers ?? {}) as Record<string, any>;
      for (const e of entries) {
        const cfg = (servers[e.id] ?? {}) as Record<string, unknown>;
        const text = ['note', 'description', 'instructions', 'summary'].map((k) => (typeof cfg[k] === 'string' ? cfg[k] : '')).join('\n');
        findings.push(...scanMcpInjection({ serverId: `${e.id} (${r})`, descriptionsText: text }));
      }
    }
  }
  for (const f of findings.filter((x) => x.severity === 'critical')) problems.push(`${f.category}: ${f.target}: ${f.finding}`);

  const manifest = st.isDirectory() ? join(source, 'skill-lifecycle.json') : '';
  if (manifest && existsSync(manifest)) {
    let decision = 'DENY';
    try {
      decision = validateLifecycleSubject(JSON.parse(readFileSync(manifest, 'utf8')), source).decision;
    } catch {
      /* malformed manifest -> DENY */
    }
    if (decision !== 'PASS') problems.push(`lifecycle: skill-lifecycle.json -> ${decision}`);
  }
  return problems;
}

export function decide(adoption: Adoption, cwd: string, env: Env = process.env): HookDecision {
  const scan = `bash "${resolve(import.meta.dir, 'gate.sh')}" <dir>`;
  if (adoption.kind === 'remote') {
    return {
      block: true,
      adoption,
      reason:
        `skill-security-gate: ${adoption.tool} from a remote or archive source straight into a skills directory (${adoption.dest}) ` +
        `cannot be checked first. Fetch it into a quarantine directory outside any skills directory, scan it with ${scan}, ` +
        `review the result, then copy the reviewed directory in.`,
    };
  }
  const problems = adoption.sources.flatMap((s) => checkLocalSource(isAbsolute(s) ? s : resolve(cwd || '.', s), env));
  if (!problems.length) return { block: false, adoption, reason: 'no critical findings' };
  return {
    block: true,
    adoption,
    findings: problems,
    reason: `skill-security-gate: ${adoption.tool} into ${adoption.dest} blocked by deterministic checks: ${problems.slice(0, 5).join('; ')}` +
      (problems.length > 5 ? ` (+${problems.length - 5} more)` : '') + `. Review the source (full scan: ${scan}) before adopting it.`,
  };
}

// ── hook entry point ───────────────────────────────────────────────────────────

function dataDir(env: Env): string {
  return resolve(env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'hermes-zouroboros'));
}

export function hookLogPath(env: Env = process.env): string {
  return env.SKILL_SECURITY_GATE_HOOK_LOG || join(env.ZOUROBOROS_LOG_DIR || join(dataDir(env), 'logs'), 'skill-security-gate-hook.jsonl');
}

function parseMode(argv: string[], env: Env): Mode | 'help' | null {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  const i = argv.indexOf('--mode');
  const raw = (i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--mode='))?.slice(7)) ?? env.SKILL_SECURITY_GATE_HOOK_MODE ?? 'off';
  return raw === 'off' || raw === 'advisory' || raw === 'enforce' ? raw : null;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2), process.env);
  if (mode === 'help') {
    console.log(USAGE);
    return;
  }
  if (mode === null || mode === 'off') return; // unknown mode fails open, like off
  const payload = JSON.parse(await Bun.stdin.text()) as {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: { command?: unknown };
    cwd?: string;
    session_id?: string;
  };
  if (payload.hook_event_name && payload.hook_event_name !== 'pre_tool_call') return;
  if (payload.tool_name !== 'terminal' || typeof payload.tool_input?.command !== 'string') return;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const adoption = classifyAdoption(payload.tool_input.command, cwd);
  if (!adoption) return;
  const decision = decide(adoption, cwd);
  if (!decision.block) return;

  if (mode === 'enforce') {
    console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
    return;
  }
  const log = hookLogPath();
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(
    log,
    `${JSON.stringify({ ts: new Date().toISOString(), mode, wouldBlock: true, session: payload.session_id ?? null, adoption: decision.adoption, findings: decision.findings ?? [] })}\n`,
    { mode: 0o600 },
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    /* fail open */
  }
  process.exit(0);
}
