import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type SkillLifecycleMode = 'off' | 'shadow' | 'enforce';
export type LifecycleDecision = 'PASS' | 'HOLD' | 'DENY';
export type LifecycleState =
  | 'candidate'
  | 'quarantined'
  | 'approved'
  | 'promoted'
  | 'rejected'
  | 'rolled_back';

export interface LifecycleIssue {
  code: string;
  disposition: 'HOLD' | 'DENY';
  path: string;
  message: string;
}

export interface LifecycleGateResult {
  decision: LifecycleDecision;
  subjectHash: string | null;
  issues: LifecycleIssue[];
}

export interface LifecycleAdvisory {
  disposition: 'ALLOW' | 'WOULD_HOLD';
  gate: LifecycleGateResult;
  reasons: string[];
}

export interface HumanApprovalEvidence {
  kind: 'human' | 'automated';
  actor: string;
  subjectHash?: string;
  tokenHash?: string;
}

export interface GovernedPromotionContext {
  mode?: SkillLifecycleMode;
  lifecycle_root: string;
  manifest_path: string;
  approval: HumanApprovalEvidence;
  gate_path?: string;
  now?: string;
}

export interface GovernedPromotionResult {
  promoted_path: string;
  lifecycle?: {
    advisory: LifecycleAdvisory;
    receipt?: LifecycleReceipt;
    snapshot_path?: string;
  };
}

export type LifecycleReceiptType =
  | 'intake_quarantine'
  | 'human_approval'
  | 'promotion'
  | 'promotion_compensation'
  | 'post_promotion_quarantine'
  | 'rollback'
  | 'evidence_link';

export interface LifecycleReceipt {
  schemaVersion: 1;
  receiptType: LifecycleReceiptType;
  slug: string;
  version: string;
  actor: string;
  subjectHash: string;
  contentHash: string;
  dependencyManifestHash: string;
  priorState: LifecycleState;
  nextState: LifecycleState;
  sourcePath: string;
  destinationPath: string;
  snapshotPath: string | null;
  snapshotTreeHash: string | null;
  evidenceKind:
    | 'human-approval-token'
    | 'promotion-health'
    | 'survivability'
    | 'transaction-compensation'
    | null;
  evidenceHash: string | null;
  observedAt: string;
  result: 'success';
  previousReceiptHash: string | null;
  receiptHash: string;
}

interface LifecycleIdentity {
  slug: string;
  version: string;
  contentHash: string;
  dependencyManifestHash: string;
}

interface LifecycleManifest {
  schemaVersion: number;
  subjectHash: string;
  state: string;
  identity: LifecycleIdentity;
}

interface ReceiptInput extends Omit<LifecycleReceipt, 'schemaVersion' | 'previousReceiptHash' | 'receiptHash'> {}

export class SkillLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLifecycleError';
  }
}

export class LifecycleGateError extends SkillLifecycleError {
  readonly result: LifecycleGateResult;

  constructor(message: string, result: LifecycleGateResult) {
    super(message);
    this.name = 'LifecycleGateError';
    this.result = result;
  }
}

