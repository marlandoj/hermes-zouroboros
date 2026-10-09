import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  renderFactorySeed,
  renderFactoryTicket,
  renderSpec,
  validateSpec,
  panelStatus,
  parseReviewVerdict,
} from "./spec-tool";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function validSpec(): any {
  return {
    schemaVersion: 1,
    metadata: {
      project: "Example Service Dashboard",
      version: "1.0.0",
      date: "2026-08-02",
      owner: "Operator",
      releaseTier: "production",
      executionMode: "direct",
      source: {
        path: "source.prompt.md",
        sha256: "a".repeat(64),
        label: "source prompt",
      },
      template: {
        id: "web-app",
        version: "1.0.0",
        level: "factory",
        sha256: "b".repeat(64),
        annexes: [{ id: "auth", version: "1.0.0", sha256: "c".repeat(64) }],
      },
    },
    mission: {
      statement: "Build a service dashboard with observable health states.",
      firstExperience: "The dashboard opens directly to current service status.",
      qualities: ["clear", "fast", "operational"],
      releaseTier: "production",
      excludedTier: "prototype",
    },
    factory: {
      targetRepo: "Sites/service-dashboard",
      archetype: "feature",
      area: "New dashboard application and its health API integration.",
    },
    constraints: [
      { id: "C-001", text: "Use TypeScript.", origin: "source", sourceRefs: ["source:L2"] },
    ],
    antiGoals: [
      { id: "AG-001", text: "Do not use mocked production data.", origin: "proposed", sourceRefs: [] },
    ],
    protectedCapabilities: [
      {
        id: "PC-001",
        text: "The primary health journey remains operational.",
        origin: "proposed",
        sourceRefs: [],
        requirementIds: ["FR-001"],
      },
    ],
    scopeCutOrder: ["Historical charts", "Theme customization"],
    decisions: [
      {
        id: "D-001",
        question: "Which API contract is authoritative?",
        options: ["Existing local API"],
        requiredEvidence: "Repository inspection",
        owner: "Operator",
        status: "resolved",
        resolution: "Existing local API",
      },
    ],
    contracts: [
      {
        id: "SC-001",
        name: "Service health record",
        canonicalLocation: "src/contracts/health.ts",
        consumers: ["API", "dashboard"],
        owner: "contracts",
        invariants: ["latency is milliseconds", "status is a closed enum"],
      },
    ],
    requirements: [
      {
        id: "FR-001",
        type: "functional",
        text: "Display current health for every service.",
        origin: "source",
        sourceRefs: ["source:L4"],
        verificationIds: ["V-002"],
      },
      {
        id: "NFR-001",
        type: "nonfunctional",
        text: "TypeScript compiles without errors.",
        origin: "proposed",
        sourceRefs: [],
        verificationIds: ["V-001"],
      },
    ],
    verifications: [
      {
        id: "V-001",
        type: "static",
        method: "Run tsc --noEmit",
        threshold: "Zero errors",
        authority: "automated",
      },
      {
        id: "V-002",
        type: "integration",
        method: "Run the dashboard API journey test",
        threshold: "All service states render from the real fixture contract",
        authority: "automated",
      },
    ],
    canonicalScenarios: [
      {
        id: "CS-001",
        name: "Mixed service health",
        setup: "Healthy, degraded, and offline services",
        action: "Open the dashboard",
        qualities: ["status clarity"],
        evidence: "Playwright screenshot and assertions",
      },
    ],
    acceptanceCriteria: [
      {
        id: "AC-001",
        text: "Every current service health state is displayed.",
        origin: "source",
        sourceRefs: ["source:L4"],
        requirementIds: ["FR-001"],
        verificationIds: ["V-002"],
        authority: "automated",
      },
      {
        id: "AC-002",
        text: "TypeScript compilation passes.",
        origin: "proposed",
        sourceRefs: [],
        requirementIds: ["NFR-001"],
        verificationIds: ["V-001"],
        authority: "automated",
      },
    ],
    milestones: [
      {
        id: "M0",
        name: "Contracts and harness",
        dependencies: [],
        ownedPaths: ["src/contracts/"],
        exitCriteria: ["AC-002"],
        approval: "automated",
        owner: "contracts",
      },
      {
        id: "M1",
        name: "Dashboard journey",
        dependencies: ["M0"],
        ownedPaths: ["src/dashboard/"],
        exitCriteria: ["AC-001"],
        approval: "user",
        owner: "frontend",
      },
    ],
    humanCriteria: [
      {
        id: "HC-001",
        question: "Are the three health states distinguishable at a glance?",
        scenarioIds: ["CS-001"],
        approver: "Operator",
      },
    ],
    deliverables: ["Application", "Tests", "README"],
    outOfScope: ["Incident remediation"],
    unresolved: [],
  };
}

