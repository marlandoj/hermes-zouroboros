import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { z } from 'zod';
import type { SecretReference } from '../types.js';

type Environment = Record<string, string | undefined>;

const environmentName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Environment secret name must use uppercase letters, digits, and underscores');

export const EnvironmentSecretReferenceSchema = z
  .object({
    kind: z.literal('env'),
    name: environmentName,
    required: z.boolean().optional(),
  })
  .strict();

export const FileSecretReferenceSchema = z
  .object({
    kind: z.literal('file'),
    path: z
      .string()
      .min(1, 'Secret file path must not be empty')
      .refine((path) => path.startsWith('/') || path === '~' || path.startsWith('~/'), {
        message: 'Secret file path must resolve to an absolute path',
      }),
    required: z.boolean().optional(),
  })
  .strict();

export const SecretReferenceSchema = z.discriminatedUnion('kind', [
  EnvironmentSecretReferenceSchema,
  FileSecretReferenceSchema,
]);

export const SecretReferencesSchema = z.record(
  z.string().min(1, 'Secret reference key must not be empty'),
  SecretReferenceSchema
);

export class SecretReferenceError extends Error {
  constructor(message: string, public readonly referenceName: string) {
    super(message);
    this.name = 'SecretReferenceError';
  }
}

export interface ValidateSecretReferencesOptions {
  env?: Environment;
  homeDir?: string;
}

function resolveFilePath(path: string, homeDir: string): string {
  const expanded = path === '~'
    ? homeDir
    : path.startsWith('~/')
      ? join(homeDir, path.slice(2))
      : path;
  if (!isAbsolute(expanded)) {
    throw new Error('Secret file path must resolve to an absolute path');
  }
  return resolve(expanded);
}

export function validateSecretReferences(
  references: Record<string, SecretReference>,
  options: ValidateSecretReferencesOptions = {}
): void {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();

  for (const [name, reference] of Object.entries(references)) {
    const parsed = SecretReferenceSchema.safeParse(reference);
    if (!parsed.success) {
      throw new SecretReferenceError(parsed.error.issues[0]?.message ?? 'Malformed secret reference', name);
    }
    if (reference.required === false) continue;

    if (reference.kind === 'env') {
      if (!env[reference.name]?.trim()) {
        throw new SecretReferenceError(`Required environment secret ${reference.name} is unresolved`, name);
      }
      continue;
    }

    let path: string;
    try {
      path = resolveFilePath(reference.path, homeDir);
    } catch (error) {
      throw new SecretReferenceError(error instanceof Error ? error.message : String(error), name);
    }
    if (!existsSync(path)) {
      throw new SecretReferenceError(`Required secret file ${path} does not exist`, name);
    }
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) {
      throw new SecretReferenceError(`Required secret file ${path} must be a non-empty regular file`, name);
    }
  }
}
