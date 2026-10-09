#!/usr/bin/env bun
// Allowlisted skill importer. Copies one reviewed file at a time from the source workspace at the
// pinned revision (`git show <rev>:<path>`), never a whole directory, and records both hashes.
//
//   bun scripts/import-skill.ts add --source <repo> --skill <entry> --file <path in entry> --dest skills/<category>/<name>/<path>
//   bun scripts/import-skill.ts rehash --path skills/... --note "what was adapted and why"
//   bun scripts/import-skill.ts author --path skills/... --note "why the distribution adds this file"
//   bun scripts/import-skill.ts verify [--source <repo>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { blockedPathRule, exceptionFor, loadConfig, repoRoot, sha256 } from './lib/leak-rules.ts';
import { entryProblems, loadSkillsManifest, saveSkillsManifest, VERBATIM, type SkillFileEntry, type SkillsManifest } from './lib/skill-provenance.ts';
import { loadParity } from './ci/skills-parity.ts';

export interface ImportOptions { root?: string; source: string; skill: string; file: string; dest: string; revision?: string }

function safeRelative(path: string, prefix: string): string {
  const clean = normalize(path).replace(/\\/g, '/');
  if (clean.startsWith('/') || clean.split('/').includes('..') || !clean.startsWith(prefix)) throw new Error(`Path must stay under ${prefix}: ${path}`);
  return clean;
}

/** Blob content at revision; refuses untracked files, symlinks and submodules. */
export function sourceBlob(source: string, revision: string, sourcePath: string): Buffer {
  const listing = execFileSync('git', ['-C', source, 'ls-tree', revision, '--', sourcePath], { encoding: 'utf8' }).trim();
  if (!listing) throw new Error(`${sourcePath} is not tracked at ${revision}; commit it in the source repository first`);
  const mode = listing.split(/\s+/)[0];
  if (mode !== '100644' && mode !== '100755') throw new Error(`${sourcePath} is not a regular file at ${revision} (mode ${mode})`);
  return execFileSync('git', ['-C', source, 'show', `${revision}:${sourcePath}`], { maxBuffer: 64 * 1024 * 1024 });
}

export function importFile(options: ImportOptions): SkillFileEntry {
  const root = resolve(options.root ?? repoRoot);
  const manifestPath = join(root, 'provenance/skills.json');
  const manifest = loadSkillsManifest(manifestPath);
  const config = loadConfig(join(root, 'provenance/leak-gate.json'));
  const revision = options.revision ?? manifest.sourceRevision;
  const parity = loadParity(join(root, 'provenance/skills-parity.json'));
  if (!parity.entries.some((entry) => entry.name === options.skill)) throw new Error(`Unknown source skill entry: ${options.skill}`);
  if (parity.sourceRevision !== revision) throw new Error(`Revision ${revision} differs from the pinned parity revision ${parity.sourceRevision}`);
  const file = safeRelative(options.file, '');
  const sourcePath = `Skills/${options.skill}/${file}`;
  const dest = safeRelative(options.dest, 'skills/');
  if (manifest.files.some((entry) => entry.path === dest)) throw new Error(`${dest} already has a provenance entry; use rehash after adapting it`);
  const content = sourceBlob(options.source, revision, sourcePath);
  for (const [label, path] of [['source', sourcePath], ['destination', dest]] as const) {
    const rule = blockedPathRule(path, config);
    if (rule && !exceptionFor(dest, content, rule, config)) throw new Error(`Refusing blocked ${label} path ${path} (${rule}); add a reviewed exception pinned to its sha256 first`);
  }
  const digest = sha256(content);
  const entry: SkillFileEntry = {
    path: dest, skill: options.skill, sourcePath, sourceRevision: revision,
    sourceSha256: digest, distributedSha256: digest, adaptation: VERBATIM,
  };
  mkdirSync(dirname(join(root, dest)), { recursive: true });
  writeFileSync(join(root, dest), content, { flag: 'wx' });
  manifest.files.push(entry);
  saveSkillsManifest(manifest, manifestPath);
  return entry;
}

export function rehash(root: string, path: string, note: string): SkillFileEntry {
  const manifestPath = join(root, 'provenance/skills.json');
  const manifest = loadSkillsManifest(manifestPath);
  const entry = manifest.files.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`${path} has no provenance entry`);
  entry.distributedSha256 = sha256(readFileSync(join(root, path)));
  entry.adaptation = note.trim();
  const problems = entryProblems(entry);
  if (problems.length) throw new Error(problems.join('; '));
  saveSkillsManifest(manifest, manifestPath);
  return entry;
}

export function author(root: string, path: string, note: string): SkillFileEntry {
  const manifestPath = join(root, 'provenance/skills.json');
  const manifest = loadSkillsManifest(manifestPath);
  const dest = safeRelative(path, 'skills/');
  if (manifest.files.some((entry) => entry.path === dest)) throw new Error(`${dest} already has a provenance entry`);
  const entry: SkillFileEntry = { path: dest, skill: null, sourcePath: null, sourceRevision: null, sourceSha256: null,
    distributedSha256: sha256(readFileSync(join(root, dest))), adaptation: note.trim() };
  const problems = entryProblems(entry);
  if (problems.length) throw new Error(problems.join('; '));
  manifest.files.push(entry);
  saveSkillsManifest(manifest, manifestPath);
  return entry;
}

export function verify(root: string, manifest: SkillsManifest, source?: string): string[] {
  const problems: string[] = [];
  for (const entry of manifest.files) {
    for (const problem of entryProblems(entry)) problems.push(`${entry.path}: ${problem}`);
    const full = join(root, entry.path);
    if (!existsSync(full)) problems.push(`${entry.path}: file missing`);
    else if (sha256(readFileSync(full)) !== entry.distributedSha256) problems.push(`${entry.path}: distributed sha256 mismatch`);
    if (source && entry.sourcePath) {
      try {
        if (sha256(sourceBlob(source, entry.sourceRevision!, entry.sourcePath)) !== entry.sourceSha256) problems.push(`${entry.path}: source sha256 mismatch at ${entry.sourceRevision}`);
      } catch (error) { problems.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return problems;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    source: { type: 'string' }, skill: { type: 'string' }, file: { type: 'string' }, dest: { type: 'string' },
    path: { type: 'string' }, note: { type: 'string' }, revision: { type: 'string' },
  } });
  const source = values.source ?? process.env.ZOUROBOROS_SOURCE_REPO;
  try {
    if (command === 'add') {
      if (!source || !values.skill || !values.file || !values.dest) throw new Error('add requires --source (or ZOUROBOROS_SOURCE_REPO), --skill, --file and --dest');
      console.log(JSON.stringify(importFile({ source, skill: values.skill, file: values.file, dest: values.dest, revision: values.revision }), null, 2));
    } else if (command === 'rehash' || command === 'author') {
      if (!values.path || !values.note) throw new Error(`${command} requires --path and --note`);
      console.log(JSON.stringify((command === 'rehash' ? rehash : author)(repoRoot, values.path, values.note), null, 2));
    } else if (command === 'verify') {
      const problems = verify(repoRoot, loadSkillsManifest(), source);
      for (const problem of problems) console.log(`FAIL ${problem}`);
      console.log(`skill provenance: ${loadSkillsManifest().files.length} entries, ${problems.length} problems${source ? '' : ' (source hashes not rechecked; pass --source)'}`);
      process.exitCode = problems.length ? 1 : 0;
    } else {
      console.log('usage: import-skill.ts add|rehash|author|verify (see header comment)');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`import-skill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