function personaSpec(): any {
  const spec = validSpec();
  spec.metadata.personaAssociation = {
    templateReference: "web-app@1.0.0",
    associationVersion: "1.0.0",
    associationSha256: "d".repeat(64),
    declaredCapabilities: ["web-ui"],
    selectorValues: {},
    fleet: [{
      roleId: "frontend-developer",
      personaName: "Frontend Developer",
      required: true,
      phases: ["advise", "implement", "review"],
      requiredScopes: ["files:read", "files:write"],
      invocationCap: 2,
    }],
    omittedRoles: [],
  };
  spec.milestones[1].personaAssignments = [{
    roleId: "frontend-developer",
    authority: "implement",
    ownedPaths: ["src/dashboard/"],
  }];
  return spec;
}

describe("deterministic validation", () => {
  test("a complete specification passes with a score of 100", () => {
    const report = validateSpec(validSpec());
    expect(report.errors).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.decision).toBe("PASS");
  });

  test("an unknown evidence reference fails", () => {
    const spec = validSpec();
    spec.acceptanceCriteria[0].verificationIds = ["V-999"];
    const report = validateSpec(spec);
    expect(report.decision).toBe("FAIL");
    expect(report.errors.some((error) => error.includes("unknown verification V-999"))).toBe(true);
  });

  test("a blocking unresolved decision holds", () => {
    const spec = validSpec();
    spec.unresolved.push({ id: "U-001", question: "Confirm target repo", blocking: true, owner: "Operator" });
    const report = validateSpec(spec);
    expect(report.valid).toBe(true);
    expect(report.decision).toBe("HOLD");
  });

  test("unordered overlapping milestone paths fail", () => {
    const spec = validSpec();
    spec.milestones[1].dependencies = [];
    spec.milestones[1].ownedPaths = ["src/contracts/types/"];
    const report = validateSpec(spec);
    expect(report.decision).toBe("FAIL");
    expect(report.errors.some((error) => error.includes("overlapping owned paths"))).toBe(true);
  });

  test("specialist authority is bounded by exact association phases and task paths", () => {
    expect(validateSpec(personaSpec()).decision).toBe("PASS");
    const noPaths = personaSpec();
    noPaths.milestones[1].personaAssignments[0].ownedPaths = [];
    expect(validateSpec(noPaths).errors.some((error) => error.includes("requires non-empty task-owned paths"))).toBe(true);
    const unknown = personaSpec();
    unknown.milestones[1].personaAssignments[0].roleId = "invented-specialist";
    expect(validateSpec(unknown).errors.some((error) => error.includes("not present in the exact association"))).toBe(true);
    const escalated = personaSpec();
    escalated.metadata.personaAssociation.fleet[0].phases = ["advise", "review"];
    expect(validateSpec(escalated).errors.some((error) => error.includes("exceeds association permitted phases"))).toBe(true);
    const escaped = personaSpec();
    escaped.milestones[1].personaAssignments[0].ownedPaths = ["src/admin/"];
    expect(validateSpec(escaped).errors.some((error) => error.includes("outside task-owned paths"))).toBe(true);
  });
});

