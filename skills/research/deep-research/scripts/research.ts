#!/usr/bin/env bun
// deep-research — mechanical, resumable, fail-loud research DAG:
//   plan -> gather (literature + web + internal memory, parallel) -> fuse -> synthesize -> claim-check -> report -> persist
//
// hermes-zouroboros: every model call goes through ask-governor, i.e. the profile's executor registry
// (default hermes-vps, a one-shot Hermes Agent). Gather calls rely on the tools enabled in that Hermes
// profile (web search; a literature MCP such as Consensus if the operator configured one) and return
// JSON in the final response, so no file sentinel or endpoint token is needed. Internal knowledge
// comes from the profile's memory database through the zo-memory-system skill.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { governedAsk } from "../../../zouroboros/ask-governor/scripts/client.ts";
import { settings } from "../../../../integration/profile.ts";

const ZMEM = new URL("../../../zouroboros/zo-memory-system/scripts/zmem.ts", import.meta.url).pathname;

// ---------- args ----------
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--run-dir", "--max-papers", "--max-web", "--max-internal", "--model"]);
const query = argv.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function bool(name: string): boolean { return argv.includes(`--${name}`); }
if (!query) {
  console.error('usage: research.ts "<research question>" [--no-external] [--no-internal] [--no-persist] [--force] [--run-dir DIR] [--max-papers N] [--max-web N] [--model ID]');
  process.exit(2);
}
const DO_EXTERNAL = !bool("no-external");
const DO_INTERNAL = !bool("no-internal");
const DO_PERSIST = !bool("no-persist");
const FORCE = bool("force");
const MAX_PAPERS = parseInt(flag("max-papers") || "6", 10);
const MAX_WEB = parseInt(flag("max-web") || "6", 10);
const MAX_INTERNAL = parseInt(flag("max-internal") || "5", 10);
/** Empty: the Hermes profile's configured model. */
const MODEL = flag("model") || process.env.DEEP_RESEARCH_MODEL || "";

const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "research";
const dateStr = new Date().toISOString().slice(0, 10);
const RUN_DIR = flag("run-dir") || join(settings().workspace, "reports", "deep-research", `${slug}-${dateStr}`);
mkdirSync(RUN_DIR, { recursive: true });

