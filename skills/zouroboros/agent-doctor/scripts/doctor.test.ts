import { describe, expect, test } from "bun:test";
import {
  checkCostFitness,
  checkDuplicates,
  checkZombieAgents,
  instructionSimilarity,
  planCorrections,
  runsPerDay,
  toAgent,
  type AgentInfo,
  type ModelTiers,
} from "./doctor.ts";

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: crypto.randomUUID(),
    title: "Test Agent",
    instruction: "Run the bounded maintenance task and report material changes.",
    instructionComplete: true,
    model: "budget:model",
    modelPinned: true,
    active: true,
    schedule: "0 1 * * *",
    runsPerDay: 1,
    nextRun: "2099-01-01T01:00:00Z",
    deliver: "local",
    script: null,
    noAgent: false,
    workdir: null,
    lastStatus: null,
    lastError: null,
    lastDeliveryError: null,
    failureStreak: 0,
    ...overrides,
  };
}

const tiers: ModelTiers = {
  tiers: {
    budget: { maxCostPer1kInput: 0.2, models: ["budget:model"], labels: ["Budget"] },
    standard: { maxCostPer1kInput: 0.5, models: ["standard:model"], labels: ["Standard"] },
  },
  taskComplexity: {
    script_executor: {
      description: "Runs commands",
      recommendedTier: "budget",
      signals: ["run this command", "execute this"],
    },
  },
  downgradeDefaults: {
    bannedModelFallback: "budget:model",
    byTier: { budget: "budget:model", standard: "standard:model" },
  },
};

describe("instructionSimilarity", () => {
  test("does not confuse a contained generic prefix with a duplicate", () => {
    const shared = "Run this command in the workspace and report the complete result after verifying status";
    const embeddings = `${shared} backfill embeddings qdrant vectors facts cache coverage retry failures`;
    const security = `${shared} rotate credentials audit certificates secrets permissions exposure access controls`;
    expect(instructionSimilarity(embeddings, security)).toBeLessThan(0.72);
  });

  test("recognizes materially identical instructions", () => {
    const first = "Reindex qdrant memory embeddings verify vector coverage capture failures and publish metrics";
    const second = "Reindex qdrant memory embeddings verify vector coverage capture failures and publish metrics daily";
    expect(instructionSimilarity(first, second)).toBeGreaterThanOrEqual(0.72);
  });
});

describe("checkDuplicates", () => {
  test("removes fleet-wide boilerplate before comparing tasks", () => {
    const boilerplate = "Follow workspace rules verify every mutation report only material changes preserve unrelated state";
    const agents = Array.from({ length: 10 }, (_, index) => agent({
      title: `Distinct ${index}`,
      instruction: `${boilerplate} domain${index} operation${index} target${index} metric${index} schedule${index} owner${index}`,
    }));
    expect(checkDuplicates(agents)).toEqual([]);
  });

  test("retains a true duplicate after common-token filtering", () => {
    const filler = Array.from({ length: 10 }, (_, index) => agent({
      title: `Filler ${index}`,
      instruction: `Shared fleet boilerplate domain${index} operation${index} target${index} metric${index} schedule${index} owner${index}`,
    }));
    const duplicateInstruction = "Shared fleet boilerplate refresh qdrant embedding backlog validate coverage reconcile failures publish metrics";
    const findings = checkDuplicates([
      ...filler,
      agent({ title: "Memory A", instruction: duplicateInstruction }),
      agent({ title: "Memory B", instruction: `${duplicateInstruction} daily` }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].agentTitle).toBe("Memory A ↔ Memory B");
  });

  test("skips truncated instruction evidence", () => {
    const instruction = "Shared persona directive verify workspace changes publish material results only";
    const findings = checkDuplicates([
      agent({ title: "A", instruction, instructionComplete: false }),
      agent({ title: "B", instruction, instructionComplete: false }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("checkCostFitness", () => {
  test("groups unknown models without inventing a cost rank", () => {
    const findings = checkCostFitness([
      agent({ model: "unknown:model", instruction: "Run this command" }),
      agent({ model: "unknown:model", instruction: "Execute this" }),
    ], tiers);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "model-catalog", severity: "warning" });
    expect(findings[0].message).toContain("cost fitness was not evaluated");
  });

  test("still reports a known model that exceeds the recommended tier", () => {
    const findings = checkCostFitness([
      agent({ model: "standard:model", instruction: "Run this command" }),
    ], tiers);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: "cost-fitness", severity: "warning" });
  });
});

describe("Hermes cron jobs", () => {
  test("estimates runs per day from cron and interval schedules", () => {
    expect(runsPerDay({ kind: "interval", minutes: 30 })).toBe(48);
    expect(runsPerDay({ kind: "cron", expr: "0 9 * * *" })).toBe(1);
    expect(runsPerDay({ kind: "cron", expr: "*/15 * * * *" })).toBe(96);
    expect(runsPerDay({ kind: "cron", expr: "0 8-18/2 * * 1-5" })).toBe(6);
    expect(runsPerDay({ kind: "once", run_at: "2099-01-01T00:00:00Z" })).toBe(0);
  });

  test("maps a job, falling back to the profile model when none is pinned", () => {
    const mapped = toAgent({ id: "j1", name: "Digest", prompt: "Summarize", skills: ["deep-research"], enabled: true, state: "scheduled" }, "profile/model");
    expect(mapped).toMatchObject({ title: "Digest", model: "profile/model", modelPinned: false, active: true });
    expect(mapped.instruction).toContain("Skills: deep-research");
    expect(toAgent({ id: "j2", enabled: false }, "").active).toBe(false);
  });

  test("plans only safe fixes and never touches its own or excluded jobs", () => {
    const zombie = agent({ id: "z", nextRun: null });
    const self = agent({ id: "self", title: "agent-doctor weekly", nextRun: null });
    const excluded = agent({ id: "keep", nextRun: null });
    const unpinned = agent({ id: "u", model: "expensive:model", modelPinned: false, instruction: "Run this command" });
    const fleet = [zombie, self, excluded, unpinned];
    const policy = { ...tiers, safetyExcludeIds: ["keep"], tiers: { ...tiers.tiers, expensive: { maxCostPer1kInput: 20, models: ["expensive:model"], labels: ["Expensive"] } } };
    const findings = [...checkZombieAgents(fleet), ...checkCostFitness(fleet, policy)];
    const changes = planCorrections(fleet, findings, policy, [{ id: "self", name: "agent-doctor weekly" }]);
    expect(changes.map((c) => c.args)).toEqual([["pause", "z"]]);
  });
});