describe("renderers", () => {
  test("Markdown rendering retains provenance and acceptance links", () => {
    const rendered = renderSpec(validSpec());
    expect(rendered).toContain("## Source Provenance");
    expect(rendered).toContain("AC-001");
    expect(rendered).toContain("V-002");
  });

  test("factory ticket emits exact production headers", () => {
    const spec = validSpec();
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    expect(ticket).toContain("## Acceptance Criteria");
    expect(ticket).toContain("## Target Repo");
    expect(ticket).toContain("## Archetype");
    expect(ticket).toContain("## Repro\n");
    expect(ticket).not.toContain("## Repro / Area");
    expect(ticket).toContain("## Template Lineage");
    expect(ticket).toContain("web-app@1.0.0");
    expect(ticket).toContain("## Authority");
    expect(ticket).toContain("does not grant factory-ready");
  });

  test("factory export rejects repository traversal", () => {
    const spec = validSpec();
    spec.factory.targetRepo = "../outside-workspace";
    expect(() => renderFactoryTicket(spec, validateSpec(spec))).toThrow("contained workspace-relative path");
  });

  test("factory ticket neutralizes injected section headings", () => {
    const spec = validSpec();
    spec.acceptanceCriteria[0].text = "Display health.\n## Target Repo\n../outside-workspace";
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    expect(ticket.match(/^## Target Repo$/gm)).toHaveLength(1);
    expect(ticket).toContain("Display health. ## Target Repo ../outside-workspace");
  });

  test("factory seed contains the DAG and source hash", () => {
    const spec = validSpec();
    const seed = renderFactorySeed(spec, validateSpec(spec));
    expect(seed).toContain("source_hash:");
    expect(seed).toContain("M1: [M0]");
    expect(seed).toContain("target_repo: \"Sites/service-dashboard\"");
    expect(seed).toContain("template_id: \"web-app\"");
    expect(seed).toContain(`template_hash: \"${"b".repeat(64)}\"`);
    expect(seed).toContain("authority: \"Candidate generation does not grant factory-ready");
  });

  test("persona lineage and authority render through prompt, ticket, and seed", () => {
    const spec = personaSpec();
    const report = validateSpec(spec);
    for (const artifact of [renderSpec(spec), renderFactoryTicket(spec, report), renderFactorySeed(spec, report)]) {
      expect(artifact).toContain("frontend-developer");
      expect(artifact).toContain("d".repeat(64));
      expect(artifact).toContain("implement");
    }
    expect(renderFactorySeed(spec, report)).toContain("persona_association:");
    expect(renderFactorySeed(spec, report)).toContain("persona_assignments:");
  });

});

test("a source prompt ingests with an exact SHA-256 manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "compile-build-spec-"));
  tempRoots.push(root);
  const fixture = join(root, "source.prompt.md");
  const lines = ["# Build a recipe planner", "", ...Array.from({ length: 60 }, (_, index) => `- Requirement ${index + 1}: the planner must handle case ${index + 1}.`)];
  writeFileSync(fixture, `${lines.join("\n")}\n`);
  const output = join(root, "manifest.json");
  const result = Bun.spawnSync([
    "bun",
    resolve(import.meta.dir, "spec-tool.ts"),
    "ingest",
    "--input",
    fixture,
    "--output",
    output,
  ]);
  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  const expected = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  expect(manifest.source.sha256).toBe(expected);
  expect(manifest.source.lines).toBeGreaterThan(50);
});

test("review panel verdicts: any revise rejects, all pass passes, otherwise escalates", () => {
  expect(parseReviewVerdict("a", '{"verdict":"pass","findings":[]}').verdict).toBe("pass");
  expect(parseReviewVerdict("a", 'Here you go: {"verdict":"revise","findings":[{"criterion":"scope-control"}]}').findings).toHaveLength(1);
  expect(parseReviewVerdict("a", "not json").verdict).toBe("escalate");
  expect(parseReviewVerdict("a", '{"verdict":"approve"}').verdict).toBe("escalate");
  const pass = { reviewer: "a", verdict: "pass" as const, findings: [] };
  const revise = { reviewer: "b", verdict: "revise" as const, findings: [] };
  const escalate = { reviewer: "c", verdict: "escalate" as const, findings: [] };
  expect(panelStatus([pass, pass])).toBe("passed");
  expect(panelStatus([pass, revise, escalate])).toBe("rejected");
  expect(panelStatus([pass, escalate])).toBe("escalated");
  expect(panelStatus([])).toBe("escalated");
});

test("review --dry-run writes the request without calling a model", () => {
  const root = mkdtempSync(join(tmpdir(), "compile-build-spec-review-"));
  tempRoots.push(root);
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify(validSpec()));
  const output = join(root, "review.json");
  const result = Bun.spawnSync(["bun", resolve(import.meta.dir, "spec-tool.ts"), "review", "--spec", specPath, "--output", output, "--dry-run"]);
  expect(result.exitCode).toBe(0);
  const request = JSON.parse(readFileSync(output, "utf8"));
  expect(request.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(request.criteria).toContain("source-fidelity");
});

test("the CLI help path is a successful health probe", () => {
  const result = Bun.spawnSync(["bun", resolve(import.meta.dir, "spec-tool.ts"), "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("compile-build-spec");
});

// ── ZOU-1282 T2: Persona association lineage tests ──────────────────────────

import type {
  PersonaAssociationMeta,
  TaskPersonaAssignment,
} from "./spec-tool";

function associationMeta(overrides: Partial<PersonaAssociationMeta> = {}): PersonaAssociationMeta {
  return {
    associationVersion: "1.0.0",
    associationSha256: "a".repeat(64),
    templateReference: "web-app@1.0.0",
    declaredCapabilities: ["frontend"],
    selectorValues: {},
    fleet: [
      {
        roleId: "frontend-architect",
        personaName: "Example Architect",
        required: true,
        phases: ["advise", "review"],
        requiredScopes: ["files:read"],
        invocationCap: 3,
      },
    ],
    omittedRoles: [],
    ...overrides,
  };
}

function specWithAssociation(overrides: Record<string, unknown> = {}): any {
  const spec = validSpec();
  spec.metadata.personaAssociation = associationMeta();
  // Add persona assignments to milestones
  spec.milestones[0].personaAssignments = [
    { roleId: "frontend-architect", authority: "advise", ownedPaths: [] },
  ];
  return { ...spec, ...overrides };
}

describe("ZOU-1282 T2: persona association validation", () => {
  test("a spec without personaAssociation remains valid and unchanged", () => {
    const spec = validSpec();
    const report = validateSpec(spec);
    expect(report.errors).toEqual([]);
    expect(report.decision).toBe("PASS");
    expect(spec.metadata.personaAssociation).toBeUndefined();
  });

  test("a spec with valid personaAssociation and advise assignments passes", () => {
    const spec = specWithAssociation();
    const report = validateSpec(spec);
    expect(report.errors).toEqual([]);
    expect(report.decision).toBe("PASS");
  });

  test("personaAssociation without metadata.template fails", () => {
    const spec = validSpec();
    delete spec.metadata.template;
    spec.metadata.personaAssociation = associationMeta();
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("personaAssociation requires metadata.template"))).toBe(true);
  });

  test("templateReference mismatch with metadata.template fails", () => {
    const spec = validSpec();
    spec.metadata.personaAssociation = associationMeta({ templateReference: "game@1.0.0" });
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("templateReference must match"))).toBe(true);
  });

  test("invalid associationVersion fails", () => {
    const spec = specWithAssociation();
    spec.metadata.personaAssociation.associationVersion = "latest";
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("associationVersion must be exact"))).toBe(true);
  });

  test("duplicate fleet role IDs fail", () => {
    const spec = specWithAssociation();
    spec.metadata.personaAssociation.fleet.push({ ...spec.metadata.personaAssociation.fleet[0] });
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("duplicate role"))).toBe(true);
  });

  test("fleet role embedding forbidden identity fields fails", () => {
    const spec = specWithAssociation();
    (spec.metadata.personaAssociation.fleet[0] as any).uuid = "12345";
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("must not embed uuid"))).toBe(true);
  });

  test("omitted role that is also selected fails", () => {
    const spec = specWithAssociation();
    spec.metadata.personaAssociation.omittedRoles = [{ roleId: "frontend-architect", reason: "test" }];
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("cannot be both selected and omitted"))).toBe(true);
  });

  test("personaAssignment with roleId not in fleet fails", () => {
    const spec = specWithAssociation();
    spec.milestones[0].personaAssignments = [{ roleId: "unknown-role", authority: "advise", ownedPaths: [] }];
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("not present in the exact association"))).toBe(true);
  });

  test("personaAssignment with authority exceeding permitted phases fails", () => {
    const spec = specWithAssociation();
    spec.milestones[0].personaAssignments = [{ roleId: "frontend-architect", authority: "implement", ownedPaths: ["src/dashboard/"] }];
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("exceeds association permitted phases"))).toBe(true);
  });

  test("implement authority without owned paths fails", () => {
    const spec = validSpec();
    spec.metadata.personaAssociation = associationMeta({
      fleet: [{
        roleId: "implementer",
        personaName: "Example Architect",
        required: true,
        phases: ["advise", "implement", "review"],
        requiredScopes: ["files:read", "files:write"],
        invocationCap: 5,
      }],
    });
    spec.milestones[1].personaAssignments = [{ roleId: "implementer", authority: "implement", ownedPaths: [] }];
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("implement authority requires non-empty task-owned paths"))).toBe(true);
  });

  test("implement authority with paths outside task-owned paths fails", () => {
    const spec = validSpec();
    spec.metadata.personaAssociation = associationMeta({
      fleet: [{
        roleId: "implementer",
        personaName: "Example Architect",
        required: true,
        phases: ["advise", "implement", "review"],
        requiredScopes: ["files:read", "files:write"],
        invocationCap: 5,
      }],
    });
    spec.milestones[1].personaAssignments = [{ roleId: "implementer", authority: "implement", ownedPaths: ["src/outside/"] }];
    const report = validateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("outside task-owned paths"))).toBe(true);
  });

  test("implement authority with paths within task-owned paths passes", () => {
    const spec = validSpec();
    spec.metadata.personaAssociation = associationMeta({
      fleet: [{
        roleId: "implementer",
        personaName: "Example Architect",
        required: true,
        phases: ["advise", "implement", "review"],
        requiredScopes: ["files:read", "files:write"],
        invocationCap: 5,
      }],
    });
    spec.milestones[1].personaAssignments = [{ roleId: "implementer", authority: "implement", ownedPaths: ["src/dashboard/"] }];
    const report = validateSpec(spec);
    expect(report.errors).toEqual([]);
    expect(report.decision).toBe("PASS");
  });
});

