/**
 * MCP (Model Context Protocol) server for Zouroboros Memory
 *
 * Exposes memory operations as MCP tools accessible by external
 * AI agents and clients via stdio transport.
 *
 * Usage: bun run packages/memory/src/mcp-server.ts [--db-path <path>]
 */

import { initDatabase, closeDatabase, getDbStats, getDatabase } from './database.js';
import { storeFact, searchFacts, searchFactsHybrid, getFact, deleteFact, cleanupExpiredFacts } from './facts.js';
import { routeMemoryQuery } from './routing-gate.js';
import { rerankResults } from './reranker.js';
import { answerWithCoT } from './cot-answer.js';
import type { Disposition } from './cot-answer.js';
import { createEpisode, searchEpisodes, getEntityEpisodes, getEpisodeStats } from './episodes.js';
import { getProfile, updateTraits, updatePreferences, recordInteraction, getProfileSummary, listProfiles } from './profiles.js';
import { ensureProfileSchema } from './profiles.js';
import { buildEntityGraph, getRelatedEntities } from './graph.js';
import { extractFromText } from './capture.js';
import { searchProcedures, getProcedure, getProcedureVersions, compareProcedureVersions, getProcedureEpisodes } from './procedures.js';
import { applyDefense } from './defense.js';
import { consolidateObservations, listObservations, getObservation, searchObservations } from './observations.js';
import { defineMentalModel, readMentalModel, listMentalModels, refreshMentalModel, refreshDueMentalModels } from './mental-models.js';
import type { MemoryConfig } from 'zouroboros-core';

