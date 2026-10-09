import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import type {
  DependencyIdentity,
  EvaluationTaskClass,
  HumanOverrideRecord,
  Sha256Digest,
  SkillVersionIdentity,
} from './types.js';

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('canonical JSON accepts plain objects only');
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareUtf8)
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalHash(value: unknown): Sha256Digest {
  return sha256(canonicalJson(value));
}

export function normalizeRelativePath(input: string): string {
  if (!input || input.includes('\0')) throw new Error('path must be non-empty and contain no NUL');
  const forward = input.replaceAll('\\', '/');
  if (isAbsolute(input) || forward.startsWith('/') || /^[A-Za-z]:\//.test(forward)) {
    throw new Error(`absolute path is not allowed: ${input}`);
  }
  if (forward.split('/').includes('..')) throw new Error(`path traversal is not allowed: ${input}`);
  const normalized = posix.normalize(forward);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`path traversal is not allowed: ${input}`);
  }
  return normalized;
}

function assertRegularPath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...normalized.split('/'));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  let current = absoluteRoot;
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`root is not a regular directory: ${root}`);
  for (const segment of normalized.split('/')) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relativePath}`);
  }
  if (!lstatSync(absolute).isFile()) throw new Error(`regular file required: ${relativePath}`);
  return absolute;
}

export function hashFileSet(root: string, relativePaths: string[]): {
  contentHash: Sha256Digest;
  files: Array<{ path: string; hash: Sha256Digest; size: number }>;
} {
  const normalized = relativePaths.map(normalizeRelativePath);
  if (new Set(normalized).size !== normalized.length) throw new Error('duplicate canonical path');
  const files = normalized.sort(compareUtf8).map((path) => {
    const content = readFileSync(assertRegularPath(root, path));
    return { path, hash: sha256(content), size: content.byteLength };
  });
  return { contentHash: canonicalHash(files), files };
}

export function hashDirectory(
  root: string,
  excludedPaths: string[] = ['skill-lifecycle.json'],
): ReturnType<typeof hashFileSet> {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`root is not a regular directory: ${root}`);
  }
  const excluded = new Set(excludedPaths.map(normalizeRelativePath));
  const files: string[] = [];
  const visit = (relativeDir: string): void => {
    const absoluteDir = relativeDir ? join(absoluteRoot, ...relativeDir.split('/')) : absoluteRoot;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      const absolutePath = join(absoluteRoot, ...relativePath.split('/'));
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relativePath}`);
      if (stat.isDirectory()) visit(relativePath);
      else if (stat.isFile()) {
        if (!excluded.has(relativePath)) files.push(relativePath);
      } else {
        throw new Error(`regular file required: ${relativePath}`);
      }
    }
  };
  visit('');
  return hashFileSet(absoluteRoot, files);
}

export function dependencyManifestHash(dependencies: DependencyIdentity[]): Sha256Digest {
  const stable = [...dependencies].sort((a, b) => {
    return compareUtf8(`${a.manager}\0${a.name}\0${a.versionOrRevision}`, `${b.manager}\0${b.name}\0${b.versionOrRevision}`);
  });
  return canonicalHash(stable);
}

export function subjectHash(identity: SkillVersionIdentity): Sha256Digest {
  const sorted = (values: string[]) => [...values].sort(compareUtf8);
  const normalized = {
    ...identity,
    capabilities: {
      tools: sorted(identity.capabilities.tools),
      filesystem: {
        read: sorted(identity.capabilities.filesystem.read),
        write: sorted(identity.capabilities.filesystem.write),
      },
      process: {
        spawn: identity.capabilities.process.spawn,
        commands: sorted(identity.capabilities.process.commands),
      },
      network: {
        hosts: sorted(identity.capabilities.network.hosts),
        protocols: sorted(identity.capabilities.network.protocols),
      },
    },
    credentials: [...identity.credentials].sort((a, b) => compareUtf8(`${a.class}\0${a.envName}`, `${b.class}\0${b.envName}`)),
    dependencies: [...identity.dependencies].sort((a, b) => compareUtf8(`${a.manager}\0${a.name}\0${a.versionOrRevision}`, `${b.manager}\0${b.name}\0${b.versionOrRevision}`)),
  };
  return canonicalHash({ schemaVersion: 1, identity: normalized });
}

export function taskClassHash(task: EvaluationTaskClass): Sha256Digest {
  return canonicalHash({ ...task, fixtureHashes: [...task.fixtureHashes].sort(compareUtf8) });
}

export function evaluationContractHash(taskClasses: EvaluationTaskClass[]): Sha256Digest {
  return canonicalHash(
    [...taskClasses]
      .map((task) => ({ ...task, fixtureHashes: [...task.fixtureHashes].sort(compareUtf8) }))
      .sort((a, b) => compareUtf8(`${a.name}\0${a.version}`, `${b.name}\0${b.version}`)),
  );
}

export function overrideRecordHash(record: Omit<HumanOverrideRecord, 'recordHash'>): Sha256Digest {
  return canonicalHash(record);
}
