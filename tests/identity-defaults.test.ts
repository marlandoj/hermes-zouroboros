import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { approvedCandidateRepository, restrictedEmailDomains, sensitiveContentPattern } from '../packages/rag/src/candidate-policy.ts';
import { factoryRoots, logRoot, modelRoutingDir, workspaceRoot } from '../packages/swarm/src/host-roots.ts';
import { defaultShadowStateDir } from '../packages/capability-runtime/src/harness/shadow-cli.ts';

// Forward fixes of the 0.1.0 identifiers (f2): behaviour that depended on a source-host identifier
// now comes from configuration, and the defaults are neutral and portable.
const repo = resolve(import.meta.dir, '..');

test('restricted mail domains are redacted through configuration, subdomains included', () => {
  // Addresses and the key header are assembled at runtime so this file passes the leak gate.
  const at = (local: string, domain: string) => `${local}@${domain}`;
  const env = { ZOUROBOROS_RESTRICTED_EMAIL_DOMAINS: ' corp.example , @Other.Example.org, not a domain' };
  expect(restrictedEmailDomains(env)).toEqual(['corp.example', 'other.example.org']);
  const pattern = sensitiveContentPattern(env);
  expect(pattern.test(`mail ${at('jane.doe', 'corp.example')} today`)).toBe(true);
  expect(pattern.test(`mail ${at('ops', 'its.corp.example')}`)).toBe(true);
  expect(pattern.test(`mail ${at('x', 'OTHER.example.org')}`)).toBe(true);
  expect(pattern.test(`mail ${at('x', 'corp.example.net.invalid')}`)).toBe(false);
  expect(pattern.test(`mail ${at('x', 'notcorp.example')}`)).toBe(false);
  // Without configuration only key and token shapes are sensitive.
  expect(sensitiveContentPattern({}).test(`mail ${at('jane.doe', 'corp.example')}`)).toBe(false);
  expect(sensitiveContentPattern({}).test(['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' '))).toBe(true);
});

test('the candidate corpus repository is approved only by configuration (fail closed)', () => {
  expect(() => approvedCandidateRepository({})).toThrow('not approved');
  expect(() => approvedCandidateRepository({ ZOUROBOROS_CANDIDATE_REPOSITORY: 'git@host:o/r' })).toThrow('not approved');
  expect(approvedCandidateRepository({ ZOUROBOROS_CANDIDATE_REPOSITORY: 'https://git.example/o/r.git' })).toBe('https://git.example/o/r');
});

test('swarm host locations resolve under the portable roots', () => {
  const env = { HOME: '/h', ZOUROBOROS_STATE_DIR: '/s', ZOUROBOROS_WORKSPACE: '/w' };
  expect(workspaceRoot(env)).toBe('/w');
  expect(logRoot(env)).toBe('/s/logs');
  expect(modelRoutingDir(env)).toBe('/s/model-routing');
  expect(factoryRoots(env)).toEqual({
    source: '/w', legacyWorktrees: '/w/.factory-worktrees',
    external: '/s/factory', externalWorktrees: '/s/factory/.factory-worktrees', externalReleases: '/s/factory/releases',
  });
  expect(factoryRoots({ ...env, FACTORY_SOURCE_ROOT: '/src', FACTORY_EXTERNAL_ROOT: '/ext' }).externalReleases).toBe('/ext/releases');
  expect(defaultShadowStateDir({ ZOUROBOROS_STATE_DIR: '/s' })).toBe('/s/zcr-shadow');
  expect(defaultShadowStateDir({ ZOUROBOROS_WORKSPACE: '/w' })).toBe('/w/.zouroboros/zcr-shadow');
});

test('persona and actor defaults are neutral', () => {
  const client = readFileSync(join(repo, 'packages/swarm/src/client/executor-client.ts'), 'utf8');
  expect(client).toContain("opts.persona ?? (process.env.ZOUROBOROS_DEFAULT_PERSONA || 'default')");
  const bootstrap = readFileSync(join(repo, 'packages/capability-runtime/src/harness/shadow-bootstrap.ts'), 'utf8');
  expect(bootstrap).toContain('process.env.ZCR_SHADOW_ACTOR || "operator"');
  const fixture = JSON.parse(readFileSync(join(repo, 'packages/workflow/src/plan-gate/__fixtures__/zou-725-regressions.json'), 'utf8'));
  const actors = JSON.stringify(fixture).match(/"actor":\{"id":"[^"]+"/g) ?? [];
  expect(actors.length).toBeGreaterThan(0);
  for (const actor of actors) expect(actor).toBe('"actor":{"id":"operator"');
});

test('the shell bridges default to the workspace and operator home, not host paths', () => {
  const bridges = join(repo, 'packages/swarm/src/executor/bridges');
  for (const name of ['claude-code', 'codex', 'gemini', 'kimi', 'opencode', 'pi', 'template']) {
    expect(readFileSync(join(bridges, `${name}-bridge.sh`), 'utf8')).toContain('WORKDIR="${2:-${ZOUROBOROS_WORKSPACE:-$PWD}}"');
  }
  const hermes = readFileSync(join(bridges, 'hermes-bridge.sh'), 'utf8');
  expect(hermes).toContain('OPERATOR_HOME="${ZOUROBOROS_OPERATOR_HOME:-$HOME}"');
  expect(hermes).toContain('export HERMES_HOME="${HERMES_HOME:-$OPERATOR_HOME/.hermes}"');
  const resolved = Bun.spawnSync(['bash', '-c', `source ${join(bridges, 'model-catalog-resolve.sh')}; printf %s "$MODEL_CATALOG_PATH"`], {
    env: { PATH: process.env.PATH!, HOME: '/h', ZOUROBOROS_STATE_DIR: '/s' }, stdout: 'pipe',
  });
  expect(resolved.stdout.toString()).toBe('/s/model-routing/swarm/current.json');
});
