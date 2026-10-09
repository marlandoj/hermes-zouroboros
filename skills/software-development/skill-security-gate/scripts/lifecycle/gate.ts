import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  canonicalHash,
  dependencyManifestHash,
  evaluationContractHash,
  hashDirectory,
  overrideRecordHash,
  subjectHash,
  taskClassHash,
} from './canonical.js';
import type {
  CompatibilityRow,
  DeterministicSecurityEvidence,
  EvaluationTaskClass,
  HumanOverrideRecord,
  LifecycleGateResult,
  LifecycleIssue,
  LifecycleState,
  ModelSecurityEvidence,
  SecurityVerdict,
  Sha256Digest,
  SkillLifecycleRecord,
} from './types.js';

const STATES = new Set<LifecycleState>(['candidate', 'quarantined', 'approved', 'promoted', 'rejected', 'rolled_back']);
const TRANSITIONS = new Set([
  'candidate->quarantined',
  'quarantined->approved',
  'approved->promoted',
  'promoted->quarantined',
  'quarantined->rolled_back',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface LifecycleGateOptions {
  now?: Date | string | number;
  requireModelEvidence?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function issue(issues: LifecycleIssue[], code: string, disposition: 'HOLD' | 'DENY', path: string, message: string): void {
  issues.push({ code, disposition, path, message });
}

function requireString(value: unknown, path: string, issues: LifecycleIssue[]): value is string {
  if (typeof value === 'string' && value.trim().length > 0) return true;
  issue(issues, 'MISSING_FIELD', 'HOLD', path, 'non-empty string is required');
  return false;
}

function requireHash(value: unknown, path: string, issues: LifecycleIssue[]): value is Sha256Digest {
  if (typeof value === 'string' && SHA256.test(value)) return true;
  issue(issues, 'INVALID_HASH', 'DENY', path, 'lowercase sha256 digest is required');
  return false;
}

function validateStringSet(value: unknown, path: string, issues: LifecycleIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, 'MISSING_FIELD', 'HOLD', path, 'array is required');
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    issue(issues, 'INVALID_FIELD', 'DENY', path, 'entries must be non-empty strings');
  }
  if (new Set(value).size !== value.length) issue(issues, 'DUPLICATE_ENTRY', 'DENY', path, 'entries must be unique');
}

function validateTimeWindow(value: Record<string, unknown>, path: string, nowMs: number, issues: LifecycleIssue[]): void {
  if (!requireString(value.issuedAt, `${path}.issuedAt`, issues) || !requireString(value.validUntil, `${path}.validUntil`, issues)) return;
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.validUntil);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    issue(issues, 'INVALID_EVIDENCE_WINDOW', 'DENY', path, 'evidence timestamps must form a positive validity window');
    return;
  }
  if (issued > nowMs + 5 * 60_000) issue(issues, 'FUTURE_EVIDENCE', 'DENY', `${path}.issuedAt`, 'evidence is issued in the future');
  if (expires <= nowMs) issue(issues, 'STALE_EVIDENCE', 'DENY', `${path}.validUntil`, 'evidence has expired');
}

