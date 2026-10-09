#!/usr/bin/env bun
// Skill parity manifest: every source Skills/ entry at the pinned revision has a disposition.
//
//   bun scripts/ci/skills-parity.ts check [--source <repo>]   validate manifest, doc sync and (with source) completeness
//   bun scripts/ci/skills-parity.ts inventory --source <repo>  list source entries (redacted names + hashes) as JSON
//   bun scripts/ci/skills-parity.ts render                     rewrite docs/SKILLS-PARITY.md from the manifest
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listFiles, loadConfig, personalHashes, repoRoot, sha256, type LeakGateConfig } from '../lib/leak-rules.ts';

export const DISPOSITIONS = ['portable', 'adapted', 'host-only', 'dropped', 'hermes-native', 'held-license', 'pending'] as const;
export type Disposition = typeof DISPOSITIONS[number];
const SHIPPED: Disposition[] = ['portable', 'adapted'];

export interface ParityEntry {
  /** Source entry name; operator-identifying tokens are replaced with "operator" (redacted: true). */
  name: string;
  nameSha256: string;
  redacted?: boolean;
  trackedAtRevision: boolean;
  triage: string;
  disposition: Disposition;
  /** Target disposition for pending entries. */
  plannedDisposition?: 'portable' | 'adapted';
  reason: string;
  /** Skill directories under skills/ that carry this entry (portable/adapted). */
  distributedAs?: string[];
  /** Bundled Hermes skill that covers this entry (hermes-native). */
  hermesSkill?: string;
  followUp?: string;
}
export interface ParityManifest {
  schema: 'hermes-zouroboros/skills-parity/v1';
  sourceRevision: string;
  sourceRoot: 'Skills';
  total: number;
  entries: ParityEntry[];
}
export interface InventoryEntry { name: string; nameSha256: string; redacted: boolean; trackedAtRevision: boolean }

export const parityPath = join(repoRoot, 'provenance/skills-parity.json');
export const parityDocPath = join(repoRoot, 'docs/SKILLS-PARITY.md');

export function loadParity(path = parityPath): ParityManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ParityManifest;
  if (manifest.schema !== 'hermes-zouroboros/skills-parity/v1') throw new Error(`Unsupported parity schema in ${path}`);
  return manifest;
}

/** Replace denylisted tokens so operator identifiers never reach the manifest. */
export function redactName(name: string, config: LeakGateConfig): { name: string; redacted: boolean } {
  const denied = new Set(config.personalData.hashes.map((entry) => entry.sha256));
  let redacted = false;
  const parts = name.split(/([^A-Za-z0-9]+)/).map((part) => {
    if (/^[A-Za-z0-9]+$/.test(part) && personalHashes(part, config.personalData.salt).some((hash) => denied.has(hash))) { redacted = true; return 'operator'; }
    return part;
  });
  return { name: parts.join(''), redacted };
}