export class LifecycleReceiptChainError extends SkillLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleReceiptChainError';
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_SNAPSHOT_FILES = 4_096;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_GATE_PATH = resolve(
  import.meta.dir,
  '../../../../Skills/skill-security-gate/scripts/lifecycle/gate.ts',
);

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareUtf8)
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new SkillLifecycleError(`canonical JSON rejects undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new SkillLifecycleError(`canonical JSON rejects ${typeof value}`);
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new SkillLifecycleError(`${label} must be an absolute safe path`);
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SkillLifecycleError(`${label} traverses symlink: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new SkillLifecycleError(`unsafe skill slug: ${slug}`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new SkillLifecycleError(`${label} must be a lowercase sha256 digest`);
}

function assertExactPath(observed: string, expected: string, label: string): void {
  if (requireAbsolute(observed, label) !== requireAbsolute(expected, `expected ${label}`)) {
    throw new SkillLifecycleError(`${label} path drift: expected ${resolve(expected)}, got ${resolve(observed)}`);
  }
}

function assertOutside(path: string, root: string, label: string): void {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  const fromRoot = relative(absoluteRoot, absolutePath);
  const fromPath = relative(absolutePath, absoluteRoot);
  const pathInsideRoot = fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..');
  const rootInsidePath = fromPath === '' || (!fromPath.startsWith(`..${sep}`) && fromPath !== '..');
  if (pathInsideRoot || rootInsidePath) throw new SkillLifecycleError(`${label} must be disjoint from ${root}`);
}

function walkRegularFiles(root: string, includeLifecycle = true): Array<{ path: string; bytes: Buffer }> {
  const absoluteRoot = requireAbsolute(root, 'tree root');
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SkillLifecycleError(`root is not a regular directory: ${absoluteRoot}`);
  }
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new SkillLifecycleError(`symlink is not allowed: ${relativePath}`);
      if (stat.isDirectory()) visit(absolutePath, relativePath);
      else if (stat.isFile()) {
        if (includeLifecycle || relativePath !== 'skill-lifecycle.json') {
          files.push({ path: relativePath, bytes: readFileSync(absolutePath) });
        }
      } else throw new SkillLifecycleError(`regular file required: ${relativePath}`);
    }
  };
  visit(absoluteRoot, '');
  return files.sort((a, b) => compareUtf8(a.path, b.path));
}

function treeHash(root: string, includeLifecycle = true): string {
  const files = walkRegularFiles(root, includeLifecycle).map((file) => ({
    path: file.path,
    hash: sha256(file.bytes),
    size: file.bytes.byteLength,
  }));
  return sha256(canonicalJson(files));
}

