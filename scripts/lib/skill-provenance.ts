// Provenance manifest for files under skills/ (provenance/skills.json).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, sha256, type Finding } from './leak-rules.ts';

export const skillsManifestPath = join(repoRoot, 'provenance/skills.json');
export const skillsRoot = 'skills';
export const VERBATIM = 'verbatim';

export interface SkillFileEntry {
  /** Repo-relative distributed path under skills/. */
  path: string;
  /** Source skill entry name (Skills/<skill>) or null for distribution-authored files. */
  skill: string | null;
  /** Source path relative to the source repository root, or null for distribution-authored files. */
  sourcePath: string | null;
  sourceRevision: string | null;
  sourceSha256: string | null;
  distributedSha256: string;
  /** "verbatim" exactly when both hashes match; otherwise what changed and why. */
  adaptation: string;
}

export interface SkillsManifest {
  schema: 'hermes-zouroboros/skill-provenance/v1';
  source: string;
  sourceRevision: string;
  files: SkillFileEntry[];
}

export function loadSkillsManifest(path = skillsManifestPath): SkillsManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as SkillsManifest;
  if (manifest.schema !== 'hermes-zouroboros/skill-provenance/v1') throw new Error(`Unsupported skill provenance schema in ${path}`);
  return manifest;
}

export function saveSkillsManifest(manifest: SkillsManifest, path = skillsManifestPath): void {
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}

/** Internal consistency of one entry, independent of the filesystem. */
export function entryProblems(entry: SkillFileEntry): string[] {
  const problems: string[] = [];
  if (!entry.path.startsWith(`${skillsRoot}/`)) problems.push('path is outside skills/');
  if (!/^[0-9a-f]{64}$/.test(entry.distributedSha256)) problems.push('distributedSha256 is not a SHA-256');
  if (!entry.adaptation?.trim()) problems.push('adaptation note is empty');
  const sourced = entry.sourcePath !== null;
  if (sourced) {
    if (!entry.skill || !entry.sourcePath!.startsWith(`Skills/${entry.skill}/`)) problems.push('sourcePath is not inside Skills/<skill>/');
    if (!entry.sourceRevision) problems.push('sourceRevision is missing');
    if (!/^[0-9a-f]{64}$/.test(entry.sourceSha256 ?? '')) problems.push('sourceSha256 is not a SHA-256');
    const verbatim = entry.sourceSha256 === entry.distributedSha256;
    if (verbatim !== (entry.adaptation.trim() === VERBATIM)) problems.push(verbatim ? 'identical hashes must be noted "verbatim"' : 'adapted file needs an adaptation note other than "verbatim"');
  } else if (entry.skill !== null || entry.sourceRevision !== null || entry.sourceSha256 !== null) {
    problems.push('distribution-authored entries must have null skill/sourceRevision/sourceSha256');
  }
  return problems;
}

/** Every file under skills/ needs an entry whose distributed hash matches; every entry needs its file. */
export function checkSkillProvenance(files: string[], read: (file: string) => Buffer | undefined, manifest: SkillsManifest): Finding[] {
  const findings: Finding[] = [];
  const entries = new Map<string, SkillFileEntry>();
  for (const entry of manifest.files) {
    if (entries.has(entry.path)) findings.push({ kind: 'provenance', rule: 'provenance:duplicate-entry', file: entry.path });
    entries.set(entry.path, entry);
    for (const problem of entryProblems(entry)) findings.push({ kind: 'provenance', rule: 'provenance:invalid-entry', file: entry.path, detail: problem });
  }
  const present = new Set(files.filter((file) => file.startsWith(`${skillsRoot}/`)));
  for (const file of present) {
    const entry = entries.get(file);
    if (!entry) { findings.push({ kind: 'provenance', rule: 'provenance:missing-entry', file }); continue; }
    const content = read(file);
    if (!content) { findings.push({ kind: 'provenance', rule: 'provenance:not-a-regular-file', file }); continue; }
    if (sha256(content) !== entry.distributedSha256) findings.push({ kind: 'provenance', rule: 'provenance:sha256-mismatch', file });
  }
  for (const path of entries.keys()) if (!present.has(path)) findings.push({ kind: 'provenance', rule: 'provenance:stale-entry', file: path });
  return findings;
}