function validateIdentity(raw: unknown, issues: LifecycleIssue[]): raw is SkillLifecycleRecord['identity'] {
  const identity = record(raw);
  if (!identity) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'identity', 'identity is required');
    return false;
  }
  requireString(identity.slug, 'identity.slug', issues);
  if (!requireString(identity.version, 'identity.version', issues) || !SEMVER.test(identity.version)) {
    issue(issues, 'INVALID_VERSION', 'DENY', 'identity.version', 'semantic version is required');
  }
  requireHash(identity.contentHash, 'identity.contentHash', issues);
  requireHash(identity.dependencyManifestHash, 'identity.dependencyManifestHash', issues);

  const source = record(identity.source);
  if (!source) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.source', 'source provenance is required');
  } else {
    if (!['git', 'registry', 'local', 'generated'].includes(String(source.kind))) {
      issue(issues, 'INVALID_SOURCE', 'DENY', 'identity.source.kind', 'unknown source kind');
    }
    if (requireString(source.canonicalUri, 'identity.source.canonicalUri', issues)) {
      try {
        const parsed = new URL(source.canonicalUri);
        if (!parsed.protocol || parsed.username || parsed.password || parsed.hash || parsed.href !== source.canonicalUri) throw new Error('non-canonical URI');
      } catch {
        issue(issues, 'INVALID_SOURCE', 'DENY', 'identity.source.canonicalUri', 'absolute URI without credentials or fragment is required');
      }
    }
    requireString(source.immutableRevision, 'identity.source.immutableRevision', issues);
    const signature = record(source.signature);
    if (!signature) {
      issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.source.signature', 'source signature is required');
    } else {
      if (!['git-commit', 'sigstore', 'minisign', 'sha256'].includes(String(signature.scheme))) {
        issue(issues, 'INVALID_SOURCE_SIGNATURE', 'DENY', 'identity.source.signature.scheme', 'unknown signature scheme');
      }
      requireString(signature.signer, 'identity.source.signature.signer', issues);
      requireHash(signature.signatureHash, 'identity.source.signature.signatureHash', issues);
    }
  }

  const capabilities = record(identity.capabilities);
  if (!capabilities) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.capabilities', 'capability scope is required');
  } else {
    validateStringSet(capabilities.tools, 'identity.capabilities.tools', issues);
    const filesystem = record(capabilities.filesystem);
    if (!filesystem) issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.capabilities.filesystem', 'filesystem scope is required');
    else {
      validateStringSet(filesystem.read, 'identity.capabilities.filesystem.read', issues);
      validateStringSet(filesystem.write, 'identity.capabilities.filesystem.write', issues);
    }
    const process = record(capabilities.process);
    if (!process) issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.capabilities.process', 'process scope is required');
    else {
      if (typeof process.spawn !== 'boolean') issue(issues, 'INVALID_FIELD', 'DENY', 'identity.capabilities.process.spawn', 'boolean is required');
      validateStringSet(process.commands, 'identity.capabilities.process.commands', issues);
    }
    const network = record(capabilities.network);
    if (!network) issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.capabilities.network', 'network scope is required');
    else {
      validateStringSet(network.hosts, 'identity.capabilities.network.hosts', issues);
      validateStringSet(network.protocols, 'identity.capabilities.network.protocols', issues);
      if (Array.isArray(network.protocols) && network.protocols.some((item) => !['http', 'https', 'tcp', 'udp'].includes(String(item)))) {
        issue(issues, 'INVALID_CAPABILITY', 'DENY', 'identity.capabilities.network.protocols', 'unknown network protocol');
      }
    }
  }

  if (!Array.isArray(identity.credentials)) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.credentials', 'credential declarations are required');
  } else {
    const credentialKeys = new Set<string>();
    for (const [index, item] of identity.credentials.entries()) {
      const credential = record(item);
      const path = `identity.credentials[${index}]`;
      if (!credential) {
        issue(issues, 'INVALID_CREDENTIAL', 'DENY', path, 'credential declaration must be an object');
        continue;
      }
      const unexpected = Object.keys(credential).filter((key) => !['class', 'envName'].includes(key));
      if (unexpected.length > 0) issue(issues, 'CREDENTIAL_VALUE_FORBIDDEN', 'DENY', path, `only class and envName are allowed; found ${unexpected.join(', ')}`);
      if (!['api-key', 'oauth-token', 'access-token', 'certificate', 'password', 'other'].includes(String(credential.class))) {
        issue(issues, 'INVALID_CREDENTIAL', 'DENY', `${path}.class`, 'unknown credential class');
      }
      if (!requireString(credential.envName, `${path}.envName`, issues) || !/^[A-Z][A-Z0-9_]*$/.test(String(credential.envName))) {
        issue(issues, 'INVALID_CREDENTIAL', 'DENY', `${path}.envName`, 'environment-variable name is required');
      }
      const key = `${credential.class}\0${credential.envName}`;
      if (credentialKeys.has(key)) issue(issues, 'DUPLICATE_ENTRY', 'DENY', path, 'credential declarations must be unique');
      credentialKeys.add(key);
    }
  }

  if (!Array.isArray(identity.dependencies)) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'identity.dependencies', 'dependency identities are required');
  } else {
    const dependencyKeys = new Set<string>();
    for (const [index, item] of identity.dependencies.entries()) {
      const dependency = record(item);
      const path = `identity.dependencies[${index}]`;
      if (!dependency) {
        issue(issues, 'INVALID_DEPENDENCY', 'DENY', path, 'dependency must be an object');
        continue;
      }
      requireString(dependency.name, `${path}.name`, issues);
      if (!['bun', 'npm', 'pnpm', 'python', 'git', 'system', 'other'].includes(String(dependency.manager))) {
        issue(issues, 'INVALID_DEPENDENCY', 'DENY', `${path}.manager`, 'unknown dependency manager');
      }
      requireString(dependency.versionOrRevision, `${path}.versionOrRevision`, issues);
      requireHash(dependency.integrity, `${path}.integrity`, issues);
      const key = `${dependency.manager}\0${dependency.name}`;
      if (dependencyKeys.has(key)) issue(issues, 'DUPLICATE_ENTRY', 'DENY', path, 'dependency identities must be unique');
      dependencyKeys.add(key);
    }
    if (requireHash(identity.dependencyManifestHash, 'identity.dependencyManifestHash', issues)) {
      try {
        if (dependencyManifestHash(identity.dependencies as SkillLifecycleRecord['identity']['dependencies']) !== identity.dependencyManifestHash) {
          issue(issues, 'DEPENDENCY_HASH_MISMATCH', 'DENY', 'identity.dependencyManifestHash', 'dependency manifest does not match declared dependencies');
        }
      } catch {
        issue(issues, 'DEPENDENCY_HASH_MISMATCH', 'DENY', 'identity.dependencyManifestHash', 'dependency manifest cannot be canonicalized');
      }
    }
  }
  return true;
}

