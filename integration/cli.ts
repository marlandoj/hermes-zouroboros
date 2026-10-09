#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, paths, registerSkills, repoRoot, restrictedEmailDomainsNotice, runtimeEnv, settings, skillsDir } from './profile.ts';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'init') {
    const { values } = parseArgs({ args, options: { workspace: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' } } });
    if (!values.workspace) throw new Error('init requires --workspace /absolute/workspace');
    console.log(JSON.stringify(initialize(values.workspace, { model: values.model, provider: values.provider }), null, 2));
    const notice = restrictedEmailDomainsNotice();
    if (notice) console.error(notice);
  } else if (command === 'skills' && args[0] === 'register') {
    console.log(JSON.stringify({ ...registerSkills(), skillsDir }, null, 2));
  } else if (command === 'doctor') {
    const p = paths();
    const checks = {
      bun: Boolean(Bun.version), hermes: Boolean(Bun.which('hermes')),
      profile: existsSync(join(p.profile, 'config.yaml')), registry: existsSync(p.registry),
      builtMemory: existsSync(join(repoRoot, 'packages/memory/dist/index.js')),
      builtSwarm: existsSync(join(repoRoot, 'packages/swarm/dist/index.js')),
      workspace: (() => { try { return existsSync(settings().workspace); } catch { return false; } })(),
    };
    const ok = Object.values(checks).every(Boolean);
    const notice = restrictedEmailDomainsNotice();
    console.log(JSON.stringify({ ok, checks, note: 'Local prerequisites only; provider authentication and live model execution need an operator smoke test.', ...(notice ? { notices: [notice] } : {}) }, null, 2));
    if (notice) console.error(notice);
    process.exitCode = ok ? 0 : 1;
  } else if (command === 'hermes') {
    const binary = Bun.which('hermes');
    if (!binary) throw new Error('Install Hermes Agent first.');
    const child = Bun.spawn([binary, ...args], { env: runtimeEnv(), cwd: settings().workspace, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await child.exited;
  } else if (command === 'memory') {
    const child = Bun.spawn([process.execPath, join(repoRoot, 'packages/memory/dist/cli.js'), ...args], { env: runtimeEnv(), cwd: settings().workspace, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await child.exited;
  } else if (command === 'swarm') {
    if (process.env.HERMES_ZOUROBOROS_ALLOW_SWARM !== '1') throw new Error('Execution is opt-in: set HERMES_ZOUROBOROS_ALLOW_SWARM=1 after reviewing the task file and workspace.');
    if (args.length !== 1) throw new Error('swarm requires one tasks.json path');
    const child = Bun.spawn([process.execPath, join(repoRoot, 'integration/swarm-worker.ts'), resolve(args[0]!)], { env: runtimeEnv(), cwd: settings().workspace, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await child.exited;
  } else {
    console.log('Hermes Zouroboros\n  init --workspace PATH [--model ID [--provider NAME]]\n  skills register (add skills/ to an existing profile)\n  doctor\n  hermes [setup | chat | ...]\n  memory store|search ...\n  swarm /absolute/tasks.json (opt-in)\nMCP: bun integration/mcp.ts');
    if (command && !['help', '--help', '-h'].includes(command)) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
}