function copyTreeAtomic(source: string, destination: string): void {
  walkRegularFiles(source);
  if (existsSync(destination)) throw new SkillLifecycleError(`refusing to overwrite ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.tmp-${randomUUID()}`;
  try {
    cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    if (treeHash(staging) !== treeHash(source)) throw new SkillLifecycleError('atomic copy verification failed');
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function makeImmutable(root: string): void {
  for (const file of walkRegularFiles(root)) chmodSync(join(root, ...file.path.split('/')), 0o444);
  const directories: string[] = [];
  const visit = (directory: string): void => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  visit(root);
  for (const directory of directories.reverse()) chmodSync(directory, 0o555);
}

function readManifest(path: string): LifecycleManifest {
  const absolute = requireAbsolute(path, 'manifest_path');
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SkillLifecycleError('lifecycle manifest must be a regular file');
  const value = JSON.parse(readFileSync(absolute, 'utf8')) as Partial<LifecycleManifest>;
  if (!value.identity || typeof value.identity !== 'object') throw new SkillLifecycleError('lifecycle identity is missing');
  const manifest = value as LifecycleManifest;
  assertSlug(manifest.identity.slug);
  assertDigest(manifest.subjectHash, 'subjectHash');
  assertDigest(manifest.identity.contentHash, 'contentHash');
  assertDigest(manifest.identity.dependencyManifestHash, 'dependencyManifestHash');
  if (typeof manifest.identity.version !== 'string' || !manifest.identity.version) {
    throw new SkillLifecycleError('lifecycle version is missing');
  }
  return manifest;
}

export function resolveLifecycleMode(value = process.env.ZOUROBOROS_SKILL_LIFECYCLE_MODE): SkillLifecycleMode {
  if (value === undefined || value === '') return 'off';
  if (value === 'off' || value === 'shadow' || value === 'enforce') return value;
  throw new SkillLifecycleError(`unknown lifecycle mode: ${value}`);
}

export function evaluateLifecycleGate(input: {
  manifest_path: string;
  subject_path: string;
  gate_path?: string;
  now?: string;
}): LifecycleGateResult {
  const gatePath = requireAbsolute(input.gate_path ?? DEFAULT_GATE_PATH, 'gate_path');
  const args = [gatePath, '--manifest', requireAbsolute(input.manifest_path, 'manifest_path'), '--subject', requireAbsolute(input.subject_path, 'subject_path')];
  if (input.now) args.push('--now', input.now);
  const execution = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let parsed: LifecycleGateResult;
  try {
    parsed = JSON.parse(execution.stdout) as LifecycleGateResult;
  } catch {
    throw new SkillLifecycleError(`lifecycle gate produced invalid output: ${execution.stderr.trim() || execution.stdout.trim()}`);
  }
  const expectedExit = parsed.decision === 'PASS' ? 0 : parsed.decision === 'HOLD' ? 3 : 4;
  if (execution.status !== expectedExit) {
    throw new SkillLifecycleError(`lifecycle gate exit mismatch: decision ${parsed.decision}, exit ${execution.status}`);
  }
  return parsed;
}

function receiptPath(lifecycleRoot: string, slug: string): string {
  assertSlug(slug);
  return join(requireAbsolute(lifecycleRoot, 'lifecycle_root'), 'receipts', `${slug}.jsonl`);
}

function receiptBody(receipt: Omit<LifecycleReceipt, 'receiptHash'>): Omit<LifecycleReceipt, 'receiptHash'> {
  return receipt;
}

export function verifyReceiptChain(path: string): LifecycleReceipt[] {
  const absolute = requireAbsolute(path, 'receipt_path');
  if (!existsSync(absolute)) return [];
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new LifecycleReceiptChainError('receipt ledger must be a regular file');
  const lines = readFileSync(absolute, 'utf8').split('\n').filter(Boolean);
  const receipts: LifecycleReceipt[] = [];
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    let current: LifecycleReceipt;
    try {
      current = JSON.parse(line) as LifecycleReceipt;
    } catch {
      throw new LifecycleReceiptChainError(`invalid JSON at receipt ${index}`);
    }
    if (current.previousReceiptHash !== previous) {
      throw new LifecycleReceiptChainError(`broken predecessor at receipt ${index}`);
    }
    const { receiptHash, ...body } = current;
    const expected = sha256(canonicalJson(receiptBody(body)));
    if (receiptHash !== expected) throw new LifecycleReceiptChainError(`invalid hash at receipt ${index}`);
    previous = receiptHash;
    receipts.push(current);
  }
  return receipts;
}

function appendReceipt(lifecycleRoot: string, input: ReceiptInput): LifecycleReceipt {
  const path = receiptPath(lifecycleRoot, input.slug);
  const chain = verifyReceiptChain(path);
  const body: Omit<LifecycleReceipt, 'receiptHash'> = {
    schemaVersion: 1,
    ...input,
    previousReceiptHash: chain.at(-1)?.receiptHash ?? null,
  };
  const receipt: LifecycleReceipt = { ...body, receiptHash: sha256(canonicalJson(body)) };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${canonicalJson(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

function snapshotPath(lifecycleRoot: string, identity: LifecycleIdentity): string {
  return join(
    requireAbsolute(lifecycleRoot, 'lifecycle_root'),
    'snapshots',
    identity.slug,
    `${identity.contentHash.slice(7)}-${identity.dependencyManifestHash.slice(7)}`,
  );
}

function ensureSnapshot(
  source: string,
  lifecycleRoot: string,
  identity: LifecycleIdentity,
): { path: string; hash: string; created: boolean } {
  const path = snapshotPath(lifecycleRoot, identity);
  const files = walkRegularFiles(source);
  const byteCount = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (files.length > MAX_SNAPSHOT_FILES || byteCount > MAX_SNAPSHOT_BYTES) {
    throw new SkillLifecycleError(`snapshot exceeds bound: ${files.length} files, ${byteCount} bytes`);
  }
  if (treeHash(source, false) !== identity.contentHash) {
    throw new SkillLifecycleError('candidate content changed after lifecycle validation');
  }
  const sourceHash = treeHash(source);
  if (existsSync(path)) {
    if (treeHash(path) !== sourceHash || treeHash(path, false) !== identity.contentHash) {
      throw new SkillLifecycleError(`immutable snapshot mismatch at ${path}`);
    }
    return { path, hash: sourceHash, created: false };
  }
  copyTreeAtomic(source, path);
  if (treeHash(path, false) !== identity.contentHash) {
    rmSync(path, { recursive: true, force: true });
    throw new SkillLifecycleError('snapshot content hash does not match approved identity');
  }
  makeImmutable(path);
  return { path, hash: sourceHash, created: true };
}

function removeImmutableTree(root: string): void {
  const directories: string[] = [];
  const visit = (directory: string): void => {
    directories.push(directory);
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else chmodSync(path, 0o644);
    }
  };
  visit(root);
  rmSync(root, { recursive: true, force: true });
}

function advisoryFor(gate: LifecycleGateResult, reasons: string[] = []): LifecycleAdvisory {
  return {
    disposition: gate.decision === 'PASS' && reasons.length === 0 ? 'ALLOW' : 'WOULD_HOLD',
    gate,
    reasons: [...gate.issues.map((entry) => `${entry.code}: ${entry.message}`), ...reasons],
  };
}

function humanApprovalReasons(approval: HumanApprovalEvidence, subjectHash: string): string[] {
  if (approval.kind !== 'human') return ['automated approval cannot authorize lifecycle promotion'];
  const reasons: string[] = [];
  if (approval.subjectHash !== subjectHash) reasons.push('human approval is not bound to the exact lifecycle subject');
  if (!approval.tokenHash || !DIGEST.test(approval.tokenHash)) reasons.push('human approval token hash is missing or invalid');
  return reasons;
}

export function runGovernedPromotion(
  input: {
    candidate_path: string;
    skills_root: string;
    slug: string;
    governed: GovernedPromotionContext;
  },
  legacyMove: () => { promoted_path: string },
): GovernedPromotionResult {
  const mode = resolveLifecycleMode(input.governed.mode);
  if (mode === 'off') return legacyMove();

  let manifest: LifecycleManifest;
  try {
    manifest = readManifest(input.governed.manifest_path);
    assertSlug(input.slug);
    if (manifest.identity.slug !== input.slug) throw new SkillLifecycleError('manifest slug does not match promotion slug');
    assertExactPath(input.governed.manifest_path, join(input.candidate_path, 'skill-lifecycle.json'), 'manifest_path');
    assertOutside(input.governed.lifecycle_root, input.skills_root, 'lifecycle_root');
  } catch (error) {
    if (mode === 'enforce') throw error;
    const result = legacyMove();
    return {
      ...result,
      lifecycle: {
        advisory: advisoryFor(
          { decision: 'DENY', subjectHash: null, issues: [] },
          [error instanceof Error ? error.message : String(error)],
        ),
      },
    };
  }
  let gate: LifecycleGateResult;
  try {
    gate = evaluateLifecycleGate({
      manifest_path: input.governed.manifest_path,
      subject_path: input.candidate_path,
      gate_path: input.governed.gate_path,
      now: input.governed.now,
    });
  } catch (error) {
    if (mode === 'enforce') throw error;
    const result = legacyMove();
    return {
      ...result,
      lifecycle: {
        advisory: advisoryFor({ decision: 'DENY', subjectHash: manifest.subjectHash, issues: [] }, [error instanceof Error ? error.message : String(error)]),
      },
    };
  }

  const reasons: string[] = [];
  if (manifest.state !== 'approved') reasons.push(`manifest state ${manifest.state} is not approved`);
  reasons.push(...humanApprovalReasons(input.governed.approval, manifest.subjectHash));
  const advisory = advisoryFor(gate, reasons);
  if (mode === 'enforce' && (gate.decision !== 'PASS' || reasons.length > 0)) {
    throw new LifecycleGateError(`governed promotion blocked: ${advisory.reasons.join('; ')}`, gate);
  }

  let snapshot: { path: string; hash: string; created: boolean } | undefined;
  try {
    snapshot = ensureSnapshot(input.candidate_path, input.governed.lifecycle_root, manifest.identity);
    verifyReceiptChain(receiptPath(input.governed.lifecycle_root, input.slug));
  } catch (error) {
    if (mode === 'enforce') throw error;
    const result = legacyMove();
    return {
      ...result,
      lifecycle: {
        advisory: advisoryFor(gate, [...reasons, error instanceof Error ? error.message : String(error)]),
      },
    };
  }

  const result = legacyMove();
  let receipt: LifecycleReceipt;
  try {
    receipt = appendReceipt(input.governed.lifecycle_root, {
      receiptType: 'promotion',
      slug: input.slug,
      version: manifest.identity.version,
      actor: input.governed.approval.actor,
      subjectHash: manifest.subjectHash,
      contentHash: manifest.identity.contentHash,
      dependencyManifestHash: manifest.identity.dependencyManifestHash,
      priorState: 'approved',
      nextState: 'promoted',
      sourcePath: resolve(input.candidate_path),
      destinationPath: result.promoted_path,
      snapshotPath: snapshot.path,
      snapshotTreeHash: snapshot.hash,
      evidenceKind: input.governed.approval.tokenHash ? 'human-approval-token' : null,
      evidenceHash: input.governed.approval.tokenHash ?? null,
      observedAt: input.governed.now ?? new Date().toISOString(),
      result: 'success',
    });
  } catch (error) {
    if (mode === 'enforce') {
      try {
        if (existsSync(input.candidate_path) || !existsSync(result.promoted_path)) {
          throw new SkillLifecycleError('promotion rollback preconditions are not satisfied');
        }
        renameSync(result.promoted_path, input.candidate_path);
        if (snapshot.created && existsSync(snapshot.path)) removeImmutableTree(snapshot.path);
      } catch (rollbackError) {
        throw new SkillLifecycleError(
          `promotion receipt failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
    return {
      ...result,
      lifecycle: {
        advisory: advisoryFor(gate, [...reasons, error instanceof Error ? error.message : String(error)]),
        snapshot_path: snapshot.path,
      },
    };
  }
  return { ...result, lifecycle: { advisory, receipt, snapshot_path: snapshot.path } };
}

export function compensateGovernedPromotion(input: {
  skills_root: string;
  lifecycle_root: string;
  candidate_path: string;
  promoted_path: string;
  slug: string;
  actor: string;
  promotion_receipt: LifecycleReceipt;
  reason_hash: string;
  observed_at?: string;
}): LifecycleReceipt {
  assertSlug(input.slug);
  assertDigest(input.reason_hash, 'reason_hash');
  assertOutside(input.lifecycle_root, input.skills_root, 'lifecycle_root');
  assertExactPath(input.candidate_path, join(input.skills_root, '_candidates', input.slug), 'candidate_path');
  assertExactPath(input.promoted_path, join(input.skills_root, input.slug), 'promoted_path');
  if (input.promotion_receipt.receiptType !== 'promotion') {
    throw new SkillLifecycleError('compensation requires a promotion receipt');
  }
  const chain = verifyReceiptChain(receiptPath(input.lifecycle_root, input.slug));
  if (!chain.some((entry) => entry.receiptHash === input.promotion_receipt.receiptHash)) {
    throw new SkillLifecycleError('promotion receipt is absent from the lifecycle chain');
  }
  if (existsSync(input.candidate_path) || !existsSync(input.promoted_path)) {
    throw new SkillLifecycleError('promotion compensation preconditions are not satisfied');
  }
  renameSync(input.promoted_path, input.candidate_path);
  const latest = chain.at(-1) ?? input.promotion_receipt;
  return appendReceipt(input.lifecycle_root, {
    receiptType: 'promotion_compensation',
    slug: input.slug,
    version: input.promotion_receipt.version,
    actor: input.actor,
    subjectHash: input.promotion_receipt.subjectHash,
    contentHash: input.promotion_receipt.contentHash,
    dependencyManifestHash: input.promotion_receipt.dependencyManifestHash,
    priorState: latest.nextState,
    nextState: 'approved',
    sourcePath: input.promoted_path,
    destinationPath: input.candidate_path,
    snapshotPath: input.promotion_receipt.snapshotPath,
    snapshotTreeHash: input.promotion_receipt.snapshotTreeHash,
    evidenceKind: 'transaction-compensation',
    evidenceHash: input.reason_hash,
    observedAt: input.observed_at ?? new Date().toISOString(),
    result: 'success',
  });
}

interface LifecycleMoveInput {
  skills_root: string;
  lifecycle_root: string;
  slug: string;
  manifest_path: string;
  actor: string;
  gate_path?: string;
  now?: string;
}

function validateMoveInput(input: LifecycleMoveInput, subjectPath: string): { manifest: LifecycleManifest; gate: LifecycleGateResult } {
  assertSlug(input.slug);
  assertOutside(input.lifecycle_root, input.skills_root, 'lifecycle_root');
  const manifest = readManifest(input.manifest_path);
  if (manifest.identity.slug !== input.slug) throw new SkillLifecycleError('manifest slug does not match requested slug');
  const gate = evaluateLifecycleGate({
    manifest_path: input.manifest_path,
    subject_path: subjectPath,
    gate_path: input.gate_path,
    now: input.now,
  });
  if (gate.decision !== 'PASS') throw new LifecycleGateError(`lifecycle move blocked by ${gate.decision}`, gate);
  verifyReceiptChain(receiptPath(input.lifecycle_root, input.slug));
  return { manifest, gate };
}

export function quarantineCandidateIntake(input: LifecycleMoveInput & { candidate_path: string }): {
  quarantine_path: string;
  receipt: LifecycleReceipt;
} {
  assertExactPath(input.candidate_path, join(input.skills_root, '_candidates', input.slug), 'candidate_path');
  assertExactPath(input.manifest_path, join(input.candidate_path, 'skill-lifecycle.json'), 'manifest_path');
  const { manifest } = validateMoveInput(input, input.candidate_path);
  if (manifest.state !== 'candidate' && manifest.state !== 'quarantined') {
    throw new SkillLifecycleError(`intake requires candidate or quarantined manifest, found ${manifest.state}`);
  }
  const destination = join(input.lifecycle_root, 'quarantine', input.slug, manifest.subjectHash.slice(7));
  if (existsSync(destination)) throw new SkillLifecycleError(`refusing to overwrite quarantine ${destination}`);
  walkRegularFiles(input.candidate_path);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(input.candidate_path, destination);
  const receipt = appendReceipt(input.lifecycle_root, {
    receiptType: 'intake_quarantine', slug: input.slug, version: manifest.identity.version, actor: input.actor,
    subjectHash: manifest.subjectHash, contentHash: manifest.identity.contentHash,
    dependencyManifestHash: manifest.identity.dependencyManifestHash, priorState: 'candidate', nextState: 'quarantined',
    sourcePath: resolve(input.candidate_path), destinationPath: destination, snapshotPath: null, snapshotTreeHash: null,
    evidenceKind: null, evidenceHash: null, observedAt: input.now ?? new Date().toISOString(), result: 'success',
  });
  return { quarantine_path: destination, receipt };
}

export function approveQuarantinedCandidate(input: LifecycleMoveInput & {
  quarantine_path: string;
  approval: HumanApprovalEvidence;
}): { candidate_path: string; receipt: LifecycleReceipt } {
  const manifest = readManifest(input.manifest_path);
  const approvalProblems = humanApprovalReasons(input.approval, manifest.subjectHash);
  if (approvalProblems.length > 0) throw new SkillLifecycleError(approvalProblems.join('; '));
  const expectedQuarantine = join(input.lifecycle_root, 'quarantine', input.slug, manifest.subjectHash.slice(7));
  assertExactPath(input.quarantine_path, expectedQuarantine, 'quarantine_path');
  assertExactPath(input.manifest_path, join(input.quarantine_path, 'skill-lifecycle.json'), 'manifest_path');
  const validated = validateMoveInput(input, input.quarantine_path).manifest;
  if (validated.state !== 'approved') throw new SkillLifecycleError(`human approval requires approved manifest, found ${validated.state}`);
  const destination = join(input.skills_root, '_candidates', input.slug);
  if (existsSync(destination)) throw new SkillLifecycleError(`refusing to overwrite candidate ${destination}`);
  walkRegularFiles(input.quarantine_path);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(input.quarantine_path, destination);
  const receipt = appendReceipt(input.lifecycle_root, {
    receiptType: 'human_approval', slug: input.slug, version: validated.identity.version, actor: input.approval.actor,
    subjectHash: validated.subjectHash, contentHash: validated.identity.contentHash,
    dependencyManifestHash: validated.identity.dependencyManifestHash, priorState: 'quarantined', nextState: 'approved',
    sourcePath: resolve(input.quarantine_path), destinationPath: destination, snapshotPath: null, snapshotTreeHash: null,
    evidenceKind: input.approval.tokenHash ? 'human-approval-token' : null,
    evidenceHash: input.approval.tokenHash ?? null, observedAt: input.now ?? new Date().toISOString(), result: 'success',
  });
  return { candidate_path: destination, receipt };
}

export function quarantinePromotedSkill(input: LifecycleMoveInput & { promoted_path: string }): {
  quarantine_path: string;
  receipt: LifecycleReceipt;
} {
  assertExactPath(input.promoted_path, join(input.skills_root, input.slug), 'promoted_path');
  assertExactPath(input.manifest_path, join(input.promoted_path, 'skill-lifecycle.json'), 'manifest_path');
  const { manifest } = validateMoveInput(input, input.promoted_path);
  if (manifest.state !== 'promoted' && manifest.state !== 'approved') {
    throw new SkillLifecycleError(`post-promotion quarantine requires promoted version, found ${manifest.state}`);
  }
  const destination = join(input.lifecycle_root, 'quarantine', input.slug, manifest.subjectHash.slice(7));
  if (existsSync(destination)) throw new SkillLifecycleError(`refusing to overwrite quarantine ${destination}`);
  walkRegularFiles(input.promoted_path);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(input.promoted_path, destination);
  const receipt = appendReceipt(input.lifecycle_root, {
    receiptType: 'post_promotion_quarantine', slug: input.slug, version: manifest.identity.version, actor: input.actor,
    subjectHash: manifest.subjectHash, contentHash: manifest.identity.contentHash,
    dependencyManifestHash: manifest.identity.dependencyManifestHash, priorState: 'promoted', nextState: 'quarantined',
    sourcePath: resolve(input.promoted_path), destinationPath: destination, snapshotPath: null, snapshotTreeHash: null,
    evidenceKind: null, evidenceHash: null, observedAt: input.now ?? new Date().toISOString(), result: 'success',
  });
  return { quarantine_path: destination, receipt };
}

export function restoreLastApprovedSkill(input: {
  skills_root: string;
  lifecycle_root: string;
  slug: string;
  actor: string;
  subject_hash: string;
  version: string;
  dependency_manifest_hash: string;
  now?: string;
}): { restored_path: string; receipt: LifecycleReceipt } {
  assertSlug(input.slug);
  assertDigest(input.subject_hash, 'subject_hash');
  assertDigest(input.dependency_manifest_hash, 'dependency_manifest_hash');
  assertOutside(input.lifecycle_root, input.skills_root, 'lifecycle_root');
  const path = receiptPath(input.lifecycle_root, input.slug);
  const chain = verifyReceiptChain(path);
  const approved = [...chain].reverse().find((entry) => entry.receiptType === 'promotion');
  if (!approved) throw new SkillLifecycleError('no approved promotion receipt exists');
  if (
    approved.subjectHash !== input.subject_hash ||
    approved.version !== input.version ||
    approved.dependencyManifestHash !== input.dependency_manifest_hash
  ) throw new SkillLifecycleError('restore request does not match the exact last-approved version');
  if (!approved.snapshotPath || !approved.snapshotTreeHash || !existsSync(approved.snapshotPath)) {
    throw new SkillLifecycleError('last-approved snapshot is unavailable');
  }
  if (treeHash(approved.snapshotPath) !== approved.snapshotTreeHash) {
    throw new SkillLifecycleError('last-approved snapshot hash mismatch');
  }
  if (treeHash(approved.snapshotPath, false) !== approved.contentHash) {
    throw new SkillLifecycleError('last-approved snapshot content identity mismatch');
  }
  const destination = join(requireAbsolute(input.skills_root, 'skills_root'), input.slug);
  if (existsSync(destination)) throw new SkillLifecycleError(`refusing to overwrite ${destination}`);
  copyTreeAtomic(approved.snapshotPath, destination);
  const receipt = appendReceipt(input.lifecycle_root, {
    receiptType: 'rollback', slug: input.slug, version: approved.version, actor: input.actor,
    subjectHash: approved.subjectHash, contentHash: approved.contentHash,
    dependencyManifestHash: approved.dependencyManifestHash, priorState: 'quarantined', nextState: 'rolled_back',
    sourcePath: approved.snapshotPath, destinationPath: destination, snapshotPath: approved.snapshotPath,
    snapshotTreeHash: approved.snapshotTreeHash, evidenceKind: null, evidenceHash: null,
    observedAt: input.now ?? new Date().toISOString(), result: 'success',
  });
  return { restored_path: destination, receipt };
}

export function appendPromotionEvidence(input: {
  lifecycle_root: string;
  slug: string;
  actor: string;
  subject_hash: string;
  evidence_hash: string;
  evidence_kind: 'promotion-health' | 'survivability';
  observed_at?: string;
}): LifecycleReceipt {
  assertSlug(input.slug);
  assertDigest(input.subject_hash, 'subject_hash');
  assertDigest(input.evidence_hash, 'evidence_hash');
  const chain = verifyReceiptChain(receiptPath(input.lifecycle_root, input.slug));
  const promotion = [...chain].reverse().find((entry) => entry.receiptType === 'promotion' && entry.subjectHash === input.subject_hash);
  if (!promotion) throw new SkillLifecycleError('evidence cannot be linked without a matching promotion receipt');
  const latest = [...chain].reverse().find((entry) => entry.subjectHash === input.subject_hash) ?? promotion;
  return appendReceipt(input.lifecycle_root, {
    receiptType: 'evidence_link', slug: input.slug, version: promotion.version, actor: input.actor,
    subjectHash: promotion.subjectHash, contentHash: promotion.contentHash,
    dependencyManifestHash: promotion.dependencyManifestHash, priorState: latest.nextState, nextState: latest.nextState,
    sourcePath: promotion.destinationPath, destinationPath: promotion.destinationPath,
    snapshotPath: promotion.snapshotPath, snapshotTreeHash: promotion.snapshotTreeHash,
    evidenceKind: input.evidence_kind, evidenceHash: input.evidence_hash,
    observedAt: input.observed_at ?? new Date().toISOString(), result: 'success',
  });
}

export function getLifecycleReceiptPath(lifecycleRoot: string, slug: string): string {
  return receiptPath(lifecycleRoot, slug);
}