function artPath(name: string): string { return join(RUN_DIR, name); }
function hasArt(name: string): boolean { return !FORCE && existsSync(artPath(name)); }
function readArt<T>(name: string): T { return JSON.parse(readFileSync(artPath(name), "utf8")) as T; }
function writeArt(name: string, data: unknown) {
  writeFileSync(artPath(name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
function fail(stage: string, msg: string): never {
  console.error(`\n[deep-research] FAILED at stage "${stage}": ${msg}\nPartial artifacts kept in ${RUN_DIR}`);
  process.exit(1);
}
function log(s: string) { console.log(`[deep-research] ${s}`); }

// ---------- model calls (governed) ----------
type Lane = "reason" | "gather";
async function llm(prompt: string, lane: Lane = "reason"): Promise<string> {
  const result = await governedAsk(
    { input: prompt, model: MODEL || undefined },
    lane === "gather"
      ? { caller: "deep-research", priority: 4, timeoutMs: 600_000, queueTimeoutMs: 600_000, maxAttempts: 2,
          budgetKey: "deep-research-external-gather", budgetLimit: 24, dedupeKey: createHash("sha256").update(prompt).digest("hex") }
      : { caller: "deep-research", priority: 5, timeoutMs: 600_000, queueTimeoutMs: 600_000, maxAttempts: 3,
          budgetKey: "deep-research-reasoning", budgetLimit: 40 },
  );
  return result.output;
}

function extractJson(s: string): any {
  let t = s.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1]!.trim();
  try { return JSON.parse(t); } catch {}
  const firstArr = t.indexOf("["), firstObj = t.indexOf("{");
  const start = firstArr >= 0 && (firstObj < 0 || firstArr < firstObj) ? firstArr : firstObj;
  if (start < 0) return null;
  const open = t[start], close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close && --depth === 0) {
      try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// Ask the agent to research with its own tools and return JSON in the final response.
async function gatherJson(task: string): Promise<any> {
  const out = await llm(
    `${task}\n\nOUTPUT PROTOCOL (follow exactly):\n` +
    `- Use the research tools available to you in this session; do not invent sources or URLs.\n` +
    `- Reply with ONLY the JSON result, no prose. If nothing is found, reply [].`,
    "gather",
  );
  return extractJson(out);
}

// ---------- types ----------
interface Plan { query: string; subQuestions: string[]; domain: string }
interface Source { id: string; type: "literature" | "web" | "internal"; title: string; url: string; text: string; score: number; subQ: string }

// ================= STAGE: plan =================
async function stagePlan(): Promise<Plan> {
  if (hasArt("00-plan.json")) { log("plan: cached"); return readArt<Plan>("00-plan.json"); }
  log("plan: decomposing query");
  const out = await llm(
    `You are a research planner. Output only valid JSON.\n` +
    `Decompose this research question into 3-5 focused sub-questions that together give comprehensive coverage. ` +
    `Also classify the domain. Return JSON: {"subQuestions": ["..."], "domain": "scientific|technical|general"}.\n\nQuestion: ${query}`,
  );
  const parsed = extractJson(out);
  if (!parsed?.subQuestions?.length) fail("plan", "model did not return sub-questions");
  const plan: Plan = { query: query!, subQuestions: parsed.subQuestions.slice(0, 5).map(String), domain: parsed.domain || "general" };
  writeArt("00-plan.json", plan);
  log(`plan: ${plan.subQuestions.length} sub-questions, domain=${plan.domain}`);
  return plan;
}

// ================= STAGE: gather =================
async function gatherLiterature(subQ: string): Promise<Source[]> {
  const arr = await gatherJson(
    `Find up to ${MAX_PAPERS} peer-reviewed papers on this question, using an academic literature search tool ` +
    `(for example a Consensus or Semantic Scholar MCP) if one is available, else web search restricted to scholarly sources:\n"${subQ}"\n` +
    `The result must be a JSON array of objects: {"title","authors","year","url","abstract","citations"}. ` +
    `Use the exact paper URLs returned by the tool.`,
  );
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_PAPERS).map((p: any, i: number) => ({
    id: "", type: "literature" as const,
    title: String(p.title || "Untitled").slice(0, 300),
    url: String(p.url || ""),
    text: `${p.abstract || ""}`.slice(0, 1500) + (p.authors ? ` (${p.authors}, ${p.year || "n.d."}${p.citations ? `, ${p.citations} citations` : ""})` : ""),
    score: 1 - i * 0.05, subQ,
  }));
}

async function gatherWeb(subQ: string): Promise<Source[]> {
  const arr = await gatherJson(
    `Use web search to investigate this question and return up to ${MAX_WEB} high-quality, non-academic web sources:\n"${subQ}"\n` +
    `The result must be a JSON array of objects: {"title","url","snippet"}.`,
  );
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_WEB).map((p: any, i: number) => ({
    id: "", type: "web" as const,
    title: String(p.title || "Untitled").slice(0, 300),
    url: String(p.url || ""),
    text: `${p.snippet || ""}`.slice(0, 1000),
    score: 0.9 - i * 0.05, subQ,
  }));
}

// Internal knowledge: the profile's memory database (facts), via the zo-memory-system skill. Memory search
// is a substring match, so each sub-question is reduced to its distinctive keywords and facts are ranked
// by how many keywords they match. The question's own keywords are always searched too: planner
// sub-questions are verbose, and their longest words can crowd out the subject itself.
const STOPWORDS = new Set(["about", "after", "against", "among", "between", "could", "does", "from", "have", "into", "should", "their", "there", "these", "they", "this", "what", "when", "where", "which", "while", "with", "would", "your"]);
export function keywords(text: string, max = 4): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [];
  const unique = [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

function gatherInternal(plan: Plan): Source[] {
  if (!existsSync(ZMEM)) { log("internal: zo-memory-system skill not found — skipping"); return []; }
  const sources: Source[] = [];
  for (const subQ of plan.subQuestions) {
    const hits = new Map<string, { fact: { id: string; entity: string; key?: string; value: string }; count: number }>();
    for (const word of new Set([...keywords(plan.query), ...keywords(subQ)])) {
      const res = spawnSync(process.execPath, [ZMEM, "search", word, "--limit", String(MAX_INTERNAL * 2)], { encoding: "utf8", timeout: 60_000 });
      if (res.status !== 0) { log(`internal: memory search failed (soft) for "${word}"`); continue; }
      let facts: { id: string; entity: string; key?: string; value: string }[] = [];
      try { facts = JSON.parse(res.stdout); } catch { continue; }
      for (const fact of facts) hits.set(fact.id, { fact, count: (hits.get(fact.id)?.count ?? 0) + 1 });
    }
    [...hits.values()].sort((a, b) => b.count - a.count).slice(0, MAX_INTERNAL).forEach(({ fact: f }, i) => sources.push({
      id: "", type: "internal", title: `${f.entity}${f.key ? `.${f.key}` : ""}`, url: `memory:${f.id}`,
      text: String(f.value).slice(0, 1200), score: 0.8 - i * 0.05, subQ,
    }));
  }
  return sources;
}

async function stageGather(plan: Plan): Promise<Source[]> {
  if (hasArt("01-gather.json")) { log("gather: cached"); return readArt<{ sources: Source[] }>("01-gather.json").sources; }
  log(`gather: external=${DO_EXTERNAL} internal=${DO_INTERNAL}`);
  const tasks: Promise<Source[]>[] = [];
  if (DO_EXTERNAL) {
    plan.subQuestions.forEach((sq) => {
      tasks.push(gatherLiterature(sq).catch((e) => { log(`literature gather failed for "${sq.slice(0, 40)}": ${e}`); return []; }));
      tasks.push(gatherWeb(sq).catch((e) => { log(`web gather failed for "${sq.slice(0, 40)}": ${e}`); return []; }));
    });
  }
  if (DO_INTERNAL) tasks.push(Promise.resolve().then(() => gatherInternal(plan)).catch((e) => { log(`internal gather failed: ${e}`); return []; }));

  const results = await Promise.all(tasks);
  let sources = results.flat();

  // dedupe by normalized url|title
  const seen = new Set<string>();
  sources = sources.filter((s) => {
    const k = (s.url || s.title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  if (sources.length === 0) fail("gather", "no sources from any channel (literature/web/internal all empty)");

  sources.forEach((s, i) => (s.id = `S${i + 1}`));
  const byType = sources.reduce((a: Record<string, number>, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
  log(`gather: ${sources.length} sources (${JSON.stringify(byType)})`);
  writeArt("01-gather.json", { sources });
  return sources;
}

// ================= STAGE: fuse =================
function stageFuse(sources: Source[], plan: Plan): Source[] {
  if (hasArt("02-fused.json")) { log("fuse: cached"); return readArt<{ sources: Source[] }>("02-fused.json").sources; }
  // rank within each subQ by score; keep order stable, preserve ids assigned at gather
  const fused = [...sources].sort((a, b) => {
    if (a.subQ !== b.subQ) return plan.subQuestions.indexOf(a.subQ) - plan.subQuestions.indexOf(b.subQ);
    return b.score - a.score;
  });
  writeArt("02-fused.json", { sources: fused });
  log(`fuse: ${fused.length} ranked sources`);
  return fused;
}

// ================= STAGE: synthesize =================
async function stageSynthesize(sources: Source[], plan: Plan): Promise<{ md: string; claims: { text: string; sourceIds: string[] }[] }> {
  if (hasArt("03-synthesis.md") && hasArt("03-claims.json")) {
    log("synthesize: cached");
    return { md: readFileSync(artPath("03-synthesis.md"), "utf8"), claims: readArt("03-claims.json") };
  }
  log("synthesize: generating analytical synthesis");
  const srcBlock = sources.map((s) => `[${s.id}] (${s.type}) ${s.title}\n${s.text}`).join("\n\n");
  const subqList = plan.subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const prompt =
    `You are a rigorous research analyst. Cite sources with [S#] markers. Do not use tools; work only from the sources below.\n\n` +
    `Research question: ${plan.query}\n\nSub-questions:\n${subqList}\n\nSOURCES:\n${srcBlock}\n\n` +
    `Write a neutral, analytical research synthesis in Markdown. Structure:\n` +
    `## Executive Summary (3-5 bullets)\n## Findings (one ### subsection per sub-question)\n## Gaps & Open Questions\n\n` +
    `Rules:\n- Cite every non-trivial claim inline with [S#] markers matching the source ids above.\n` +
    `- Only cite ids that exist. Never invent sources or ids.\n- Where sources conflict, say so.\n` +
    `- Analytical tone, no fluff, no first person.\n- Reply with the Markdown only.`;
  const md = await llm(prompt);
  if (!md.trim()) fail("synthesize", "empty synthesis from model");

  // extract claims: any sentence/line carrying [S#] markers
  const validIds = new Set(sources.map((s) => s.id));
  const claims: { text: string; sourceIds: string[] }[] = [];
  for (const line of md.split("\n")) {
    const ids = [...line.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`).filter((id) => validIds.has(id));
    if (ids.length) claims.push({ text: line.replace(/^[-*#\s]+/, "").trim(), sourceIds: [...new Set(ids)] });
  }
  writeArt("03-synthesis.md", md);
  writeArt("03-claims.json", claims);
  log(`synthesize: ${claims.length} cited claims`);
  return { md, claims };
}

// ================= STAGE: claim-check (best-effort) =================
async function stageClaimCheck(claims: { text: string; sourceIds: string[] }[], plan: Plan): Promise<any> {
  if (hasArt("04-validated.json")) { log("claim-check: cached"); return readArt("04-validated.json"); }
  if (!DO_EXTERNAL || plan.domain === "general") {
    const skip = { checked: false, reason: DO_EXTERNAL ? "non-scientific domain" : "external disabled", results: [] };
    writeArt("04-validated.json", skip); log("claim-check: skipped"); return skip;
  }
  log("claim-check: verifying top claims against literature (best-effort)");
  const results: any[] = [];
  for (const c of claims.slice(0, 3)) {
    try {
      const j = await gatherJson(
        `Using an academic literature search tool if available, else web research, ` +
        `assess whether peer-reviewed evidence supports this claim:\n"${c.text}"\n` +
        `The result must be a JSON object: {"verdict":"supported|mixed|unsupported|insufficient","note":"one sentence"}.`,
      );
      results.push({ claim: c.text, verdict: j?.verdict || "insufficient", note: j?.note || "no parseable response" });
    } catch (e) { results.push({ claim: c.text, verdict: "insufficient", note: `check failed: ${e}` }); }
  }
  const out = { checked: true, results };
  writeArt("04-validated.json", out);
  log(`claim-check: ${results.length} claims checked`);
  return out;
}

// ================= STAGE: report =================
function stageReport(plan: Plan, sources: Source[], synthMd: string, validation: any): string {
  const lines: string[] = [];
  lines.push(`# Deep Research: ${plan.query}`, "");
  lines.push(`*Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · domain: ${plan.domain} · ${sources.length} sources*`, "");
  lines.push(synthMd.trim(), "");

  if (validation?.checked && validation.results?.length) {
    lines.push("## Claim Validation", "");
    lines.push("Best-effort literature check on key claims:", "");
    for (const r of validation.results) lines.push(`- **${r.verdict}** — ${r.claim}\n  - ${r.note}`);
    lines.push("");
  }

  lines.push("## Sources", "");
  const grouped: Record<string, Source[]> = { literature: [], web: [], internal: [] };
  for (const s of sources) (grouped[s.type] ||= []).push(s);
  const labels: Record<string, string> = { literature: "Peer-reviewed literature", web: "Web", internal: "Internal memory (profile)" };
  for (const type of ["literature", "web", "internal"]) {
    if (!grouped[type]?.length) continue;
    lines.push(`### ${labels[type]}`, "");
    for (const s of grouped[type]!) {
      const link = s.url.startsWith("http") ? `[${s.title}](${s.url})` : `${s.title}`;
      lines.push(`- **[${s.id}]** ${link}`);
    }
    lines.push("");
  }
  lines.push("---", `*Pipeline: deep-research (hermes-zouroboros) · run dir \`${RUN_DIR}\`*`);
  const report = lines.join("\n");
  writeArt("report.md", report);
  log(`report: written (${report.length} chars)`);
  return report;
}

// ================= STAGE: persist (soft-fail) =================
function stagePersist(plan: Plan, sources: Source[]) {
  if (!DO_PERSIST) { log("persist: disabled"); return; }
  if (!existsSync(ZMEM)) { log("persist: zo-memory-system skill not found — skipping (soft)"); return; }
  const val = `Deep research run on "${plan.query}" (${plan.domain}): ${sources.length} sources across ${plan.subQuestions.length} sub-questions. Report: ${artPath("report.md")}`;
  const res = spawnSync(process.execPath, [ZMEM, "store", "--entity", "deep-research", "--key", slug, "--value", val, "--decay", "long", "--category", "project"], { encoding: "utf8", timeout: 60_000 });
  if (res.status === 0) log("persist: run stored to profile memory");
  else log(`persist: memory store non-zero (soft) — ${(res.stderr || "").slice(0, 120)}`);
}

// ================= MAIN =================
(async () => {
  log(`query: "${query}"`);
  log(`run dir: ${RUN_DIR}`);
  const plan = await stagePlan();
  const gathered = await stageGather(plan);
  const fused = stageFuse(gathered, plan);
  const { md, claims } = await stageSynthesize(fused, plan);

  // every [S#] marker resolves to a known source id
  const valid = new Set(fused.map((s) => s.id));
  const orphans = [...new Set([...md.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`))].filter((id) => !valid.has(id));
  if (orphans.length) log(`WARN: orphan citations not in bibliography: ${orphans.join(", ")}`);

  const validation = await stageClaimCheck(claims, plan);
  stageReport(plan, fused, md, validation);
  stagePersist(plan, fused);

  console.log(`\n${"=".repeat(60)}\n[deep-research] COMPLETE\nReport: ${artPath("report.md")}\nSources: ${fused.length} | Cited claims: ${claims.length} | Orphans: ${orphans.length}\n${"=".repeat(60)}`);
})().catch((e) => fail("main", String(e?.message || e)));