/** Tracked entries at the revision plus on-disk entries that are untracked (ignored or symlinked in) in the source checkout. */
export function inventory(source: string, revision: string, config: LeakGateConfig): InventoryEntry[] {
  const tracked = new Set(execFileSync('git', ['-C', source, 'ls-tree', '--name-only', revision, 'Skills/'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((path) => path.replace(/^Skills\//, '')));
  const onDisk = existsSync(join(source, 'Skills')) ? readdirSync(join(source, 'Skills')) : [];
  const names = [...new Set([...tracked, ...onDisk])].sort();
  return names.map((name) => ({ ...redactName(name, config), nameSha256: sha256(name), trackedAtRevision: tracked.has(name) }));
}

export function checkParity(root: string, manifest: ParityManifest, source?: string): { problems: string[]; counts: Record<string, number> } {
  const problems: string[] = [];
  const counts = Object.fromEntries(DISPOSITIONS.map((name) => [name, 0])) as Record<string, number>;
  const seen = new Set<string>();
  const skillDirs = new Set(listFiles(root).filter((file) => /^skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(file)).map((file) => file.replace(/\/SKILL\.md$/, '')));
  const claimed = new Set<string>();
  for (const entry of manifest.entries) {
    const label = entry.name;
    if (seen.has(entry.nameSha256)) problems.push(`${label}: duplicate entry`);
    seen.add(entry.nameSha256);
    if (!entry.redacted && sha256(entry.name) !== entry.nameSha256) problems.push(`${label}: nameSha256 does not match name`);
    if (!DISPOSITIONS.includes(entry.disposition)) { problems.push(`${label}: unknown disposition ${entry.disposition}`); continue; }
    counts[entry.disposition]!++;
    if (!entry.reason?.trim()) problems.push(`${label}: reason is empty`);
    if (entry.disposition === 'pending' && !entry.plannedDisposition) problems.push(`${label}: pending entries need plannedDisposition`);
    if (SHIPPED.includes(entry.disposition)) {
      if (!entry.distributedAs?.length) problems.push(`${label}: ${entry.disposition} entries need distributedAs`);
      for (const dir of entry.distributedAs ?? []) {
        if (!skillDirs.has(dir)) problems.push(`${label}: distributedAs ${dir} has no SKILL.md`);
        claimed.add(dir);
      }
    } else if (entry.distributedAs?.length) problems.push(`${label}: only portable/adapted entries may list distributedAs`);
    if (entry.disposition === 'hermes-native' && !entry.hermesSkill) problems.push(`${label}: hermes-native entries need hermesSkill`);
  }
  for (const dir of skillDirs) if (!claimed.has(dir)) problems.push(`${dir}: skill directory is not claimed by any portable/adapted parity entry`);
  if (manifest.entries.length !== manifest.total) problems.push(`manifest lists ${manifest.entries.length} entries but total is ${manifest.total}`);
  if (source) {
    const config = loadConfig(join(root, 'provenance/leak-gate.json'));
    const current = inventory(source, manifest.sourceRevision, config);
    for (const entry of current) if (!seen.has(entry.nameSha256)) problems.push(`${entry.name}: source entry missing from parity manifest`);
    const sourceHashes = new Set(current.map((entry) => entry.nameSha256));
    for (const entry of manifest.entries) if (!sourceHashes.has(entry.nameSha256)) problems.push(`${entry.name}: not present in source at ${manifest.sourceRevision}`);
    if (current.length !== manifest.total) problems.push(`source has ${current.length} entries but manifest total is ${manifest.total}`);
  }
  const docPath = join(root, 'docs/SKILLS-PARITY.md');
  if (!existsSync(docPath) || readFileSync(docPath, 'utf8') !== renderParity(manifest)) problems.push('docs/SKILLS-PARITY.md is out of date; run: bun scripts/ci/skills-parity.ts render');
  return { problems, counts };
}

const cell = (text: string | undefined) => (text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderParity(manifest: ParityManifest): string {
  const counts = DISPOSITIONS.map((disposition) => [disposition, manifest.entries.filter((entry) => entry.disposition === disposition).length] as const);
  const planned = (target: string) => manifest.entries.filter((entry) => entry.disposition === 'pending' && entry.plannedDisposition === target).length;
  const lines = [
    '# Skill parity manifest',
    '',
    '<!-- Generated from provenance/skills-parity.json by `bun scripts/ci/skills-parity.ts render`. Do not edit by hand. -->',
    '',
    `Source: the Zouroboros VPS workspace \`Skills/\` tree at revision \`${manifest.sourceRevision}\` — ${manifest.total} entries.`,
    'CI fails if an entry is missing, a disposition lacks a reason, or a shipped skill directory is unclaimed.',
    'Entry names containing operator identifiers are redacted to `operator`; the manifest keeps the SHA-256 of the real name for completeness checks.',
    '',
    '| Disposition | Count |',
    '| --- | ---: |',
    ...counts.map(([disposition, count]) => `| ${disposition} | ${count} |`),
    `| **total** | **${manifest.entries.length}** |`,
    '',
    `Pending work: ${planned('portable')} planned portable, ${planned('adapted')} planned adapted.`,
    '',
    'Dispositions: `portable` ships unchanged apart from recorded hashes; `adapted` ships with recorded changes; `host-only` stays on the VPS; `dropped` is not a skill or is retired at the source; `hermes-native` is covered by a bundled Hermes skill; `held-license` awaits a licensing decision; `pending` is not yet ported.',
    '',
    '| Entry | Triage | Disposition | Planned | Tracked at revision | Distributed as | Reason | Follow-up |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...manifest.entries.map((entry) => `| \`${cell(entry.name)}\`${entry.redacted ? ' (redacted)' : ''} | ${cell(entry.triage)} | ${entry.disposition} | ${entry.plannedDisposition ?? ''} | ${entry.trackedAtRevision ? 'yes' : 'no'} | ${(entry.distributedAs ?? []).map((dir) => `\`${dir}\``).join(', ')}${entry.hermesSkill ? `Hermes \`${entry.hermesSkill}\`` : ''} | ${cell(entry.reason)} | ${cell(entry.followUp)} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const [command = 'check', ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: { source: { type: 'string' }, root: { type: 'string' } } });
  const root = resolve(values.root ?? repoRoot);
  const source = values.source ?? process.env.ZOUROBOROS_SOURCE_REPO;
  try {
    const manifest = loadParity(join(root, 'provenance/skills-parity.json'));
    if (command === 'render') {
      writeFileSync(join(root, 'docs/SKILLS-PARITY.md'), renderParity(manifest));
      console.log('Rendered docs/SKILLS-PARITY.md');
    } else if (command === 'inventory') {
      if (!source) throw new Error('inventory requires --source');
      console.log(JSON.stringify(inventory(source, manifest.sourceRevision, loadConfig(join(root, 'provenance/leak-gate.json'))), null, 2));
    } else if (command === 'check') {
      const { problems, counts } = checkParity(root, manifest, source);
      for (const problem of problems) console.log(`FAIL ${problem}`);
      console.log(`skills parity @ ${manifest.sourceRevision.slice(0, 12)}: ${manifest.entries.length}/${manifest.total} entries — ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(', ')}${source ? ' (completeness verified against source)' : ' (source not available; manifest self-check only)'}`);
      process.exitCode = problems.length ? 1 : 0;
    } else throw new Error(`unknown command ${command}`);
  } catch (error) {
    console.error(`skills-parity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
