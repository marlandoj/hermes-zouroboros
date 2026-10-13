import { describe, test, expect } from 'bun:test';
import { resolvePersonaPrompt, resolvePersonaMCPs } from '../executor/bridge.js';

describe('persona injection (F-007/F-009)', () => {
  test('resolves a domain persona to a prompt prefix', () => {
    const prefix = resolvePersonaPrompt('frontend-developer');
    expect(prefix).not.toBeNull();
    expect(prefix!).toContain('[Persona:');
    expect(prefix!).toContain('---');
  });

  test('matches by id as well as name', () => {
    const byId = resolvePersonaPrompt('frontend-developer');
    expect(byId).not.toBeNull();
  });

  test('returns null for unknown personas', () => {
    expect(resolvePersonaPrompt('not-a-real-persona-xyz')).toBeNull();
  });

  test('returns null for undefined/empty', () => {
    expect(resolvePersonaPrompt(undefined)).toBeNull();
    expect(resolvePersonaPrompt('')).toBeNull();
  });

  test('passes harness labels through unchanged (no injection)', () => {
    for (const h of ['codex', 'claude-code', 'hermes', 'gemini', 'opencode']) {
      expect(resolvePersonaPrompt(h)).toBeNull();
      expect(resolvePersonaMCPs(h)).toBeNull();
    }
  });

  test('resolvePersonaMCPs returns the persona MCP list or null', () => {
    const mcps = resolvePersonaMCPs('frontend-developer');
    // null (no MCPs) or a string array — never throws
    expect(mcps === null || Array.isArray(mcps)).toBe(true);
    expect(resolvePersonaMCPs('not-a-real-persona-xyz')).toBeNull();
    expect(resolvePersonaMCPs(undefined)).toBeNull();
  });
});