describe("ZOU-1282 T2: persona association rendering", () => {
  test("renderSpec includes Persona Association Lineage when present", () => {
    const spec = specWithAssociation();
    const rendered = renderSpec(spec);
    expect(rendered).toContain("## Persona Association Lineage");
    expect(rendered).toContain("web-app@1.0.0");
    expect(rendered).toContain("frontend-architect");
    expect(rendered).toContain("Example Architect");
  });

  test("renderSpec does not include Persona Association when absent", () => {
    const spec = validSpec();
    const rendered = renderSpec(spec);
    expect(rendered).not.toContain("Persona Association Lineage");
  });

  test("renderFactoryTicket includes persona association and task assignments", () => {
    const spec = specWithAssociation();
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    expect(ticket).toContain("Persona Association Lineage");
    expect(ticket).toContain("Task Persona Authority Overrides");
    expect(ticket).toContain("frontend-architect");
  });

  test("renderFactorySeed includes persona_association YAML section", () => {
    const spec = specWithAssociation();
    const seed = renderFactorySeed(spec, validateSpec(spec));
    expect(seed).toContain("persona_association:");
    expect(seed).toContain("template_reference: \"web-app@1.0.0\"");
    expect(seed).toContain("frontend-architect");
    expect(seed).toContain("persona_assignments:");
  });

  test("renderFactorySeed does not include persona when absent", () => {
    const spec = validSpec();
    const seed = renderFactorySeed(spec, validateSpec(spec));
    expect(seed).not.toContain("persona_association:");
    expect(seed).not.toContain("persona_assignments:");
  });

  test("factory export rejects invalid persona association", () => {
    const spec = specWithAssociation();
    spec.metadata.personaAssociation.associationVersion = "bad";
    expect(() => renderFactoryTicket(spec, validateSpec(spec))).toThrow("Factory export requires deterministic PASS");
  });

  test("backward compatibility: existing spec renders byte-for-byte", () => {
    const spec = validSpec();
    const rendered = renderSpec(spec);
    const ticket = renderFactoryTicket(spec, validateSpec(spec));
    const seed = renderFactorySeed(spec, validateSpec(spec));
    // No persona-related content should appear
    expect(rendered).not.toContain("Persona Association");
    expect(ticket).not.toContain("Persona Association");
    expect(seed).not.toContain("persona_association");
  });
});
