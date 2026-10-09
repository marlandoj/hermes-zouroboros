#!/usr/bin/env bun

import { resolve } from "path";
import { $ } from "bun";

const scriptFlag = process.argv.indexOf("--script");
const customScript = scriptFlag !== -1 ? process.argv[scriptFlag + 1] : null;
const SCRIPT_PATH = customScript 
  ? resolve(import.meta.dir, "..", customScript)
  : resolve(import.meta.dir, "persona-tier-resolve.ts");
// Optional results file; the skill tree is never written.
const outFlag = process.argv.indexOf("--out");
const RESULTS_FILE = outFlag !== -1 ? resolve(process.argv[outFlag + 1] ?? "") : null;

// Synthetic, generic prompts (reviewed); no routing telemetry or operator tasks.
const TEST_SUITE = resolve(import.meta.dir, "..", "assets", "test-suite.json");
const MIN_TIER_ACCURACY = 84;
const MIN_TYPE_ACCURACY = 68;

interface TestCase {
  id: number;
  task: string;
  expectedTier: string;
  expectedType: string;
  rationale: string;
}

interface TestResult {
  id: number;
  task: string;
  expectedTier: string;
  actualTier: string;
  expectedType: string;
  actualType: string;
  match: boolean;
  typeMatch: boolean;
  performanceMs: number;
}

async function runTests() {
  const testFile = Bun.file(TEST_SUITE);
  const tests = await testFile.json() as TestCase[];
  
  console.log(`Running ${tests.length} test cases...\n`);
  
  const results: TestResult[] = [];
  let correct = 0;
  let typeCorrect = 0;
  
  for (const test of tests) {
    const startTime = Bun.nanoseconds();
    
    try {
      const output = await $`bun ${SCRIPT_PATH} --json --no-feedback ${test.task}`.quiet().text();
      const parsed = JSON.parse(output);
      const actualTier = parsed.complexity?.tier ?? parsed.tier;
      const actualType = parsed.complexity?.inferredTaskType ?? parsed.inferredTaskType;
      if (!actualTier || !actualType) throw new Error("Resolver output is missing tier or task type");
      
      const elapsedMs = (Bun.nanoseconds() - startTime) / 1_000_000;
      
      const match = actualTier === test.expectedTier;
      const typeMatch = actualType === test.expectedType;
      
      if (match) correct++;
      if (typeMatch) typeCorrect++;
      
      results.push({
        id: test.id,
        task: test.task,
        expectedTier: test.expectedTier,
        actualTier,
        expectedType: test.expectedType,
        actualType,
        match,
        typeMatch,
        performanceMs: elapsedMs,
      });
      
      const status = match ? "✓" : "✗";
      const typeStatus = typeMatch ? "✓" : "✗";
      console.log(`[${test.id}] ${status} Tier: ${actualTier} (expected ${test.expectedTier}) | ${typeStatus} Type: ${actualType}`);
      
    } catch (err: any) {
      console.error(`[${test.id}] ERROR: ${err.message}`);
      results.push({
        id: test.id,
        task: test.task,
        expectedTier: test.expectedTier,
        actualTier: "ERROR",
        expectedType: test.expectedType,
        actualType: "ERROR",
        match: false,
        typeMatch: false,
        performanceMs: 0,
      });
    }
  }
  
  const tierAccuracy = (correct / tests.length) * 100;
  const typeAccuracy = (typeCorrect / tests.length) * 100;
  const avgPerformance = results.reduce((sum, r) => sum + r.performanceMs, 0) / results.length;
  const maxPerformance = Math.max(...results.map(r => r.performanceMs));
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Tier Accuracy: ${tierAccuracy.toFixed(1)}% (${correct}/${tests.length})`);
  console.log(`Type Accuracy: ${typeAccuracy.toFixed(1)}% (${typeCorrect}/${tests.length})`);
  console.log(`Performance: avg ${avgPerformance.toFixed(1)}ms, max ${maxPerformance.toFixed(1)}ms`);
  console.log(`${"=".repeat(60)}\n`);
  
  // Confusion matrix for tiers
  const tiers = ["trivial", "simple", "moderate", "complex", "apex"];
  const matrix: Record<string, Record<string, number>> = {};
  for (const t1 of tiers) {
    matrix[t1] = {};
    for (const t2 of tiers) {
      matrix[t1][t2] = 0;
    }
  }
  
  for (const result of results) {
    if (result.actualTier !== "ERROR") {
      matrix[result.expectedTier][result.actualTier]++;
    }
  }
  
  console.log("Confusion Matrix (rows=expected, cols=actual):");
  console.log(`           ${tiers.map((tier) => tier.padEnd(10)).join(" ")}`);
  for (const expected of tiers) {
    const row = tiers.map(actual => matrix[expected][actual].toString().padEnd(10)).join(" ");
    console.log(`${expected.padEnd(10)} ${row}`);
  }
  
  // Save results
  if (RESULTS_FILE) await Bun.write(RESULTS_FILE, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      totalTests: tests.length,
      tierCorrect: correct,
      tierAccuracy,
      typeCorrect,
      typeAccuracy,
      minimumTierAccuracy: MIN_TIER_ACCURACY,
      minimumTypeAccuracy: MIN_TYPE_ACCURACY,
      avgPerformanceMs: avgPerformance,
      maxPerformanceMs: maxPerformance,
    },
    confusionMatrix: matrix,
    results,
  }, null, 2));
  
  if (RESULTS_FILE) console.log(`\nResults saved to: ${RESULTS_FILE}`);
  
  if (tierAccuracy < MIN_TIER_ACCURACY || typeAccuracy < MIN_TYPE_ACCURACY) {
    if (tierAccuracy < MIN_TIER_ACCURACY) {
      console.error(`\nTier accuracy below ${MIN_TIER_ACCURACY}% regression floor`);
    }
    if (typeAccuracy < MIN_TYPE_ACCURACY) {
      console.error(`\nTask-type accuracy below ${MIN_TYPE_ACCURACY}% regression floor`);
    }
    process.exit(1);
  }
  
  console.log(`\n✓ All checks passed`);
}

runTests();
