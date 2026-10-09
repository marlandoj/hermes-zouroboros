#!/usr/bin/env bun
// Zouroboros umbrella for Hermes: skill index, distribution doctor and the read-only operator shortcuts.
// Shortcut phrases resolve through zouroboros-core's exact-match resolver (no fuzzy execution path);
// each one runs an existing read-only command of this distribution and never a mutating variant.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { OPERATOR_SHORTCUTS, resolveOperatorShortcut, type OperatorShortcutId, type ShortcutDefinition } from 'zouroboros-core';
import { repoRoot, runtimeEnv, skillsDir } from '../../../../integration/profile.ts';

const usage = `zouroboros — Zouroboros on Hermes (hermes-zouroboros)
  skills [--json]          list the distribution's skills by category
  doctor                   profile prerequisites + governing documents + skill tree (JSON)
  shortcut "<phrase>"      run one read-only operator shortcut (exact phrases only)
  shortcuts                list the supported phrases`;

const skillScript = (skill: string, file: string) => join(skillsDir, 'zouroboros', skill, 'scripts', file);

/** Distribution command for each shortcut id; arguments are appended by `commandFor`. */
const WORKFLOWS: Record<OperatorShortcutId, string[]> = {
  status: [skillScript('zouroboros', 'zouroboros.ts'), 'doctor'],
  doctor: [skillScript('zouroboros', 'zouroboros.ts'), 'doctor'],
  'governance-verify': [skillScript('zouroboros-governance', 'constitution-gate.ts'), 'verify-docs'],
  'memory-search': [skillScript('zo-memory-system', 'zmem.ts'), 'search'],
  'swarm-status': [skillScript('zo-swarm-executors', 'executors.ts'), 'doctor'],
};

/** The core catalog's phrases, with workflows pointing at this distribution. */
export const SHORTCUTS: readonly ShortcutDefinition[] = OPERATOR_SHORTCUTS.map((definition) => ({
  ...definition,
  workflow: { program: 'bun', args: WORKFLOWS[definition.id].map((arg) => arg.startsWith(repoRoot) ? arg.slice(repoRoot.length + 1) : arg), readOnly: true },
}));

export function commandFor(id: OperatorShortcutId, args: Record<string, string>): string[] {
  const command = [...WORKFLOWS[id]];
  if (id === 'memory-search') command.push(args.query!);
  return command;
}

export interface SkillInfo { category: string; name: string; description: string; path: string }

export function listSkills(root = skillsDir): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const category of readdirSync(root, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const skill of readdirSync(join(root, category.name), { withFileTypes: true })) {
      const file = join(root, category.name, skill.name, 'SKILL.md');
      if (!skill.isDirectory() || !existsSync(file)) continue;
      const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
      const front = (match ? parse(match[1]!) : {}) as { name?: string; description?: string };
      out.push({ category: category.name, name: front.name ?? skill.name, description: String(front.description ?? '').trim(), path: join(category.name, skill.name) });
    }
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function runJson(args: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync([process.execPath, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let output: unknown = null;
  try { output = JSON.parse(result.stdout.toString()); } catch { /* not JSON */ }
  return { code: result.exitCode, output };
}

export function doctor() {
  const profile = runJson([join(repoRoot, 'integration/cli.ts'), 'doctor'], process.env);
  const governance = runJson([skillScript('zouroboros-governance', 'constitution-gate.ts'), 'verify-docs'], process.env);
  const skills = listSkills();
  const checks = {
    profile: profile.code === 0,
    governingDocuments: governance.code === 0,
    skills: skills.length > 0,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    profile: profile.output,
    governance: (governance.output as { violations?: unknown[] } | null)?.violations ?? null,
    skillCount: skills.length,
    note: 'Read-only. Provider authentication and live model execution need an operator smoke test.',
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'skills': {
      const skills = listSkills();
      if (rest.includes('--json')) console.log(JSON.stringify(skills, null, 2));
      else for (const skill of skills) console.log(`${skill.path.padEnd(48)} ${skill.description.slice(0, 90)}`);
      return 0;
    }
    case 'doctor': {
      const report = doctor();
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case 'shortcuts':
      for (const definition of SHORTCUTS) {
        console.log(`${definition.canonicalPhrase.padEnd(20)} ${[...definition.paraphrases, ...(definition.argumentPrefixes ?? []).map((prefix) => `${prefix.trim()} <query>`)].join(' | ')}`);
      }
      return 0;
    case 'shortcut': {
      const resolution = resolveOperatorShortcut(rest.join(' '), SHORTCUTS);
      if (resolution.kind === 'no-op') {
        console.log(JSON.stringify({ status: 'no-op', reason: resolution.reason, help: resolution.help }));
        return 2;
      }
      const { id, arguments: args } = resolution.envelope;
      // Profile-scoped environment, so memory and executor checks read this profile and never a host store.
      const child = Bun.spawnSync([process.execPath, ...commandFor(id, args)], { env: runtimeEnv(), stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      return child.exitCode;
    }
    default:
      console.log(usage);
      return command ? 2 : 0;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
