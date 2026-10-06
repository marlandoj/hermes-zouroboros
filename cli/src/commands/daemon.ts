import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { resolveRuntimeDirectories } from 'zouroboros-core';
import {
  ControlPlaneDaemon,
  DurableTaskQueue,
  ExecutorRegistry,
  startOperatorApi,
  type GovernanceEvidence,
  type GovernanceVerifier,
} from '@zouroboros/control-plane';

function fileEvidenceVerifier(evidencePath: string): GovernanceVerifier {
  return {
    async verify(): Promise<GovernanceEvidence> {
      if (!existsSync(evidencePath)) {
        return {
          ok: false,
          evidence_digest: '',
          verified_at: new Date().toISOString(),
          reasons: [`governance evidence file not found: ${evidencePath}`],
        };
      }
      const raw = readFileSync(evidencePath, 'utf8');
      const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
      let parsed: { ok?: boolean };
      try {
        parsed = JSON.parse(raw) as { ok?: boolean };
      } catch {
        return {
          ok: false,
          evidence_digest: digest,
          verified_at: new Date().toISOString(),
          reasons: ['governance evidence is not valid JSON'],
        };
      }
      if (parsed.ok !== true) {
        return {
          ok: false,
          evidence_digest: digest,
          verified_at: new Date().toISOString(),
          reasons: ['governance evidence does not report ok: true'],
        };
      }
      return { ok: true, evidence_digest: digest, verified_at: new Date().toISOString(), reasons: [] };
    },
  };
}

export const daemonCommand = new Command('daemon')
  .description('Run the standalone control-plane daemon (durable queue, operator API, audit)')
  .requiredOption('--evidence <path>', 'Path to verified governance evidence JSON (fail-closed)')
  .option('--db <path>', 'SQLite path for the durable task queue')
  .option('--port <port>', 'Operator API port', '7601')
  .option('--host <host>', 'Operator API bind address', '127.0.0.1')
  .option('--workers <count>', 'Worker loop count', '2')
  .option('--token-env <name>', 'Environment variable holding the operator bearer token', 'ZOUROBOROS_OPERATOR_TOKEN')
  .action(async (options: { evidence: string; db?: string; port: string; host: string; workers: string; tokenEnv: string }) => {
    const token = process.env[options.tokenEnv];
    if (!token || token.length < 16) {
      console.error(chalk.red(`refusing to start: ${options.tokenEnv} must hold a bearer token of at least 16 characters`));
      process.exitCode = 1;
      return;
    }
    const dirs = resolveRuntimeDirectories({});
    const dbPath = options.db ?? join(dirs.state, 'control-plane', 'queue.db');
    const queue = new DurableTaskQueue({ dbPath });
    const executors = new ExecutorRegistry();
    const daemon = new ControlPlaneDaemon({
      queue,
      executors,
      governance: fileEvidenceVerifier(options.evidence),
      workerCount: Number.parseInt(options.workers, 10),
    });
    try {
      const evidence = await daemon.start();
      const server = startOperatorApi({
        queue,
        daemon,
        token,
        port: Number.parseInt(options.port, 10),
        hostname: options.host,
      });
      console.log(chalk.green(`control-plane daemon up: api http://${options.host}:${server.port}, db ${dbPath}`));
      console.log(chalk.gray(`governance evidence ${evidence.evidence_digest.slice(0, 12)} verified ${evidence.verified_at}`));
      const shutdown = async () => {
        server.stop(true);
        await daemon.stop();
        queue.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      queue.close();
      process.exitCode = 1;
    }
  });
