import { describe, test, expect } from 'bun:test';
import { applyDefense } from '../defense.js';

describe('applyDefense: Google and Synthetic key shapes', () => {
  test('redacts Google keys in both the AIza and the current AQ. format, and Synthetic syn_ keys', () => {
    const AIZA = 'AIza' + 'e'.repeat(35);
    const AQ = 'AQ.Ab8' + 'f'.repeat(47);
    const SYN = 'syn_' + 'g'.repeat(32);
    const r = applyDefense(`gemini ${AIZA} and ${AQ}; synthetic ${SYN}`, { policy: 'redact' });
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain('google_api_key');
    expect(names).toContain('google_auth_key');
    expect(names).toContain('synthetic_api_key');
    for (const k of [AIZA, AQ, SYN]) expect(r.text).not.toContain(k);
  });

  test('does not flag prose such as a section number', () => {
    expect(applyDefense('see section AQ.4 of the spec', { policy: 'redact' }).findings).toHaveLength(0);
  });
});