function validateEvidenceReference(
  evidence: Record<string, unknown>,
  path: string,
  expectedSubject: string,
  nowMs: number,
  issues: LifecycleIssue[],
): void {
  if (requireHash(evidence.subjectHash, `${path}.subjectHash`, issues) && evidence.subjectHash !== expectedSubject) {
    issue(issues, 'EVIDENCE_SUBJECT_MISMATCH', 'DENY', `${path}.subjectHash`, 'evidence is bound to a different subject');
  }
  if (!['pass', 'review', 'deny'].includes(String(evidence.verdict))) issue(issues, 'INVALID_VERDICT', 'DENY', `${path}.verdict`, 'unknown security verdict');
  requireHash(evidence.reportHash, `${path}.reportHash`, issues);
  requireString(evidence.policyVersion, `${path}.policyVersion`, issues);
  validateTimeWindow(evidence, path, nowMs, issues);
}

function validateOverrideChain(
  values: unknown,
  expectedSubject: string,
  evidenceByHash: Map<string, SecurityVerdict>,
  issues: LifecycleIssue[],
): HumanOverrideRecord[] {
  if (!Array.isArray(values)) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'security.humanOverrides', 'human override trail is required');
    return [];
  }
  const overrides: HumanOverrideRecord[] = [];
  let previous: string | null = null;
  let previousDecisionMs = Number.NEGATIVE_INFINITY;
  for (const [index, item] of values.entries()) {
    const value = record(item);
    const path = `security.humanOverrides[${index}]`;
    if (!value) {
      issue(issues, 'BROKEN_OVERRIDE_CHAIN', 'DENY', path, 'override record must be an object');
      continue;
    }
    requireString(value.actor, `${path}.actor`, issues);
    requireString(value.reason, `${path}.reason`, issues);
    if (requireString(value.decidedAt, `${path}.decidedAt`, issues)) {
      const decisionMs = Date.parse(value.decidedAt);
      if (!Number.isFinite(decisionMs) || decisionMs < previousDecisionMs) {
        issue(issues, 'BROKEN_OVERRIDE_CHAIN', 'DENY', `${path}.decidedAt`, 'override timestamps must be valid and non-decreasing');
      } else previousDecisionMs = decisionMs;
    }
    requireHash(value.subjectHash, `${path}.subjectHash`, issues);
    requireHash(value.evidenceReportHash, `${path}.evidenceReportHash`, issues);
    requireHash(value.recordHash, `${path}.recordHash`, issues);
    if (value.subjectHash !== expectedSubject) issue(issues, 'EVIDENCE_SUBJECT_MISMATCH', 'DENY', `${path}.subjectHash`, 'override is bound to a different subject');
    if (value.previousRecordHash !== previous) issue(issues, 'BROKEN_OVERRIDE_CHAIN', 'DENY', `${path}.previousRecordHash`, 'override chain predecessor does not match');
    if (!['pass', 'review', 'deny'].includes(String(value.priorVerdict))) issue(issues, 'INVALID_VERDICT', 'DENY', `${path}.priorVerdict`, 'unknown prior verdict');
    if (!['hold', 'deny', 'security-exception'].includes(String(value.replacementDisposition))) {
      issue(issues, 'INVALID_OVERRIDE', 'DENY', `${path}.replacementDisposition`, 'override cannot grant lifecycle approval');
    }
    const evidenceVerdict = evidenceByHash.get(String(value.evidenceReportHash));
    if (!evidenceVerdict || evidenceVerdict !== value.priorVerdict) {
      issue(issues, 'FORGED_OVERRIDE', 'DENY', `${path}.evidenceReportHash`, 'override does not bind an evidence report with the stated prior verdict');
    }
    try {
      const expected = overrideRecordHash({
        actor: value.actor,
        reason: value.reason,
        evidenceReportHash: value.evidenceReportHash,
        priorVerdict: value.priorVerdict,
        replacementDisposition: value.replacementDisposition,
        subjectHash: value.subjectHash,
        decidedAt: value.decidedAt,
        previousRecordHash: value.previousRecordHash,
      } as Omit<HumanOverrideRecord, 'recordHash'>);
      if (expected !== value.recordHash) issue(issues, 'FORGED_OVERRIDE', 'DENY', `${path}.recordHash`, 'override record hash does not match its canonical content');
    } catch {
      issue(issues, 'FORGED_OVERRIDE', 'DENY', `${path}.recordHash`, 'override record cannot be canonicalized');
    }
    previous = typeof value.recordHash === 'string' ? value.recordHash : null;
    overrides.push(value as unknown as HumanOverrideRecord);
  }
  return overrides;
}

