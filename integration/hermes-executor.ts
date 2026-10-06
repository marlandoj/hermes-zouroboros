import { isAbsolute, join } from 'node:path';

/** A generated, relocatable registry for the vendored Zouroboros swarm loader. */
export function createHermesRegistry(repoRoot: string, model?: string) {
  if (!isAbsolute(repoRoot)) throw new Error('Repository root must be absolute');
  return {
    $schema: 'executor-registry/v1',
    description: 'Hermes Agent execution using this distribution’s portable bridge',
    executors: [{
      // Distinct from the workspace's hermes ID: its router merges host model
      // floors/catalogs by ID even when an external registry is selected.
      id: 'hermes-vps',
      name: 'Hermes Agent',
      executor: 'local',
      transport: 'bridge',
      bridge: join(repoRoot, 'integration', 'hermes-bridge.sh'),
      description: 'Unattended one-shot Hermes Agent with caller-selected profile and workspace',
      expertise: ['code-generation', 'code-review', 'web-research', 'tool-orchestration', 'testing'],
      best_for: ['Bounded tasks explicitly authorized for unattended execution'],
      config: { defaultTimeout: 300, ...(model ? { model } : {}) },
      capabilities: { fileRead: true, fileWrite: true, shellExec: true, webResearch: true, mcp: true, streaming: false },
      healthCheck: { command: 'hermes --version', expectedPattern: '[Hh]ermes', description: 'Check the installed Hermes CLI on PATH' },
    }],
  };
}
