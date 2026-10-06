/**
 * privacy-filter.ts — Secret redaction pre-storage (adopted from agentmemory)
 *
 * Concept source: rohitg00/agentmemory PostToolUse capture pipeline, which runs
 * a privacy filter over every observation before it is stored. Anything that
 * looks like a credential is redacted to a typed placeholder BEFORE it reaches
 * the database — not dropped, so the surrounding context still lands in memory.
 *
 * Pure functions, zero dependencies, safe to run on every capture path.
 */

export interface PrivacyResult {
  /** Text with any detected secrets replaced by typed placeholders. */
  text: string;
  /** How many secret occurrences were redacted. */
  redactionCount: number;
  /** Distinct credential kinds detected (e.g. "openai", "aws"). */
  kinds: string[];
}

interface SecretPattern {
  kind: string;
  /** Replaces the FULL match. */
  regex: RegExp;
}

// Order matters: more specific patterns first so a generic assignment rule
// does not swallow a typed token.
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'pem-private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'openai', regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'slack', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: 'generic-credential',
    // key=value / key: value forms where the value looks like a credential
    // (>=12 chars, no spaces). Keeps the key name for context.
    regex: /\b(api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|client[_-]?secret|token|key)(\s*[:=]\s*)(["']?)([A-Za-z0-9_\-\./+=]{12,})\3/gi,
  },
];

export function redactSecrets(input: string): PrivacyResult {
  let text = input;
  let redactionCount = 0;
  const kinds = new Set<string>();

  for (const { kind, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    text = text.replace(regex, (match, ...args) => {
      redactionCount++;
      kinds.add(kind);
      if (kind === 'generic-credential') {
        // args: paren groups (key, sep, quote, value) followed by offset+string.
        const groups = args.slice(0, -2) as string[];
        const key = groups[0] ?? 'credential';
        const sep = groups[1] ?? '=';
        const quote = groups[2] ?? '';
        return `${key}${sep}${quote}[REDACTED:${kind}]${quote}`;
      }
      return `[REDACTED:${kind}]`;
    });
  }

  return { text, redactionCount, kinds: [...kinds].sort() };
}

/** True when the text appears to carry any credential material. */
export function containsSecrets(input: string): boolean {
  return redactSecrets(input).redactionCount > 0;
}