function validateSecurity(raw: unknown, expectedSubject: string, nowMs: number, requireModel: boolean, issues: LifecycleIssue[]): void {
  const security = record(raw);
  if (!security) {
    issue(issues, 'MISSING_FIELD', 'HOLD', 'security', 'security evidence is required');
    return;
  }
  const evidenceByHash = new Map<string, SecurityVerdict>();
  const deterministic = Array.isArray(security.deterministic) ? security.deterministic : [];
  if (!Array.isArray(security.deterministic)) issue(issues, 'MISSING_SECURITY_EVIDENCE', 'HOLD', 'security.deterministic', 'deterministic evidence is required');
  const kinds = new Set<string>();
  for (const [index, item] of deterministic.entries()) {
    const evidence = record(item);
    const path = `security.deterministic[${index}]`;
    if (!evidence) {
      issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', path, 'evidence must be an object');
      continue;
    }
    if (!['skillspector', 'supply-chain'].includes(String(evidence.kind))) issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', `${path}.kind`, 'unknown deterministic gate');
    else kinds.add(String(evidence.kind));
    requireString(evidence.gateVersion, `${path}.gateVersion`, issues);
    validateEvidenceReference(evidence, path, expectedSubject, nowMs, issues);
    if (typeof evidence.reportHash === 'string') {
      if (evidenceByHash.has(evidence.reportHash)) issue(issues, 'DUPLICATE_EVIDENCE', 'DENY', `${path}.reportHash`, 'evidence report hashes must be unique');
      evidenceByHash.set(evidence.reportHash, evidence.verdict as SecurityVerdict);
    }
  }
  for (const kind of ['skillspector', 'supply-chain']) {
    if (!kinds.has(kind)) issue(issues, 'MISSING_SECURITY_EVIDENCE', 'HOLD', 'security.deterministic', `${kind} evidence is required`);
  }

  const modelBased = Array.isArray(security.modelBased) ? security.modelBased : [];
  if (!Array.isArray(security.modelBased) || (requireModel && modelBased.length === 0)) {
    issue(issues, 'MISSING_MODEL_EVIDENCE', 'HOLD', 'security.modelBased', 'externally produced model-security evidence is required');
  }
  for (const [index, item] of modelBased.entries()) {
    const evidence = record(item);
    const path = `security.modelBased[${index}]`;
    if (!evidence) {
      issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', path, 'evidence must be an object');
      continue;
    }
    if (evidence.kind !== 'external-model-security') issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', `${path}.kind`, 'model evidence must be external');
    for (const key of ['provider', 'model', 'modelRevision', 'promptVersion']) requireString(evidence[key], `${path}.${key}`, issues);
    if (!Array.isArray(evidence.findings)) issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', `${path}.findings`, 'findings array is required');
    else {
      for (const [findingIndex, itemFinding] of evidence.findings.entries()) {
        const finding = record(itemFinding);
        const findingPath = `${path}.findings[${findingIndex}]`;
        if (!finding) {
          issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', findingPath, 'finding must be an object');
          continue;
        }
        requireString(finding.ruleId, `${findingPath}.ruleId`, issues);
        requireHash(finding.findingHash, `${findingPath}.findingHash`, issues);
        if (!['critical', 'warning', 'info'].includes(String(finding.severity))) issue(issues, 'INVALID_SECURITY_EVIDENCE', 'DENY', `${findingPath}.severity`, 'unknown severity');
      }
    }
    validateEvidenceReference(evidence, path, expectedSubject, nowMs, issues);
    if (typeof evidence.reportHash === 'string') {
      if (evidenceByHash.has(evidence.reportHash)) issue(issues, 'DUPLICATE_EVIDENCE', 'DENY', `${path}.reportHash`, 'evidence report hashes must be unique');
      evidenceByHash.set(evidence.reportHash, evidence.verdict as SecurityVerdict);
    }
  }

  const overrides = validateOverrideChain(security.humanOverrides, expectedSubject, evidenceByHash, issues);
  const latestOverride = new Map(overrides.map((override) => [override.evidenceReportHash, override]));
  for (const evidence of [...deterministic, ...modelBased] as Array<DeterministicSecurityEvidence | ModelSecurityEvidence>) {
    if (!evidence || evidence.verdict === 'pass') continue;
    const disposition = latestOverride.get(evidence.reportHash)?.replacementDisposition;
    if (disposition === 'security-exception') continue;
    issue(
      issues,
      'SECURITY_VERDICT',
      disposition === 'deny' || evidence.verdict === 'deny' ? 'DENY' : 'HOLD',
      'security',
      `${evidence.kind} verdict ${evidence.verdict} is not excepted by a valid human record`,
    );
  }
}

