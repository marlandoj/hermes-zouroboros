import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateConstitution,
  verifyCanonicalDocuments,
  type ConstitutionInput,
} from "./constitution-gate";
import { SHIPPED_GOVERNING_ROOT } from "./governance-paths";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "constitution-gate-"));
  const canonicalRoot = join(root, "zouroboros");
  const mirrorRoot = join(root, "workspace");
  mkdirSync(canonicalRoot);
  mkdirSync(mirrorRoot);
  writeFileSync(join(canonicalRoot, "ZOUROBOROS.md"), "# Zouroboros\n\nA self-evolving AI operating system.\n");
  writeFileSync(
    join(canonicalRoot, "CONSTITUTION.md"),
    Array.from({ length: 10 }, (_, index) => `## Article ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][index]} — Test\n`).join("\n"),
  );
  for (const name of ["ZOUROBOROS.md", "CONSTITUTION.md"]) {
    symlinkSync(join(canonicalRoot, name), join(mirrorRoot, name));
  }
  roots.push(root);
  return { root, canonicalRoot, mirrorRoot };
}

function validInput(): ConstitutionInput {
  return {
    operation: "evolve-routing-policy",
    description: "Replace a local routing rule after evaluation",
    targetFiles: ["packages/selfheal/src/router.ts"],
    modifiesModelWeights: false,
    reversible: true,
    rollbackPlan: "Revert the candidate commit",
    blastRadius: "local",
    humanApproved: false,
    provenance: { rationale: "Lower failure rate", evidence: ["evaluations/report.json"], actor: "selfheal" },
    budgetBounded: true,
    layerIntegrity: true,
    failClosed: true,
  };
}

describe("constitution gate", () => {
  test("accepts canonical documents exposed through symlinks", () => {
    const paths = fixture();
    expect(verifyCanonicalDocuments(paths).ok).toBe(true);
  });

  test("blocks a drifted workspace copy", () => {
    const paths = fixture();
    rmSync(join(paths.mirrorRoot, "CONSTITUTION.md"));
    writeFileSync(join(paths.mirrorRoot, "CONSTITUTION.md"), "drift");
    const result = verifyCanonicalDocuments(paths);
    expect(result.ok).toBe(false);
    expect(result.violations.some((item) => item.code === "X-DOCUMENT-DRIFT")).toBe(true);
  });

  test("allows a complete preflight", () => {
    const paths = fixture();
    expect(evaluateConstitution(validInput(), "preflight", paths).decision).toBe("ALLOW");
  });

  test("blocks weight modification", () => {
    const paths = fixture();
    const input = { ...validInput(), modifiesModelWeights: true };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "I-FROZEN-WEIGHTS")).toBe(true);
  });

  test("blocks unauthorized shared changes", () => {
    const paths = fixture();
    const input = { ...validInput(), blastRadius: "shared" as const };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "V-HUMAN-AUTHORIZATION")).toBe(true);
  });

  test("blocks promotion: the promotion authority is not provisioned in the distribution", () => {
    const paths = fixture();
    const result = evaluateConstitution(validInput(), "promotion", paths);
    expect(result.decision).toBe("BLOCK");
    expect(result.violations.map((item) => item.code)).toEqual(["IX-PROMOTION-AUTHORITY-UNAVAILABLE"]);
  });

  test("does not accept caller-asserted verification flags or the retired model consensus boolean", () => {
    const paths = fixture();
    const input = {
      ...validInput(),
      humanApproved: true,
      verification: { mechanical: true, heldOut: true, consensus: true, regressionFree: true },
    };
    const result = evaluateConstitution(input, "promotion", paths);
    expect(result.decision).toBe("BLOCK");
    expect(result.violations.some((item) => item.code === "IX-PROMOTION-AUTHORITY-UNAVAILABLE")).toBe(true);
  });

  test("verifies the shipped canonical documents without a configured mirror", () => {
    const result = verifyCanonicalDocuments({ canonicalRoot: SHIPPED_GOVERNING_ROOT });
    expect(result.ok).toBe(true);
    expect(result.documents.map((document) => document.mirrorMode)).toEqual(["not-configured", "not-configured"]);
    expect(result.documents.every((document) => document.sha256 !== null)).toBe(true);
  });

  test("blocks a missing configured mirror and a missing canonical document", () => {
    const paths = fixture();
    rmSync(join(paths.mirrorRoot, "ZOUROBOROS.md"));
    rmSync(join(paths.canonicalRoot, "CONSTITUTION.md"));
    const codes = verifyCanonicalDocuments(paths).violations.map((item) => item.code);
    expect(codes).toContain("X-MIRROR-MISSING");
    expect(codes).toContain("X-CANONICAL-MISSING");
  });

  test("blocks a constitution without exactly ten articles", () => {
    const paths = fixture();
    writeFileSync(join(paths.canonicalRoot, "CONSTITUTION.md"), "## Article I — Only\n");
    const result = verifyCanonicalDocuments({ canonicalRoot: paths.canonicalRoot });
    expect(result.violations.some((item) => item.code === "X-ARTICLE-SET")).toBe(true);
  });

  test("fails closed when the governing documents are unavailable", () => {
    const paths = fixture();
    const result = evaluateConstitution(validInput(), "preflight", { canonicalRoot: join(paths.root, "absent") });
    expect(result.decision).toBe("BLOCK");
    expect(existsSync(join(paths.root, "absent"))).toBe(false);
  });

  test("blocks malformed input", () => {
    const paths = fixture();
    expect(evaluateConstitution(null, "preflight", paths).violations.some((item) => item.code === "IX-INVALID-INPUT")).toBe(true);
  });

  test("blocks an unauthorized constitutional amendment", () => {
    const paths = fixture();
    const input = { ...validInput(), targetFiles: ["CONSTITUTION.md"] };
    const result = evaluateConstitution(input, "preflight", paths);
    expect(result.violations.some((item) => item.code === "X-AMENDMENT-AUTHORIZATION")).toBe(true);
  });
});
