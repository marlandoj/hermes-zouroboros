#!/usr/bin/env bun
// Leak gate: blocks data files, host paths, operator personal data, secrets and unprovenanced skill files.
// Run before every push (full tree and diff) and in CI. Output names rules and locations only, never matched values.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  blockedPathRule, exceptionFor, isBinary, listFiles, loadConfig, readFile, repoRoot, scanText,
  type Finding, type LeakGateConfig,
} from '../lib/leak-rules.ts';
import { checkSkillProvenance, loadSkillsManifest } from '../lib/skill-provenance.ts';

export const defaultBaselinePath = join(repoRoot, 'provenance/leak-gate-baseline.json');
/** Only pre-existing 0.1.0 host-path and personal-data occurrences may be grandfathered; never secrets, data files, or skills/. */
const baselineable = (finding: Finding) => (finding.kind === 'host-path' || finding.kind === 'personal-data') && !finding.file.startsWith('skills/');

interface BaselineEntry { file: string; rule: string; count: number }
interface Baseline { schema: 'hermes-zouroboros/leak-gate-baseline/v1'; note: string; entries: BaselineEntry[] }

export interface GateOptions {
  root?: string;
  configPath?: string;
  baselinePath?: string | false;
  manifestPath?: string;
  /** Restrict content rules to these repo-relative files (diff mode). Provenance always checks the full skills/ tree. */
  only?: string[];
  /** gitleaks binary, or false to skip (tests and explicit offline runs only). */
  gitleaks?: string | false;
  /** Also scan commits in <diffBase>..HEAD with gitleaks. */
  diffBase?: string;
}
export interface GateResult { findings: Finding[]; grandfathered: number; staleBaseline: BaselineEntry[]; scanned: number; gitleaks: 'ran' | 'skipped' }

function countKey(file: string, rule: string) { return `${file}\0${rule}`; }

export function runGate(options: GateOptions = {}): GateResult {
  const root = resolve(options.root ?? repoRoot);
  const config = loadConfig(options.configPath ?? join(root, 'provenance/leak-gate.json'));
  const allFiles = listFiles(root);
  const files = options.only ? allFiles.filter((file) => options.only!.includes(file)) : allFiles;
  const raw: Finding[] = [];
  const contents = new Map<string, Buffer | undefined>();
  const read = (file: string) => {
    if (!contents.has(file)) contents.set(file, existsSync(join(root, file)) ? readFile(root, file) : undefined);
    return contents.get(file);
  };
  const exempt = (finding: Finding) => {
    const content = read(finding.file);
    return content !== undefined && exceptionFor(finding.file, content, finding.rule, config) !== undefined;
  };

  for (const file of files) {
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink()) { raw.push({ kind: 'blocked-path', rule: 'blocked-path:symlink', file }); continue; }
    const pathRule = blockedPathRule(file, config);
    if (pathRule) raw.push({ kind: 'blocked-path', rule: pathRule, file });
    const content = read(file);
    if (!content || isBinary(content)) continue;
    raw.push(...scanText(file, content.toString('utf8'), config));
  }
  const manifestPath = options.manifestPath ?? join(root, 'provenance/skills.json');
  if (existsSync(manifestPath)) raw.push(...checkSkillProvenance(allFiles, read, loadSkillsManifest(manifestPath)));
  else if (allFiles.some((file) => file.startsWith('skills/'))) raw.push({ kind: 'provenance', rule: 'provenance:manifest-missing', file: 'provenance/skills.json' });
  let gitleaks: GateResult['gitleaks'] = 'skipped';
  if (options.gitleaks) {
    raw.push(...runGitleaks(options.gitleaks, root, files, read, options.diffBase));
    gitleaks = 'ran';
  }

  const findings = raw.filter((finding) => !exempt(finding));
  const baseline = options.baselinePath === false ? undefined : loadBaseline(options.baselinePath ?? join(root, 'provenance/leak-gate-baseline.json'));
  const allowance = new Map((baseline?.entries ?? []).map((entry) => [countKey(entry.file, entry.rule), entry.count]));
  const counts = new Map<string, number>();
  for (const finding of findings.filter(baselineable)) counts.set(countKey(finding.file, finding.rule), (counts.get(countKey(finding.file, finding.rule)) ?? 0) + 1);
  let grandfathered = 0;
  const blocking = findings.filter((finding) => {
    if (!baselineable(finding)) return true;
    const key = countKey(finding.file, finding.rule);
    if ((counts.get(key) ?? 0) <= (allowance.get(key) ?? 0)) { grandfathered++; return false; }
    return true;
  });
  const scope = new Set(files);
  const staleBaseline = (baseline?.entries ?? []).filter((entry) => scope.has(entry.file) && (counts.get(countKey(entry.file, entry.rule)) ?? 0) < entry.count);
  return { findings: blocking, grandfathered, staleBaseline, scanned: files.length, gitleaks };
}

function loadBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  const baseline = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
  if (baseline.schema !== 'hermes-zouroboros/leak-gate-baseline/v1') throw new Error('Unsupported baseline schema');
  for (const entry of baseline.entries) {
    if (entry.file.startsWith('skills/') || !/^(host-path|personal-data):/.test(entry.rule)) throw new Error(`Baseline may not grandfather ${entry.rule} in ${entry.file}`);
  }
  return baseline;
}

function runGitleaks(binary: string, root: string, files: string[], read: (file: string) => Buffer | undefined, diffBase?: string): Finding[] {
  const scratch = mkdtempSync(join(tmpdir(), 'leak-gate-'));
  try {
    const stage = join(scratch, 'tree');
    for (const file of files) {
      if (!read(file)) continue;
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      copyFileSync(join(root, file), join(stage, file));
    }
    mkdirSync(stage, { recursive: true });
    const findings = gitleaksReport(binary, ['dir', stage], join(scratch, 'tree.json'), (file) => file.startsWith(stage + '/') ? file.slice(stage.length + 1) : file);
    if (diffBase) findings.push(...gitleaksReport(binary, ['git', root, '--log-opts', `${diffBase}..HEAD`], join(scratch, 'history.json'), (file) => `${file} (commit history)`));
    return findings;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function gitleaksReport(binary: string, args: string[], report: string, rename: (file: string) => string): Finding[] {
  const result = spawnSync(binary, [...args, '--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', report], { encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(report)) throw new Error(`gitleaks failed (exit ${result.status}); refusing to pass without a secret scan`);
  const entries = JSON.parse(readFileSync(report, 'utf8') || '[]') as { RuleID: string; File: string; StartLine: number }[];
  return entries.map((entry) => ({ kind: 'secret', rule: `secret:gitleaks:${entry.RuleID}`, file: rename(entry.File), line: entry.StartLine }));
}

export function writeBaseline(root: string, path: string): number {
  const result = runGate({ root, baselinePath: false, gitleaks: false });
  const counts = new Map<string, BaselineEntry>();
  for (const finding of result.findings.filter(baselineable)) {
    const key = countKey(finding.file, finding.rule);
    const entry = counts.get(key) ?? { file: finding.file, rule: finding.rule, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const baseline: Baseline = {
    schema: 'hermes-zouroboros/leak-gate-baseline/v1',
    note: 'Grandfathered host-path/personal-data occurrences in the 0.1.0 package import, by file, rule and count. A count may only fall. skills/ is never grandfathered. Regenerate only in a reviewed PR that removes occurrences.',
    entries: [...counts.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)),
  };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
  return baseline.entries.length;
}

function changedFiles(root: string, base: string): string[] {
  const diff = execFileSync('git', ['-C', root, 'diff', '--name-only', '--diff-filter=ACMRT', '-z', base], { encoding: 'utf8' });
  const untracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return [...new Set([...diff.split('\0'), ...untracked.split('\0')].filter(Boolean))];
}

export function describe(finding: Finding): string {
  return `${finding.rule}  ${finding.file}${finding.line ? `:${finding.line}` : ''}${finding.detail ? `  (${finding.detail})` : ''}`;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, diff: { type: 'string' }, gitleaks: { type: 'string' },
    'skip-gitleaks': { type: 'boolean' }, 'write-baseline': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const root = resolve(values.root ?? repoRoot);
  try {
    if (values['write-baseline']) {
      console.log(`Wrote ${writeBaseline(root, join(root, 'provenance/leak-gate-baseline.json'))} baseline entries.`);
      process.exit(0);
    }
    let gitleaks: string | false = values.gitleaks ?? process.env.GITLEAKS_BIN ?? Bun.which('gitleaks') ?? false;
    if (values['skip-gitleaks']) {
      if (process.env.CI) throw new Error('--skip-gitleaks is not allowed in CI');
      console.error('WARNING: secret scan by gitleaks skipped; only custom secret patterns ran.');
      gitleaks = false;
    } else if (!gitleaks) {
      throw new Error('gitleaks not found. Install the pinned build with scripts/ci/install-gitleaks.sh and set GITLEAKS_BIN, or pass --skip-gitleaks for an explicitly partial local run.');
    }
    const only = values.diff ? changedFiles(root, values.diff) : undefined;
    const result = runGate({ root, gitleaks, only, diffBase: values.diff });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const finding of result.findings) console.log(`FAIL ${describe(finding)}`);
      for (const entry of result.staleBaseline) console.log(`NOTE baseline can be lowered: ${entry.rule} ${entry.file} (allowance ${entry.count})`);
      console.log(`leak-gate ${values.diff ? `diff vs ${values.diff}` : 'full tree'}: ${result.scanned} files, ${result.findings.length} blocking, ${result.grandfathered} grandfathered (0.1.0 baseline), gitleaks ${result.gitleaks}`);
    }
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`leak-gate error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
