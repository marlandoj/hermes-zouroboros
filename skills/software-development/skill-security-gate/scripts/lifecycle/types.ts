export type Sha256Digest = `sha256:${string}`;

export type LifecycleState =
  | 'candidate'
  | 'quarantined'
  | 'approved'
  | 'promoted'
  | 'rejected'
  | 'rolled_back';

export type SecurityVerdict = 'pass' | 'review' | 'deny';

export interface SourceSignature {
  scheme: 'git-commit' | 'sigstore' | 'minisign' | 'sha256';
  signer: string;
  signatureHash: Sha256Digest;
}

export interface SourceProvenance {
  kind: 'git' | 'registry' | 'local' | 'generated';
  canonicalUri: string;
  immutableRevision: string;
  signature: SourceSignature;
}

export interface CapabilityScope {
  tools: string[];
  filesystem: {
    read: string[];
    write: string[];
  };
  process: {
    spawn: boolean;
    commands: string[];
  };
  network: {
    hosts: string[];
    protocols: Array<'http' | 'https' | 'tcp' | 'udp'>;
  };
}

export interface CredentialDeclaration {
  class: 'api-key' | 'oauth-token' | 'access-token' | 'certificate' | 'password' | 'other';
  envName: string;
}

export interface DependencyIdentity {
  name: string;
  manager: 'bun' | 'npm' | 'pnpm' | 'python' | 'git' | 'system' | 'other';
  versionOrRevision: string;
  integrity: Sha256Digest;
}

export interface SkillVersionIdentity {
  slug: string;
  version: string;
  source: SourceProvenance;
  contentHash: Sha256Digest;
  dependencyManifestHash: Sha256Digest;
  capabilities: CapabilityScope;
  credentials: CredentialDeclaration[];
  dependencies: DependencyIdentity[];
}

export interface DeterministicSecurityEvidence {
  kind: 'skillspector' | 'supply-chain';
  subjectHash: Sha256Digest;
  verdict: SecurityVerdict;
  reportHash: Sha256Digest;
  gateVersion: string;
  policyVersion: string;
  issuedAt: string;
  validUntil: string;
}

export interface ModelSecurityEvidence {
  kind: 'external-model-security';
  subjectHash: Sha256Digest;
  provider: string;
  model: string;
  modelRevision: string;
  promptVersion: string;
  policyVersion: string;
  verdict: SecurityVerdict;
  findings: Array<{
    ruleId: string;
    severity: 'critical' | 'warning' | 'info';
    findingHash: Sha256Digest;
  }>;
  reportHash: Sha256Digest;
  issuedAt: string;
  validUntil: string;
}

export type OverrideDisposition = 'hold' | 'deny' | 'security-exception';

export interface HumanOverrideRecord {
  actor: string;
  reason: string;
  evidenceReportHash: Sha256Digest;
  priorVerdict: SecurityVerdict;
  replacementDisposition: OverrideDisposition;
  subjectHash: Sha256Digest;
  decidedAt: string;
  previousRecordHash: Sha256Digest | null;
  recordHash: Sha256Digest;
}

export interface EvaluationTaskClass {
  name: string;
  version: string;
  required: boolean;
  inputContractHash: Sha256Digest;
  outputContractHash: Sha256Digest;
  verifierContractHash: Sha256Digest;
  fixtureHashes: Sha256Digest[];
  minimumScore: number;
}

export interface CompatibilityRow {
  taskClass: string;
  taskClassVersion: string;
  subjectHash: Sha256Digest;
  contractHash: Sha256Digest;
  model: {
    provider: string;
    id: string;
    revision: string;
  };
  harness: {
    name: string;
    version: string;
    configHash: Sha256Digest;
  };
  seed: string;
  passed: boolean;
  score: number;
  threshold: number;
  cost: {
    amount: number;
    currency: string;
  };
  latencyMs: number;
  receiptHash: Sha256Digest;
  failure: string | null;
  contamination: {
    checked: boolean;
    detected: boolean;
    evidenceHash: Sha256Digest;
  };
}

export interface ContractParityEvidence {
  subjectHash: Sha256Digest;
  evaluationContractHash: Sha256Digest;
  productionContractHash: Sha256Digest;
  evaluationAdapterContractHash: Sha256Digest;
  verifierContractHash: Sha256Digest;
  verdict: 'pass' | 'fail';
  evidenceHash: Sha256Digest;
  verifiedAt: string;
}

export interface SkillEvaluationContract {
  contractHash: Sha256Digest;
  taskClasses: EvaluationTaskClass[];
  compatibility: CompatibilityRow[];
  parity: ContractParityEvidence | null;
}

export interface SkillLifecycleRecord {
  schemaVersion: 1;
  subjectHash: Sha256Digest;
  identity: SkillVersionIdentity;
  state: LifecycleState;
  security: {
    deterministic: DeterministicSecurityEvidence[];
    modelBased: ModelSecurityEvidence[];
    humanOverrides: HumanOverrideRecord[];
  };
  evaluation: SkillEvaluationContract;
}

export type LifecycleDecision = 'PASS' | 'HOLD' | 'DENY';

export interface LifecycleIssue {
  code: string;
  disposition: Exclude<LifecycleDecision, 'PASS'>;
  path: string;
  message: string;
}

export interface LifecycleGateResult {
  decision: LifecycleDecision;
  subjectHash: Sha256Digest | null;
  issues: LifecycleIssue[];
}
