import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGraph, normalizeSources } from "./extract.ts";
import { cacheDir, defaultDbPath, factoryDir, factorySources, NO_SOURCE_MESSAGE } from "./paths.ts";
import { buildRefusal, ensureRedisServer } from "./runtime.ts";

// Offline checks: no falkordblite, no Redis, no network.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "graphrag-offline-"));
  roots.push(root);
  return root;
}

describe("portable paths", () => {
  test("graph data and the Redis cache resolve under the profile, never a host path", () => {
    const env = { HERMES_ZOUROBOROS_HOME: "/profile/data" };
    expect(defaultDbPath(env)).toBe("/profile/data/state/graphrag-relational/falkordblite");
    expect(cacheDir(env)).toBe("/profile/data/cache/falkordblite");
    expect(cacheDir({ ...env, ZOUROBOROS_CACHE_DIR: "/c" })).toBe("/c/falkordblite");
    expect(defaultDbPath({ ...env, ZOUROBOROS_STATE_DIR: "/s" })).toBe("/s/graphrag-relational/falkordblite");
    expect(defaultDbPath({ ...env, GRAPHRAG_DB_DIR: "/g" })).toBe("/g/falkordblite");
    expect(factoryDir(env)).toBeNull();
    expect(factorySources("/f")).toEqual({ swarmDbPath: "/f/swarm.db", factoryLogPath: "/f/state/factory-log.jsonl", stateDir: "/f/state" });
  });

  test("refuses to guess a source", () => {
    expect(() => normalizeSources({ swarmDbPath: "", factoryLogPath: "", stateDir: "", ticketJsonPaths: [] })).toThrow(NO_SOURCE_MESSAGE);
  });
});

describe("extractGraph", () => {
  test("builds typed nodes and edges from a factory log, execution state, tickets and SQLite foreign keys", () => {
    const root = scratch();
    const dir = join(root, "factory");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "factory-log.jsonl"), [
      JSON.stringify({ execution_id: "exec-1", ticket_id: "t-1", identifier: "TASK-1", gate_decision: "SWARM", status: "failed", cost_usd: 0.5 }),
      "not json",
      JSON.stringify({ kind: "noise" }),
    ].join("\n"));
    writeFileSync(join(dir, "state", "exec-2.json"), JSON.stringify({ execution_id: "exec-2", ticket_id: "t-2", gate_decision: "DIRECT", status: "complete" }));
    const tickets = join(root, "tickets.json");
    writeFileSync(tickets, JSON.stringify({ issues: [{ id: "t-1", identifier: "TASK-1", title: "Alpha", labels: [{ name: "graph" }], state: { name: "Done" } }] }));
    const db = new Database(join(dir, "swarm.db"));
    db.run("CREATE TABLE executions (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE tickets (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE links (id TEXT, ticket_id TEXT REFERENCES tickets(id))");
    db.close();

    const graph = extractGraph({ ...factorySources(dir), ticketJsonPaths: [tickets], outPath: null, pretty: false });
    expect(graph.counts.nodes).toEqual({ Execution: 2, Ticket: 2, CostEntry: 1, GateDecision: 2, FactoryRecord: 1 });
    expect(graph.counts.edges).toEqual({ IMPLEMENTS: 2, INCURRED_COST: 1, GATED_BY: 2, HAS_RECORD: 1 });
    expect(graph.nodes.find((node) => node.id === "Ticket:t-1")?.properties).toMatchObject({ title: "Alpha", source: "tickets", labels: ["graph"] });
    expect(graph.sources.swarmDb.engine).toBe("sqlite");
    expect(graph.sources.swarmDb.tables.map((table) => table.name)).toEqual(["executions", "links", "tickets"]);
    expect(graph.sources.ticketSources).toEqual([tickets]);
    expect(graph.warnings.length).toBe(2);
  });

  test("reports missing inputs instead of failing", () => {
    const root = scratch();
    const graph = extractGraph({ ...factorySources(join(root, "absent")), ticketJsonPaths: [], outPath: null, pretty: false });
    expect(graph.nodes).toEqual([]);
    expect(graph.sources.swarmDb.engine).toBe("missing");
  });
});

describe("first-use Redis build", () => {
  test("never builds in CI or when disabled", () => {
    expect(buildRefusal({ CI: "true" })).toContain("CI");
    expect(buildRefusal({ GRAPHRAG_NO_BUILD: "1" })).toContain("GRAPHRAG_NO_BUILD");
    expect(buildRefusal({ CI: "false" })).toBeNull();
    expect(buildRefusal({})).toBeNull();
  });

  test("an uncached binary is refused without a download when the build is disabled", async () => {
    const root = scratch();
    const saved = { CI: process.env.CI, override: process.env.FALKORDBLITE_REDIS_SERVER };
    process.env.CI = "true";
    delete process.env.FALKORDBLITE_REDIS_SERVER;
    try {
      await expect(ensureRedisServer({ cacheDir: join(root, "cache") })).rejects.toThrow("disabled in CI");
    } finally {
      if (saved.CI === undefined) delete process.env.CI; else process.env.CI = saved.CI;
      if (saved.override !== undefined) process.env.FALKORDBLITE_REDIS_SERVER = saved.override;
    }
  });

  test("an explicit binary override must exist", async () => {
    await expect(ensureRedisServer({ redisServerPath: join(scratch(), "missing-redis-server") })).rejects.toThrow("not found");
  });
});