function validateTask(raw: unknown, path: string, issues: LifecycleIssue[]): raw is EvaluationTaskClass {
  const task = record(raw);
  if (!task) {
    issue(issues, 'INVALID_EVALUATION_CONTRACT', 'DENY', path, 'task class must be an object');
    return false;
  }
  requireString(task.name, `${path}.name`, issues);
  requireString(task.version, `${path}.version`, issues);
  if (typeof task.required !== 'boolean') issue(issues, 'INVALID_EVALUATION_CONTRACT', 'DENY', `${path}.required`, 'boolean is required');
  for (const key of ['inputContractHash', 'outputContractHash', 'verifierContractHash']) requireHash(task[key], `${path}.${key}`, issues);
  if (!Array.isArray(task.fixtureHashes) || task.fixtureHashes.length === 0) issue(issues, 'MISSING_EVALUATION_FIXTURES', 'HOLD', `${path}.fixtureHashes`, 'at least one fixture hash is required');
  else {
    for (const [index, hash] of task.fixtureHashes.entries()) requireHash(hash, `${path}.fixtureHashes[${index}]`, issues);
    if (new Set(task.fixtureHashes).size !== task.fixtureHashes.length) issue(issues, 'DUPLICATE_ENTRY', 'DENY', `${path}.fixtureHashes`, 'fixture hashes must be unique');
  }
  if (typeof task.minimumScore !== 'number' || !Number.isFinite(task.minimumScore) || task.minimumScore < 0 || task.minimumScore > 1) {
    issue(issues, 'INVALID_EVALUATION_CONTRACT', 'DENY', `${path}.minimumScore`, 'score must be between zero and one');
  }
  return true;
}

