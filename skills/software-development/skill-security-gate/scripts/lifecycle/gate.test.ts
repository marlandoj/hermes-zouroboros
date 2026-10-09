import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalHash,
  canonicalJson,
  dependencyManifestHash,
  evaluationContractHash,
  hashDirectory,
  hashFileSet,
  normalizeRelativePath,
  overrideRecordHash,
  subjectHash,
  taskClassHash,
} from './canonical.js';
import { validateLifecycleRecord, validateLifecycleSubject, validateLifecycleTransition } from './gate.js';
import type { HumanOverrideRecord, Sha256Digest, SkillLifecycleRecord } from './types.js';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'lifecycle');
const NOW = '2026-08-19T22:00:00.000Z';

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}` as Sha256Digest;
}

function validRecord(): SkillLifecycleRecord {
  const dependencies = [{
    name: 'yaml',
    manager: 'npm' as const,
    versionOrRevision: '2.8.1',
    integrity: digest('1'),
  }];
  const identity: SkillLifecycleRecord['identity'] = {
    slug: 'governed-skill',
    version: '1.2.3',
    source: {
      kind: 'git',
      canonicalUri: 'https://github.com/example/governed-skill.git',
      immutableRevision: '0123456789abcdef0123456789abcdef01234567',
      signature: {
        scheme: 'git-commit',
        signer: 'release@example.com',
        signatureHash: digest('2'),
      },
    },
    contentHash: digest('3'),
    dependencyManifestHash: dependencyManifestHash(dependencies),
    capabilities: {
      tools: ['Read', 'Bash'],
      filesystem: { read: ['workspace'], write: ['reports'] },
      process: { spawn: true, commands: ['bun'] },
      network: { hosts: ['api.example.com'], protocols: ['https'] },
    },
    credentials: [{ class: 'api-key', envName: 'EXAMPLE_API_KEY' }],
    dependencies,
  };
  const checkedSubject = subjectHash(identity);
  const task = {
    name: 'safe-analysis',
    version: '1',
    required: true,
    inputContractHash: digest('4'),
    outputContractHash: digest('5'),
    verifierContractHash: digest('6'),
    fixtureHashes: [digest('7')],
    minimumScore: 0.8,
  };
  const contractHash = evaluationContractHash([task]);
  return {
    schemaVersion: 1,
    subjectHash: checkedSubject,
    identity,
    state: 'quarantined',
    security: {
      deterministic: [
        {
          kind: 'skillspector',
          subjectHash: checkedSubject,
          verdict: 'pass',
          reportHash: digest('8'),
          gateVersion: 'skillspector@1.0.0',
          policyVersion: 'skill-policy@1',
          issuedAt: '2026-08-19T20:00:00.000Z',
          validUntil: '2027-08-19T20:00:00.000Z',
        },
        {
          kind: 'supply-chain',
          subjectHash: checkedSubject,
          verdict: 'pass',
          reportHash: digest('9'),
          gateVersion: 'supply-chain@1.0.0',
          policyVersion: 'supply-chain-policy@1',
          issuedAt: '2026-08-19T20:00:00.000Z',
          validUntil: '2027-08-19T20:00:00.000Z',
        },
      ],
      modelBased: [{
        kind: 'external-model-security',
        subjectHash: checkedSubject,
        provider: 'external-provider',
        model: 'security-reviewer',
        modelRevision: '2026-08-01',
        promptVersion: 'security-prompt@3',
        policyVersion: 'model-security-policy@2',
        verdict: 'pass',
        findings: [],
        reportHash: digest('a'),
        issuedAt: '2026-08-19T20:00:00.000Z',
        validUntil: '2027-08-19T20:00:00.000Z',
      }],
      humanOverrides: [],
    },
    evaluation: {
      contractHash,
      taskClasses: [task],
      compatibility: [{
        taskClass: task.name,
        taskClassVersion: task.version,
        subjectHash: checkedSubject,
        contractHash: taskClassHash(task),
        model: { provider: 'provider', id: 'model', revision: 'revision-1' },
        harness: { name: 'skill-harness', version: '2.0.0', configHash: digest('b') },
        seed: 'held-out-seed-01',
        passed: true,
        score: 0.9,
        threshold: task.minimumScore,
        cost: { amount: 0.031, currency: 'USD' },
        latencyMs: 1240,
        receiptHash: digest('c'),
        failure: null,
        contamination: { checked: true, detected: false, evidenceHash: digest('d') },
      }],
      parity: {
        subjectHash: checkedSubject,
        evaluationContractHash: contractHash,
        productionContractHash: contractHash,
        evaluationAdapterContractHash: contractHash,
        verifierContractHash: canonicalHash([task.verifierContractHash]),
        verdict: 'pass',
        evidenceHash: digest('e'),
        verifiedAt: NOW,
      },
    },
  };
}

function addOverride(record: SkillLifecycleRecord, disposition: HumanOverrideRecord['replacementDisposition']): void {
  const evidence = record.security.modelBased[0]!;
  evidence.verdict = 'review';
  const previousRecordHash = record.security.humanOverrides.at(-1)?.recordHash ?? null;
  const body: Omit<HumanOverrideRecord, 'recordHash'> = {
    actor: 'operator@example.com',
    reason: 'Reviewed bounded false positive with deterministic evidence.',
    evidenceReportHash: evidence.reportHash,
    priorVerdict: 'review',
    replacementDisposition: disposition,
    subjectHash: record.subjectHash,
    decidedAt: '2026-08-19T21:00:00.000Z',
    previousRecordHash,
  };
  record.security.humanOverrides.push({ ...body, recordHash: overrideRecordHash(body) });
}

function applyCase(record: SkillLifecycleRecord, prepare: string, mutation: string): void {
  if (prepare === 'one-override') addOverride(record, 'security-exception');
  if (prepare === 'two-overrides') {
    addOverride(record, 'hold');
    addOverride(record, 'security-exception');
  }
  switch (mutation) {
    case 'delete-model-evidence': delete (record.security as { modelBased?: unknown }).modelBased; break;
    case 'expire-skillspector': record.security.deterministic[0]!.validUntil = '2026-08-19T21:00:00.000Z'; break;
    case 'replace-model-subject': record.security.modelBased[0]!.subjectHash = digest('f'); break;
    case 'change-override-actor': record.security.humanOverrides[0]!.actor = 'attacker@example.com'; break;
    case 'replace-override-predecessor': record.security.humanOverrides[1]!.previousRecordHash = digest('f'); break;
    case 'replace-state': (record as { state: string }).state = 'installed'; break;
    case 'add-credential-value': (record.identity.credentials[0] as unknown as Record<string, unknown>).value = 'forbidden'; break;
    case 'replace-dependency-integrity': record.identity.dependencies[0]!.integrity = digest('f'); break;
    case 'delete-parity': record.evaluation.parity = null; break;
    case 'replace-production-contract': record.evaluation.parity!.productionContractHash = digest('f'); break;
    default: throw new Error(`unknown fixture mutation: ${mutation}`);
  }
}

describe('canonical lifecycle representation', () => {
  it('sorts object keys by UTF-8 bytes and rejects non-JSON values', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe('{"a":{"b":null,"y":true},"z":1}');
    expect(() => canonicalJson({ invalid: undefined })).toThrow('undefined');
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite');
  });

  it('normalizes safe paths and rejects traversal and absolute fixtures', () => {
    const fixtures = JSON.parse(readFileSync(join(FIXTURE_DIR, 'path-cases.json'), 'utf8')) as Array<{ input: string; normalized?: string; error?: string }>;
    for (const fixture of fixtures) {
      if (fixture.normalized) expect(normalizeRelativePath(fixture.input)).toBe(fixture.normalized);
      else expect(() => normalizeRelativePath(fixture.input)).toThrow(fixture.error!);
    }
  });

  it('hashes sorted regular files and refuses symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-canonical-'));
    try {
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'a.txt'), 'alpha');
      writeFileSync(join(root, 'nested', 'b.txt'), 'beta');
      const first = hashFileSet(root, ['nested/b.txt', 'a.txt']);
      const second = hashFileSet(root, ['a.txt', 'nested\\b.txt']);
      expect(first).toEqual(second);
      symlinkSync(join(root, 'a.txt'), join(root, 'linked.txt'));
      expect(() => hashFileSet(root, ['linked.txt'])).toThrow('symlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the declared content hash to the actual regular-file tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-subject-'));
    try {
      writeFileSync(join(root, 'SKILL.md'), '# governed\n');
      const lifecycle = validRecord();
      lifecycle.identity.contentHash = hashDirectory(root).contentHash;
      lifecycle.subjectHash = subjectHash(lifecycle.identity);
      for (const evidence of [...lifecycle.security.deterministic, ...lifecycle.security.modelBased]) {
        evidence.subjectHash = lifecycle.subjectHash;
      }
      for (const row of lifecycle.evaluation.compatibility) row.subjectHash = lifecycle.subjectHash;
      lifecycle.evaluation.parity!.subjectHash = lifecycle.subjectHash;
      expect(validateLifecycleSubject(lifecycle, root, { now: NOW }).decision).toBe('PASS');
      writeFileSync(join(root, 'SKILL.md'), '# drifted\n');
      const drifted = validateLifecycleSubject(lifecycle, root, { now: NOW });
      expect(drifted.decision).toBe('DENY');
      expect(drifted.issues.map((item) => item.code)).toContain('CONTENT_HASH_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes subject identity independent of set ordering but sensitive to content', () => {
    const first = validRecord().identity;
    const reordered = structuredClone(first);
    reordered.capabilities.tools.reverse();
    expect(subjectHash(reordered)).toBe(subjectHash(first));
    reordered.contentHash = digest('f');
    expect(subjectHash(reordered)).not.toBe(subjectHash(first));
  });
});

describe('lifecycle gate', () => {
  it('passes a complete exact-subject contract without invoking a model', () => {
    expect(validateLifecycleRecord(validRecord(), { now: NOW })).toEqual({
      decision: 'PASS',
      subjectHash: validRecord().subjectHash,
      issues: [],
    });
  });

  it('accepts a canonical human security exception without treating it as lifecycle approval', () => {
    const lifecycle = validRecord();
    addOverride(lifecycle, 'security-exception');
    expect(lifecycle.state).toBe('quarantined');
    expect(validateLifecycleRecord(lifecycle, { now: NOW }).decision).toBe('PASS');
  });

  it('fails closed for every adversarial JSON fixture', () => {
    const fixtures = JSON.parse(readFileSync(join(FIXTURE_DIR, 'adversarial-cases.json'), 'utf8')) as Array<{
      id: string;
      prepare: string;
      mutation: string;
      expectedDecision: 'HOLD' | 'DENY';
      expectedCode: string;
    }>;
    for (const fixture of fixtures) {
      const lifecycle = validRecord();
      applyCase(lifecycle, fixture.prepare, fixture.mutation);
      const result = validateLifecycleRecord(lifecycle, { now: NOW });
      expect(result.decision, fixture.id).toBe(fixture.expectedDecision);
      expect(result.issues.map((item) => item.code), fixture.id).toContain(fixture.expectedCode);
    }
  });

  it('holds when a required task class lacks a compatibility row', () => {
    const lifecycle = validRecord();
    lifecycle.evaluation.compatibility = [];
    const result = validateLifecycleRecord(lifecycle, { now: NOW });
    expect(result.decision).toBe('HOLD');
    expect(result.issues.map((item) => item.code)).toContain('MISSING_COMPATIBILITY');
  });

  it('rejects unknown and identity-drifting transitions', () => {
    const candidate = validRecord();
    candidate.state = 'candidate';
    const quarantined = structuredClone(candidate);
    quarantined.state = 'quarantined';
    expect(validateLifecycleTransition(candidate, quarantined).decision).toBe('PASS');

    const promoted = structuredClone(candidate);
    promoted.state = 'promoted';
    expect(validateLifecycleTransition(candidate, promoted).issues.map((item) => item.code)).toContain('UNKNOWN_TRANSITION');

    quarantined.identity.contentHash = digest('f');
    expect(validateLifecycleTransition(candidate, quarantined).issues.map((item) => item.code)).toContain('IDENTITY_DRIFT');
  });
});
