/**
 * EXEC-01 regression: budget escalation must re-check every destination
 * tier's cap through the monotonic chain auto → delegate → human.
 *
 * Before the fix, an exhausted auto budget escalated to delegate without
 * checking the delegate cap — so a read-kind request was approved even when
 * both caps were zero.
 */
import { describe, test, expect } from 'bun:test';
import { MemoryDecisionRecordStore } from '../decision-record.js';
import {
  DEFAULT_TIER_POLICY,
  DecisionGate,
  type TierPolicy,
} from '../approval-tiers.js';

function gateWithBudgets(maxAutoApprovals: number, maxDelegateApprovals: number, extra: Record<string, unknown> = {}) {
  const policy: TierPolicy = {
    ...DEFAULT_TIER_POLICY,
    budgets: { maxAutoApprovals, maxDelegateApprovals },
  };
  return new DecisionGate({
    store: new MemoryDecisionRecordStore(),
    actor: 'exec01-probe',
    origin: 'swarm',
    authority: 'delegate',
    policy,
    ...extra,
  });
}

const readAction = (n: number) => ({ kind: 'tool_call' as const, tool: 'Read', summary: `read ${n}`, target: `/f${n}` });

describe('EXEC-01: budget escalation re-checks destination caps', () => {
  test('exhausted auto escalates to delegate, exhausted delegate escalates to human', () => {
    const gate = gateWithBudgets(1, 1);
    const first = gate.decide(readAction(1), 'read');
    expect(first.outcome).toBe('approved');
    expect(first.tier).toBe('auto');

    const second = gate.decide(readAction(2), 'read');
    expect(second.outcome).toBe('approved');
    expect(second.tier).toBe('delegate');

    // Both budgets exhausted: must reach human, and with no live approver
    // on this path the verdict is denied — never a silent delegate approval.
    const third = gate.decide(readAction(3), 'read');
    expect(third.tier).toBe('human');
    expect(third.outcome).toBe('denied');
  });

  test('zero caps never approve, even for read-kind requests', () => {
    const gate = gateWithBudgets(0, 0);
    const verdict = gate.decide(readAction(1), 'read');
    expect(verdict.outcome).toBe('denied');
    expect(verdict.tier).toBe('human');
  });

  test('escalated human tier still approves when a live approver exists', () => {
    const gate = gateWithBudgets(0, 0, {
      humanApprover: () => ({ approved: true, approver: 'op', reason: 'ok' }),
    });
    const verdict = gate.decide(readAction(1), 'read');
    expect(verdict.outcome).toBe('approved');
    expect(verdict.tier).toBe('human');
    expect(verdict.decided_by).toBe('human:op');
  });

  test('delegate-native proposals respect the delegate cap', () => {
    const gate = gateWithBudgets(512, 1);
    const fetch = (n: number) => ({ kind: 'tool_call' as const, tool: 'Fetch', summary: `fetch ${n}` });
    const first = gate.decide(fetch(1), 'fetch');
    expect(first.tier).toBe('delegate');
    expect(first.outcome).toBe('approved');
    const second = gate.decide(fetch(2), 'fetch');
    expect(second.tier).toBe('human');
    expect(second.outcome).toBe('denied');
  });

  test('budget snapshot reports the deciding tier and its cap', () => {
    const gate = gateWithBudgets(1, 5);
    gate.decide(readAction(1), 'read'); // consumes the single auto approval
    const escalated = gate.decide(readAction(2), 'read');
    expect(escalated.tier).toBe('delegate');
    expect(escalated.budget).toMatchObject({ tier: 'delegate', cap: 5 });
  });
});