// ============================================================================
// MCP Protocol Types (subset)
// ============================================================================

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: McpToolDefinition[] = [
  {
    name: 'memory_store',
    description: 'Store a fact in memory with optional embedding generation',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'The entity this fact is about' },
        value: { type: 'string', description: 'The fact content' },
        key: { type: 'string', description: 'Optional key for the fact' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision', 'convention', 'other', 'reference', 'project'] },
        decay: { type: 'string', enum: ['permanent', 'long', 'medium', 'short'] },
        importance: { type: 'number', description: 'Importance score (default 1.0)' },
      },
      required: ['entity', 'value'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search facts by keyword or semantic similarity',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        entity: { type: 'string', description: 'Filter by entity' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        mode: { type: 'string', enum: ['keyword', 'hybrid', 'deep'], description: 'Search mode: keyword (exact), hybrid (RRF fusion), deep (hybrid + rerank + CoT answer)' },
        disposition: { type: 'object', description: 'Optional disposition knobs for deep-mode answering, each 0..1 (skepticism, literalism, empathy)', properties: { skepticism: { type: 'number' }, literalism: { type: 'number' }, empathy: { type: 'number' } } },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_episodes',
    description: 'Search or create episodic memories',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'create', 'entity'], description: 'Action to perform' },
        summary: { type: 'string', description: 'Episode summary (for create)' },
        outcome: { type: 'string', enum: ['success', 'failure', 'resolved', 'ongoing'] },
        entities: { type: 'array', items: { type: 'string' }, description: 'Related entities' },
        entity: { type: 'string', description: 'Entity to search episodes for (for entity action)' },
        since: { type: 'string', description: 'ISO date filter (for search)' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cognitive_profile',
    description: 'Get or update cognitive profiles for entities',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update_traits', 'update_preferences', 'summary', 'list'] },
        entity: { type: 'string', description: 'Entity name' },
        traits: { type: 'object', description: 'Traits to update (name → score)' },
        preferences: { type: 'object', description: 'Preferences to update (key → value)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory_graph',
    description: 'Query the entity relationship graph',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['related', 'build'], description: 'Graph action' },
        entity: { type: 'string', description: 'Entity to find relations for' },
        depth: { type: 'number', description: 'Traversal depth (default 2)' },
        limit: { type: 'number', description: 'Max related entities (default 20)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory_procedures',
    description: 'Query stored procedures (workflow memory). Search, get specific versions, compare versions, or list linked episodes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'get', 'versions', 'compare', 'episodes'], description: 'Action: search by name, get specific, list versions, compare two versions, or get linked episodes' },
        name: { type: 'string', description: 'Procedure name (for get/versions/compare/episodes)' },
        query: { type: 'string', description: 'Search query (for search action)' },
        version: { type: 'number', description: 'Specific version (for get)' },
        fromVersion: { type: 'number', description: 'Version to compare from (for compare)' },
        toVersion: { type: 'number', description: 'Version to compare to (for compare)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory system statistics',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a specific fact by ID. Cascades to embeddings, links, and activation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The fact UUID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_prune',
    description: 'Garbage-collect expired facts. Returns count of deleted facts.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'Preview what would be pruned without deleting (default false)' },
      },
    },
  },
  {
    name: 'memory_defense_scan',
    description: 'Scan text for secrets (API keys, tokens, private keys, JWTs, connection strings) and opt-in PII before it would be retained. Returns findings and the redacted form. Never stores anything.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to scan' },
        include_pii: { type: 'boolean', description: 'Also scan for PII patterns (SSN, email, Luhn-verified credit cards). Default false' },
        policy: { type: 'string', enum: ['redact', 'block'], description: 'Override policy for this scan (default: env ZO_MEMORY_DEFENSE or redact)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_observations',
    description: 'Work with observations — evidence-backed consolidated beliefs refined (not overwritten) as facts accumulate. Consolidate facts, list, show evidence, or search.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['consolidate', 'list', 'show', 'search'], description: 'Action to perform' },
        persona: { type: 'string', description: 'Persona scope (default: all for consolidate; all for list)' },
        min_proof: { type: 'number', description: 'Minimum corroborating facts required (default 2, consolidate only)' },
        use_llm: { type: 'boolean', description: 'Use LLM synthesis for belief text (default false = deterministic; consolidate only)' },
        status: { type: 'string', enum: ['active', 'contested', 'faded'], description: 'Filter by status (list only)' },
        id: { type: 'string', description: 'Observation ID (show only)' },
        query: { type: 'string', description: 'Search query (search only)' },
        limit: { type: 'number', description: 'Max results (default 50 list / 10 search)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'memory_mental_models',
    description: 'Standing answers to standing questions per persona. Reads are plain DB reads (zero tokens, no LLM); refreshes rewrite the answer in the background. Define, read, list, or refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['define', 'read', 'list', 'refresh', 'refresh_due'], description: 'Action to perform' },
        persona: { type: 'string', description: 'Persona scope (default shared)' },
        question: { type: 'string', description: 'The standing question (define/read)' },
        refresh_interval_s: { type: 'number', description: 'Seconds between refreshes (define only, default 86400)' },
        id: { type: 'string', description: 'Mental model ID (refresh only; unique prefixes accepted)' },
      },
      required: ['action'],
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  config: MemoryConfig
): Promise<unknown> {
  switch (name) {
    case 'memory_store': {
      const result = await storeFact({
        entity: args.entity as string,
        value: args.value as string,
        key: args.key as string | undefined,
        category: args.category as any,
        decay: args.decay as any,
        importance: args.importance as number | undefined,
        source: 'mcp',
      }, config);
      return { stored: true, id: result.id, entity: result.entity };
    }

    case 'memory_search': {
      const mode = (args.mode as string) ?? 'keyword';
      if (mode === 'deep') {
        const deepConfig: typeof config = {
          ...config,
          reranker: { enabled: true, ...config.reranker },
          cot: { enabled: true, ...config.cot },
        };
        const hybridResults = await routeMemoryQuery(args.query as string, deepConfig, {
          limit: 10,
          rerank: true,
        });
        const answer = await answerWithCoT(args.query as string, hybridResults, deepConfig, {
          disposition: args.disposition as Disposition | undefined,
        });
        return { results: hybridResults, answer };
      }
      if (mode === 'hybrid') {
        return routeMemoryQuery(args.query as string, config, {
          limit: args.limit as number | undefined,
        });
      }
      return searchFacts(args.query as string, {
        entity: args.entity as string | undefined,
        category: args.category as string | undefined,
        limit: args.limit as number | undefined,
      });
    }

    case 'memory_episodes': {
      const action = args.action as string;
      if (action === 'create') {
        return createEpisode({
          summary: args.summary as string,
          outcome: (args.outcome as any) ?? 'ongoing',
          entities: (args.entities as string[]) ?? ['system'],
        });
      }
      if (action === 'entity') {
        return getEntityEpisodes(args.entity as string, {
          limit: args.limit as number | undefined,
        });
      }
      return searchEpisodes({
        since: args.since as string | undefined,
        outcome: args.outcome as string | undefined,
        limit: args.limit as number | undefined,
      });
    }

    case 'cognitive_profile': {
      const action = args.action as string;
      if (action === 'list') return listProfiles();
      if (action === 'summary') return getProfileSummary(args.entity as string);
      if (action === 'update_traits') {
        updateTraits(args.entity as string, args.traits as Record<string, number>);
        return { updated: true };
      }
      if (action === 'update_preferences') {
        updatePreferences(args.entity as string, args.preferences as Record<string, string>);
        return { updated: true };
      }
      return getProfile(args.entity as string);
    }

    case 'memory_graph': {
      const action = args.action as string;
      if (action === 'build') return buildEntityGraph();
      return getRelatedEntities(args.entity as string, {
        depth: args.depth as number | undefined,
        limit: args.limit as number | undefined,
      });
    }

    case 'memory_procedures': {
      const action = args.action as string;
      if (action === 'search') {
        return searchProcedures(args.query as string, args.limit as number | undefined);
      }
      if (action === 'get') {
        return getProcedure(args.name as string, args.version as number | undefined);
      }
      if (action === 'versions') {
        return getProcedureVersions(args.name as string);
      }
      if (action === 'compare') {
        return compareProcedureVersions(
          args.name as string,
          args.fromVersion as number,
          args.toVersion as number,
        );
      }
      if (action === 'episodes') {
        return getProcedureEpisodes(args.name as string, args.limit as number | undefined);
      }
      throw new Error(`Unknown memory_procedures action: ${action}`);
    }

    case 'memory_stats': {
      const dbStats = getDbStats(config);
      const epStats = getEpisodeStats();
      return { database: dbStats, episodes: epStats };
    }

    case 'memory_delete': {
      const id = args.id as string;
      if (!id) throw new Error('id is required');
      const deleted = deleteFact(id);
      if (!deleted) throw new Error(`Fact not found: ${id}`);
      return { deleted: true, id };
    }

    case 'memory_prune': {
      const dryRun = (args.dry_run as boolean) ?? false;
      if (dryRun) {
        const db = getDatabase();
        const rows = db.query(
          "SELECT id FROM facts WHERE expires_at IS NOT NULL AND expires_at < strftime('%s', 'now')"
        ).all() as Array<{ id: string }>;
        return { dry_run: true, would_delete: rows.length, ids: rows.slice(0, 20).map(r => r.id) };
      }
      const count = cleanupExpiredFacts();
      return { pruned: count };
    }

    case 'memory_defense_scan': {
      const result = applyDefense(args.text as string, {
        policy: args.policy as 'redact' | 'block' | undefined,
        includePii: (args.include_pii as boolean) ?? undefined,
      });
      return {
        findings: result.findings,
        blocked: result.blocked,
        text: result.text,
      };
    }

    case 'memory_observations': {
      const action = args.action as string;
      if (action === 'consolidate') {
        return consolidateObservations({
          persona: args.persona as string | undefined,
          minProof: args.min_proof as number | undefined,
          useLlm: (args.use_llm as boolean) ?? false,
        });
      }
      if (action === 'list') {
        return listObservations({
          persona: args.persona as string | undefined,
          status: args.status as 'active' | 'contested' | 'faded' | undefined,
          limit: args.limit as number | undefined,
        });
      }
      if (action === 'show') {
        if (!args.id) throw new Error('id is required for show');
        const full = getObservation(args.id as string);
        if (!full) throw new Error(`Observation not found: ${args.id}`);
        return full;
      }
      if (action === 'search') {
        if (!args.query) throw new Error('query is required for search');
        return searchObservations(args.query as string, {
          persona: args.persona as string | undefined,
          limit: args.limit as number | undefined,
        });
      }
      throw new Error(`Unknown memory_observations action: ${action}`);
    }

    case 'memory_mental_models': {
      const action = args.action as string;
      if (action === 'define') {
        if (!args.question) throw new Error('question is required for define');
        return defineMentalModel({
          persona: args.persona as string | undefined,
          question: args.question as string,
          refreshIntervalS: args.refresh_interval_s as number | undefined,
        });
      }
      if (action === 'read') {
        if (!args.question) throw new Error('question is required for read');
        const model = readMentalModel((args.persona as string) ?? 'shared', args.question as string);
        if (!model) return { defined: false, question: args.question };
        return model;
      }
      if (action === 'list') {
        return listMentalModels({ persona: args.persona as string | undefined });
      }
      if (action === 'refresh') {
        if (!args.id) throw new Error('id is required for refresh');
        const all = listMentalModels();
        const target = all.find(m => m.id === args.id) ?? all.find(m => m.id.startsWith(args.id as string));
        if (!target) throw new Error(`Mental model not found: ${args.id}`);
        return refreshMentalModel(target.id);
      }
      if (action === 'refresh_due') {
        return refreshDueMentalModels();
      }
      throw new Error(`Unknown memory_mental_models action: ${action}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// MCP Server (stdio transport)
// ============================================================================

function createResponse(id: number | string, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

function createError(id: number | string, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMessage(
  message: McpRequest,
  config: MemoryConfig
): Promise<McpResponse> {
  try {
    switch (message.method) {
      case 'initialize':
        return createResponse(message.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zouroboros-memory', version: '2.0.0' },
        });

      case 'tools/list':
        return createResponse(message.id, { tools: TOOLS });

      case 'tools/call': {
        const params = message.params as { name: string; arguments: Record<string, unknown> };
        const result = await handleToolCall(params.name, params.arguments ?? {}, config);
        return createResponse(message.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      case 'notifications/initialized':
        // Client ack — no response needed for notifications, but return empty
        return createResponse(message.id, {});

      default:
        return createError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (err) {
    return createError(
      message.id,
      -32000,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Start the MCP server on stdio.
 */
export async function startMcpServer(config: MemoryConfig): Promise<void> {
  // Initialize database
  initDatabase(config);
  ensureProfileSchema();

  const decoder = new TextDecoder();
  let buffer = '';

  process.stdin.resume();
  process.stdin.on('data', async (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request: McpRequest = JSON.parse(trimmed);
        const response = await handleMessage(request, config);

        // Don't respond to notifications (no id)
        if (request.id !== undefined) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch {
        // Skip malformed messages
      }
    }
  });

  process.on('SIGINT', () => {
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closeDatabase();
    process.exit(0);
  });
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPathIdx = args.indexOf('--db-path');
  const dbPath = dbPathIdx >= 0 ? args[dbPathIdx + 1] : undefined;

  const config: MemoryConfig = {
    enabled: true,
    dbPath: dbPath ?? `${process.env.HOME}/.zouroboros/memory.db`,
    vectorEnabled: false,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    autoCapture: false,
    captureIntervalMinutes: 30,
    graphBoost: true,
    hydeExpansion: false,
    decayConfig: { permanent: Infinity, long: 365, medium: 90, short: 30 },
  };

  startMcpServer(config);
}