function validateCompatibility(row: CompatibilityRow, task: EvaluationTaskClass, expectedSubject: string, path: string, issues: LifecycleIssue[]): void {
  if (row.subjectHash !== expectedSubject) issue(issues, 'EVIDENCE_SUBJECT_MISMATCH', 'DENY', `${path}.subjectHash`, 'compatibility row is bound to a different subject');
  if (row.contractHash !== taskClassHash(task)) issue(issues, 'COMPATIBILITY_CONTRACT_MISMATCH', 'DENY', `${path}.contractHash`, 'row does not bind the named task contract');
  for (const [key, value] of Object.entries({
    [`${path}.model.provider`]: row.model?.provider,
    [`${path}.model.id`]: row.model?.id,
    [`${path}.model.revision`]: row.model?.revision,
    [`${path}.harness.name`]: row.harness?.name,
    [`${path}.harness.version`]: row.harness?.version,
    [`${path}.seed`]: row.seed,
  })) requireString(value, key, issues);
  requireHash(row.harness?.configHash, `${path}.harness.configHash`, issues);
  requireHash(row.receiptHash, `${path}.receiptHash`, issues);
  requireHash(row.contamination?.evidenceHash, `${path}.contamination.evidenceHash`, issues);
  if (
    typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1 ||
    typeof row.threshold !== 'number' || !Number.isFinite(row.threshold) || row.threshold !== task.minimumScore
  ) {
    issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', `${path}.threshold`, 'row threshold must equal the task minimum score');
  }
  if (!row.passed || row.score < row.threshold) issue(issues, 'COMPATIBILITY_NOT_READY', 'HOLD', path, 'compatibility row did not meet its declared threshold');
  if (!row.contamination?.checked || row.contamination.detected) issue(issues, 'CONTAMINATION_NOT_CLEARED', 'HOLD', `${path}.contamination`, 'contamination must be checked and absent');
  const validCurrency = requireString(row.cost?.currency, `${path}.cost.currency`, issues);
  if (typeof row.cost?.amount !== 'number' || !Number.isFinite(row.cost.amount) || row.cost.amount < 0 || !validCurrency) {
    issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', `${path}.cost`, 'non-negative cost and currency are required');
  }
  if (!Number.isFinite(row.latencyMs) || row.latencyMs < 0) issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', `${path}.latencyMs`, 'non-negative latency is required');
  if (row.passed && row.failure !== null) issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', `${path}.failure`, 'passing row cannot carry a failure');
  if (!row.passed && !requireString(row.failure, `${path}.failure`, issues)) issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', `${path}.failure`, 'failed row requires failure evidence');
}

