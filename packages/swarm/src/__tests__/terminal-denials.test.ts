/**
 * EXEC-02 regression: terminal denials must survive the session.
 *
 * Before the fix, `deniedProposals` was a purely in-memory Set: a new
 * DecisionGate (new session/process) re-evaluated previously-denied
 * proposals, and operators had no view of the terminal set.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDecisionRecordStore, FileDecisionRecordStore } from '../decision-record.js';
import {
  DEFAULT_TIER_POLICY,
  DecisionGate,
  type TierPolicy,
} from '../approval-tiers.js';

const zeroBudgetPolicy: TierPolicy = {
  ...DEFAULT_TIER_POLICY,
  budgets: { maxAutoApprovals: 0, maxDelegateApprovals: 0 },
};

function fileGate(path: string, policy: TierPolicy = zeroBudgetPolicy) {
  return new DecisionGate({
    store: new FileDecisionRecordStore(path),
    actor: 'exec02-probe',
    origin: 'swarm',
    authority: 'auto',
    policy,
  });
}

const destructiveAction = () => ({
  kind: 'tool_call' as const,
  tool: 'Bash',
  summary: 'rm -rf /',
  target: '/',
});

describe('EXEC-02: terminal denials survive the session', () => {
  test('a denied proposal stays denied on a new gate over the same file store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zo-denial-'));
    try {
      const storePath = join(dir, 'decisions.jsonl');
      const gate1 = fileGate(storePath);
      const first = gate1.decide(destructiveAction(), 'write');
      expect(first.outcome).toBe('denied');

      // New gate instance, same durable store: the denial is terminal, the
      // proposal is not re-evaluated.
      const gate2 = fileGate(storePath);
      const second = gate2.decide(destructiveAction(), 'write');
      expect(second.outcome).toBe('denied');
      expect(second.reason).toMatch(/previously denied; denial is terminal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listTerminalDenials exposes the terminal set to operators', () => {
    const store = new MemoryDecisionRecordStore();
    const gate = new DecisionGate({
      store,
      actor: 'exec02-probe',
      origin: 'swarm',
      authority: 'auto',
      policy: zeroBudgetPolicy,
    });
    const denied = gate.decide(destructiveAction(), 'write');
    expect(denied.outcome).toBe('denied');

    const denials = gate.listTerminalDenials();
    expect(denials.length).toBe(1);
    expect(denials[0].actor).toBe('exec02-probe');
    expect(denials[0].tool).toBe('Bash');
    expect(denials[0].target).toBe('/');
    expect(denials[0].reason.length).toBeGreaterThan(0);
    expect(denials[0].proposalKey.length).toBe(64); // sha256 hex

    // A fresh gate over the same store sees the same terminal set.
    const gate2 = new DecisionGate({
      store,
      actor: 'exec02-probe',
      origin: 'swarm',
      authority: 'auto',
      policy: zeroBudgetPolicy,
    });
    expect(gate2.listTerminalDenials().length).toBe(1);
  });

  test('approved proposals are not terminally denied', () => {
    const store = new MemoryDecisionRecordStore();
    const policy: TierPolicy = {
      ...DEFAULT_TIER_POLICY,
      budgets: { maxAutoApprovals: 5, maxDelegateApprovals: 5 },
    };
    const gate = new DecisionGate({
      store,
      actor: 'exec02-probe',
      origin: 'swarm',
      authority: 'auto',
      policy,
    });
    const approved = gate.decide({ kind: 'tool_call', tool: 'Read', summary: 'read', target: '/f' }, 'read');
    expect(approved.outcome).toBe('approved');
    expect(gate.listTerminalDenials().length).toBe(0);
  });
});
