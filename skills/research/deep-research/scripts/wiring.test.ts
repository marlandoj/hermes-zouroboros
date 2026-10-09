import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const conductor = readFileSync(new URL("./research.ts", import.meta.url), "utf8");

describe("deep-research model governance", () => {
  test("routes every model call through the shared ask governor", () => {
    expect(conductor).toContain('import { governedAsk } from "../../../zouroboros/ask-governor/scripts/client.ts"');
    expect(conductor).toContain('budgetKey: "deep-research-external-gather"');
    expect(conductor).toContain("budgetLimit: 24");
  });

  test("calls no provider or platform endpoint directly", () => {
    expect(conductor).not.toMatch(/fetch\(/);
    expect(conductor).not.toMatch(/zo\.computer|api\.openai\.com|ZO_[A-Z_]*TOKEN|ZO_API_KEY|OPENAI_API_KEY/);
  });
});