function validateEvaluation(raw: unknown, expectedSubject: string, issues: LifecycleIssue[]): void {
  const evaluation = record(raw);
  if (!evaluation) {
    issue(issues, 'MISSING_EVALUATION_CONTRACT', 'HOLD', 'evaluation', 'evaluation contract is required');
    return;
  }
  const tasks = Array.isArray(evaluation.taskClasses) ? evaluation.taskClasses : [];
  if (tasks.length === 0) issue(issues, 'MISSING_EVALUATION_CONTRACT', 'HOLD', 'evaluation.taskClasses', 'task classes are required');
  const validTasks = tasks.filter((task, index): task is EvaluationTaskClass => validateTask(task, `evaluation.taskClasses[${index}]`, issues));
  const taskKeys = validTasks.map((task) => `${task.name}\0${task.version}`);
  if (new Set(taskKeys).size !== taskKeys.length) issue(issues, 'DUPLICATE_TASK_CLASS', 'DENY', 'evaluation.taskClasses', 'task class identities must be unique');

  let computedContract: Sha256Digest | null = null;
  try {
    computedContract = evaluationContractHash(validTasks);
    if (!requireHash(evaluation.contractHash, 'evaluation.contractHash', issues) || evaluation.contractHash !== computedContract) {
      issue(issues, 'EVALUATION_CONTRACT_MISMATCH', 'DENY', 'evaluation.contractHash', 'evaluation contract hash does not match task classes');
    }
  } catch {
    issue(issues, 'EVALUATION_CONTRACT_MISMATCH', 'DENY', 'evaluation.contractHash', 'evaluation contract cannot be canonicalized');
  }

  const rows = Array.isArray(evaluation.compatibility) ? evaluation.compatibility : [];
  if (!Array.isArray(evaluation.compatibility)) issue(issues, 'MISSING_COMPATIBILITY', 'HOLD', 'evaluation.compatibility', 'compatibility rows are required');
  const rowCountByTask = new Map<string, number>();
  for (const [index, candidate] of rows.entries()) {
    const row = record(candidate);
    const path = `evaluation.compatibility[${index}]`;
    if (!row) {
      issue(issues, 'INVALID_COMPATIBILITY_ROW', 'DENY', path, 'compatibility row must be an object');
      continue;
    }
    const task = validTasks.find((item) => item.name === row.taskClass && item.version === row.taskClassVersion);
    if (!task) {
      issue(issues, 'UNKNOWN_TASK_CLASS', 'DENY', path, 'compatibility row references an undeclared task contract');
      continue;
    }
    const key = `${task.name}\0${task.version}`;
    rowCountByTask.set(key, (rowCountByTask.get(key) ?? 0) + 1);
    validateCompatibility(candidate as CompatibilityRow, task, expectedSubject, path, issues);
  }
  for (const task of validTasks.filter((candidate) => candidate.required)) {
    if ((rowCountByTask.get(`${task.name}\0${task.version}`) ?? 0) === 0) {
      issue(issues, 'MISSING_COMPATIBILITY', 'HOLD', 'evaluation.compatibility', `required task ${task.name}@${task.version} has no row`);
    }
  }

  const parity = record(evaluation.parity);
  if (!parity) {
    issue(issues, 'MISSING_PARITY', 'HOLD', 'evaluation.parity', 'production/evaluation parity evidence is required');
    return;
  }
  if (parity.subjectHash !== expectedSubject) issue(issues, 'EVIDENCE_SUBJECT_MISMATCH', 'DENY', 'evaluation.parity.subjectHash', 'parity evidence is bound to a different subject');
  for (const key of ['evaluationContractHash', 'productionContractHash', 'evaluationAdapterContractHash', 'verifierContractHash', 'evidenceHash']) {
    requireHash(parity[key], `evaluation.parity.${key}`, issues);
  }
  const verifierHash = canonicalHash(validTasks.map((task) => task.verifierContractHash).sort());
  if (
    computedContract === null ||
    parity.evaluationContractHash !== computedContract ||
    parity.productionContractHash !== computedContract ||
    parity.evaluationAdapterContractHash !== computedContract ||
    parity.verifierContractHash !== verifierHash
  ) issue(issues, 'PARITY_MISMATCH', 'DENY', 'evaluation.parity', 'production, adapter, evaluation, or verifier contracts differ');
  if (parity.verdict !== 'pass') issue(issues, 'PARITY_NOT_READY', 'HOLD', 'evaluation.parity.verdict', 'parity verdict must pass');
  if (!requireString(parity.verifiedAt, 'evaluation.parity.verifiedAt', issues) || !Number.isFinite(Date.parse(String(parity.verifiedAt)))) {
    issue(issues, 'INVALID_PARITY', 'DENY', 'evaluation.parity.verifiedAt', 'valid verification timestamp is required');
  }
}

export function validateLifecycleRecord(raw: unknown, options: LifecycleGateOptions = {}): LifecycleGateResult {
  const issues: LifecycleIssue[] = [];
  const value = record(raw);
  if (!value) return { decision: 'DENY', subjectHash: null, issues: [{ code: 'INVALID_RECORD', disposition: 'DENY', path: '', message: 'lifecycle record must be an object' }] };
  if (value.schemaVersion !== 1) issue(issues, 'UNKNOWN_SCHEMA_VERSION', 'DENY', 'schemaVersion', 'only lifecycle schema version 1 is supported');
  if (!STATES.has(value.state as LifecycleState)) issue(issues, 'UNKNOWN_STATE', 'DENY', 'state', 'unknown lifecycle state');
  const identityValid = validateIdentity(value.identity, issues);
  const declaredSubject = requireHash(value.subjectHash, 'subjectHash', issues) ? value.subjectHash : null;
  if (identityValid && declaredSubject) {
    try {
      if (subjectHash(value.identity as SkillLifecycleRecord['identity']) !== declaredSubject) {
        issue(issues, 'SUBJECT_HASH_MISMATCH', 'DENY', 'subjectHash', 'subject hash does not match canonical identity');
      }
    } catch {
      issue(issues, 'SUBJECT_HASH_MISMATCH', 'DENY', 'subjectHash', 'identity cannot be canonicalized');
    }
  }
  if (declaredSubject) {
    const rawNow = options.now ?? Date.now();
    const nowMs = rawNow instanceof Date ? rawNow.getTime() : typeof rawNow === 'string' ? Date.parse(rawNow) : rawNow;
    if (!Number.isFinite(nowMs)) issue(issues, 'INVALID_CLOCK', 'DENY', '', 'validation clock is invalid');
    else validateSecurity(value.security, declaredSubject, nowMs, options.requireModelEvidence ?? true, issues);
    validateEvaluation(value.evaluation, declaredSubject, issues);
  }
  const decision = issues.some((item) => item.disposition === 'DENY') ? 'DENY' : issues.length > 0 ? 'HOLD' : 'PASS';
  return { decision, subjectHash: declaredSubject, issues };
}

