/**
 * Approval policy for the public candidate corpus, read from configuration instead of
 * source-host literals.
 *
 *   ZOUROBOROS_CANDIDATE_REPOSITORY      the one https repository URL a public candidate corpus may
 *                                        come from; unset means no corpus is approved (fail closed)
 *   ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS  comma-separated mail domains (subdomains included) whose
 *                                        addresses mark text as sensitive, for example an employer's
 *                                        domain; key and token patterns apply regardless
 */
type Env = Record<string, string | undefined>;

export function approvedCandidateRepository(env: Env = process.env): string {
  const value = env.ZOUROBOROS_CANDIDATE_REPOSITORY?.trim();
  if (!value || !/^https:\/\/[^\s/]+\/\S+$/.test(value)) {
    throw new Error('Candidate corpus repository is not approved: set ZOUROBOROS_CANDIDATE_REPOSITORY to its https URL');
  }
  return value.replace(/\.git$/, '').replace(/\/+$/, '');
}

export function restrictedEmailDomains(env: Env = process.env): string[] {
  return (env.ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain));
}

const SECRET_SHAPES = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b`;

/** Private keys, common token shapes and addresses at the configured restricted domains. */
export function sensitiveContentPattern(env: Env = process.env): RegExp {
  const domains = restrictedEmailDomains(env).map((domain) => domain.replace(/[.-]/g, (char) => `\\${char}`));
  const email = domains.length ? String.raw`|\b[^\s@]+@(?:[A-Za-z0-9-]+\.)*(?:${domains.join('|')})(?![A-Za-z0-9-]|\.[A-Za-z0-9])` : '';
  return new RegExp(SECRET_SHAPES + email, 'i');
}
