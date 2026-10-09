#!/usr/bin/env bun
// ponytail-review — single-axis complexity review (Zouroboros DoD COMPLEXITY phase).
//
// Reviews ONE file (or a diff) for over-engineering only. One model call, single
// axis. Advisory: it lists what to cut, it never gates anything.
//
// hermes-zouroboros: the model call goes through ask-governor (the profile's executor
// registry, default hermes-vps), so the provider and credentials come from the Hermes profile.
//
//   bun ponytail-review.ts --file <path> [--json] [--model <m>]
//   bun ponytail-review.ts --diff <patch-file> [--json]
//   git diff | bun ponytail-review.ts --stdin --json
//
// JSON shape: { file, model, api, findings: [{loc, tag, what, replacement}], net_lines }

import { governedAsk } from "../../../zouroboros/ask-governor/scripts/client.ts";

/** Empty: the Hermes profile's configured model. */
const DEFAULT_MODEL = process.env.PONYTAIL_REVIEW_MODEL ?? "";
const VALID_TAGS = ["delete", "stdlib", "native", "yagni", "shrink"] as const;

type Tag = (typeof VALID_TAGS)[number];
interface Finding {
  loc: string;
  tag: Tag | string;
  what: string;
  replacement: string;
}
interface Review {
  file: string;
  model: string;
  api: "hermes" | "none";
  findings: Finding[];
  net_lines: number;
  note?: string; // set on an empty response or a model/parse error, so callers report accurately
}

function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") a.json = true;
    else if (t === "--stdin") a.stdin = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--file") a.file = argv[++i];
    else if (t === "--diff") a.diff = argv[++i];
    else if (t === "--model") a.model = argv[++i];
  }
  return a;
}

const HELP = `ponytail-review — single-axis complexity review (over-engineering only)

Usage:
  bun ponytail-review.ts --file <path> [--json] [--model <model>]
  bun ponytail-review.ts --diff <patch-file> [--json]
  git diff | bun ponytail-review.ts --stdin [--json]

Finds what to delete: reinvented stdlib, unneeded deps, speculative abstractions,
dead flexibility. One line per finding. Correctness/security/perf are out of scope
(they go to a normal review pass). Advisory only — never gates.

Tags: delete | stdlib | native | yagni | shrink
Model: the Hermes profile's model unless --model or PONYTAIL_REVIEW_MODEL is set.`;

function buildPrompt(label: string, content: string): string {
  return `You are a "lazy senior dev" reviewing code for ONE thing only: over-engineering.
Find what to delete, simplify, or replace with a stdlib/native equivalent. You are
SILENT on correctness bugs, security holes, and performance — those go to a different
pass. Do not invent findings; if the code is already lean, return an empty list.

Tags (pick exactly one per finding):
- delete: dead code, unused flexibility, speculative feature. replacement: "nothing".
- stdlib: hand-rolled thing the standard library ships. Name the function.
- native: dependency or code doing what the platform already does. Name the feature.
- yagni: abstraction with one implementation, config nobody sets, layer with one caller.
- shrink: same logic, fewer lines. Show the shorter form.

A single smoke test or assert-based self-check is the minimum, not bloat — never flag it.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "findings": [
    {"loc": "L12-38", "tag": "stdlib", "what": "27-line email validator class", "replacement": "\\"@\\" in email check, 1 line"}
  ],
  "net_lines": 26
}
"loc" is a line or line range like "L12" or "L12-38". "net_lines" is your best estimate
of total lines removable if every finding is applied (a positive integer; 0 if none).

=== ${label} ===
${content}`;
}

function extractJson(output: string): any {
  let s = output.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function callModel(
  prompt: string,
  model: string,
): Promise<{ output: string; api: Review["api"] }> {
  // Advisory and single-shot: one attempt, bounded, through the governed Hermes ask layer.
  const result = await governedAsk(
    { input: prompt, model: model || undefined },
    { caller: "ponytail-review", budgetKey: "ponytail-review", budgetLimit: 200, maxAttempts: 1, timeoutMs: 300_000 },
  );
  return { output: result.output.trim(), api: "hermes" };
}

function normalize(raw: any, file: string, model: string, api: Review["api"]): Review {
  const findings: Finding[] = Array.isArray(raw?.findings)
    ? raw.findings
        .map((f: any) => ({
          loc: String(f?.loc ?? f?.line ?? "?"),
          tag: String(f?.tag ?? "shrink"),
          what: String(f?.what ?? "").trim(),
          replacement: String(f?.replacement ?? "").trim(),
        }))
        .filter((f: Finding) => f.what.length > 0)
    : [];
  let net = Number(raw?.net_lines);
  if (!Number.isFinite(net) || net < 0) net = 0;
  return { file, model, api, findings, net_lines: Math.round(net) };
}

function renderText(r: Review): string {
  if (r.api === "none" && r.note) {
    return `⚠️ ponytail-review: ${r.note}. Skipped.`;
  }
  const lines: string[] = [];
  lines.push(`ponytail-review · ${r.file} · ${r.model} (${r.api})`);
  if (r.findings.length === 0) {
    lines.push("Lean already. Ship.");
    return lines.join("\n");
  }
  for (const f of r.findings) {
    lines.push(`${f.loc}: ${f.tag}: ${f.what}. ${f.replacement || "nothing"}.`);
  }
  lines.push(`net: -${r.net_lines} lines possible.`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const model = (args.model as string) || DEFAULT_MODEL;
  let label = "";
  let content = "";
  let fileLabel = "";

  if (args.stdin) {
    content = await Bun.stdin.text();
    label = "DIFF (stdin)";
    fileLabel = "(stdin)";
  } else if (args.diff) {
    content = await Bun.file(args.diff as string).text();
    label = `DIFF ${args.diff}`;
    fileLabel = args.diff as string;
  } else if (args.file) {
    content = await Bun.file(args.file as string).text();
    label = `FILE ${args.file}`;
    fileLabel = args.file as string;
  } else {
    console.error("error: one of --file, --diff, or --stdin is required (--help for usage)");
    process.exit(2);
  }

  if (!content.trim()) {
    const empty: Review = { file: fileLabel, model, api: "none", findings: [], net_lines: 0 };
    console.log(args.json ? JSON.stringify(empty) : renderText(empty));
    return;
  }

  const prompt = buildPrompt(label, content);
  let review: Review;
  try {
    const { output, api } = await callModel(prompt, model);
    if (!output) {
      review = {
        file: fileLabel, model, api, findings: [], net_lines: 0,
        note: "empty response from provider",
      };
    } else {
      review = normalize(extractJson(output), fileLabel, model, api);
    }
  } catch (err: any) {
    // Advisory phase: a failed review must never break the caller. Report empty
    // with the real cause (model call or parse error).
    console.error(`ponytail-review: ${err.message}`);
    review = {
      file: fileLabel, model, api: "none", findings: [], net_lines: 0,
      note: `review error: ${err.message}`,
    };
  }

  console.log(args.json ? JSON.stringify(review) : renderText(review));
}

main();