export function validateLifecycleSubject(
  raw: unknown,
  subjectRoot: string,
  options: LifecycleGateOptions = {},
): LifecycleGateResult {
  const result = validateLifecycleRecord(raw, options);
  const value = record(raw);
  const identity = record(value?.identity);
  if (!identity || typeof identity.contentHash !== 'string') return result;
  const issues = [...result.issues];
  try {
    const observed = hashDirectory(subjectRoot).contentHash;
    if (observed !== identity.contentHash) {
      issue(issues, 'CONTENT_HASH_MISMATCH', 'DENY', 'identity.contentHash', `declared ${identity.contentHash}; observed ${observed}`);
    }
  } catch (error) {
    issue(
      issues,
      'CONTENT_TREE_UNSAFE',
      'DENY',
      'identity.contentHash',
      error instanceof Error ? error.message : String(error),
    );
  }
  const decision = issues.some((item) => item.disposition === 'DENY') ? 'DENY' : issues.length > 0 ? 'HOLD' : 'PASS';
  return { decision, subjectHash: result.subjectHash, issues };
}

export function validateLifecycleTransition(previous: unknown, next: unknown): LifecycleGateResult {
  const issues: LifecycleIssue[] = [];
  const from = record(previous);
  const to = record(next);
  const subject = typeof to?.subjectHash === 'string' && SHA256.test(to.subjectHash) ? to.subjectHash as Sha256Digest : null;
  if (!from || !to) issue(issues, 'INVALID_RECORD', 'DENY', '', 'both transition records are required');
  else {
    if (!STATES.has(from.state as LifecycleState) || !STATES.has(to.state as LifecycleState)) issue(issues, 'UNKNOWN_STATE', 'DENY', 'state', 'transition contains an unknown state');
    else if (!TRANSITIONS.has(`${from.state}->${to.state}`)) issue(issues, 'UNKNOWN_TRANSITION', 'DENY', 'state', `${from.state} -> ${to.state} is not allowed`);
    if (from.subjectHash !== to.subjectHash) issue(issues, 'SUBJECT_HASH_MISMATCH', 'DENY', 'subjectHash', 'transition cannot change subject identity');
    if (canonicalHash(from.identity) !== canonicalHash(to.identity)) issue(issues, 'IDENTITY_DRIFT', 'DENY', 'identity', 'transition cannot mutate version identity');
  }
  return { decision: issues.length > 0 ? 'DENY' : 'PASS', subjectHash: subject, issues };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      manifest: { type: 'string' },
      subject: { type: 'string' },
      now: { type: 'string' },
      'allow-missing-model': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('usage: bun gate.ts --manifest <skill-lifecycle.json> --subject <skill-directory> [--now <ISO>] [--allow-missing-model]');
    process.exit(0);
  }
  if (!values.manifest || !values.subject) {
    console.error('lifecycle gate requires --manifest and --subject');
    process.exit(2);
  }
  let result: LifecycleGateResult;
  try {
    const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as unknown;
    result = validateLifecycleSubject(manifest, values.subject, {
      now: values.now,
      requireModelEvidence: values['allow-missing-model'] !== true,
    });
  } catch (error) {
    result = {
      decision: 'DENY',
      subjectHash: null,
      issues: [{
        code: 'INVALID_RECORD',
        disposition: 'DENY',
        path: '',
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.decision === 'PASS' ? 0 : result.decision === 'HOLD' ? 3 : 4);
}
