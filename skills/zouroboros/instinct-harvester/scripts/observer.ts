// ZOU-451 instinct-harvester — observer CLI: the write/read surface for the
// behavioral pattern store at .zo/instincts/instincts.yaml.
//
// The "observer agent" role is played by the session agent itself: the
// extract-patterns Stop gate (ZOU-452) prompts it at session stop to review
// the conversation against the four qualifying criteria and, when a pattern
// qualifies, call `add` here. This keeps hook-path code deterministic (no LLM
// call, no API key dependency) while the entity with the richest view of the
// session — the agent — does the pattern judgment.
//
// Commands:
//   add   --trigger T --action A --domain D [--confidence 0.7] [--source session-observation]
//   brief [--top 5] [--context "prompt text"]     → session-briefing block (memory gate)
//   list  [--domain D]
//   stats
//   reinforce --id inst_NNN [--last-seen YYYY-MM-DD]  → daily-synthesis reinforcement
//   remove --id inst_NNN --reason R | --domain D --reason R   → sanctioned delete + tombstone
//   verify                                              → resurrection guard (tombstone vs live)

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "./yaml-compat";
import { defaultStorePath } from "./paths";
import { mergeCandidate, validateCandidate, type Instinct } from "./merge";
import { rankInstincts, INSTINCT_CAP } from "./prune";
import { findSupersessionCandidates } from "./supersede";
import { admitCandidate, planLifecycle, DEFAULT_LIFECYCLE, type LifecycleInstinct } from "./lifecycle";

export interface InstinctStore {
  instincts: Instinct[];
}

export const STORE_PATH =
  process.env.INSTINCT_STORE_PATH ?? defaultStorePath();

export function loadStore(path: string = STORE_PATH): InstinctStore {
  if (!existsSync(path)) return { instincts: [] };
  try {
    const raw = yamlLoad(readFileSync(path, "utf8"));
    const instincts = (raw as InstinctStore | null)?.instincts;
    return { instincts: Array.isArray(instincts) ? instincts : [] };
  } catch {
    // Fail-safe: unreadable store reads as empty — but snapshot it first so a
    // subsequent save can never silently clobber a corrupt-but-recoverable file.
    try {
      copyFileSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {}
    return { instincts: [] };
  }
}

export function saveStore(store: InstinctStore, path: string = STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlDump({ instincts: store.instincts }, { lineWidth: 100 }));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Domain-aware selection: domains mentioned in the context text rank first,
// then overall confidence order. Deterministic, no LLM.
export function selectForBriefing(
  instincts: Instinct[],
  top: number,
  context: string = "",
): Instinct[] {
  const ranked = rankInstincts(instincts);
  if (!context) return ranked.slice(0, top);
  const ctx = context.toLowerCase();
  const hit = (i: Instinct) => (ctx.includes(i.domain.toLowerCase()) ? 0 : 1);
  return [...ranked].sort((a, b) => hit(a) - hit(b)).slice(0, top);
}

export function renderBriefing(selected: Instinct[]): string {
  if (selected.length === 0) return "";
  const lines = selected.map(
    (i) => `- [${i.domain} ×${i.reinforced_count} @${i.confidence.toFixed(2)}] ${i.trigger} → ${i.action}`,
  );
  return `[Session Briefing — Instincts]\n${lines.join("\n")}`;
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// ── Tombstones ──────────────────────────────────────────────────────────────────
// A delete that leaves no durable record cannot be proven, so it is not a delete —
// it is a hope. Every sanctioned removal writes an append-only tombstone here, and
// `verify` re-checks the live store against it. That turns "a row came back" from
// an unexplained mystery into a single loud, diffable failure.
export const TOMBSTONE_PATH =
  process.env.INSTINCT_TOMBSTONE_PATH ??
  STORE_PATH.replace(/instincts\.yaml$/, "tombstones.jsonl");

export interface Tombstone {
  id: string;
  domain?: string;
  reason: string;
  removed_at: string;
  removed_by: "observer.ts remove";
  store_md5_before: string;
}

export function appendTombstones(
  entries: Tombstone[],
  path: string = TOMBSTONE_PATH,
): void {
  if (entries.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export function readTombstones(path: string = TOMBSTONE_PATH): Tombstone[] {
  if (!existsSync(path)) return [];
  const out: Tombstone[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as Tombstone;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // A torn final line is expected after an interrupted append; skip it.
    }
  }
  return out;
}

export function findResurrections(
  store: InstinctStore,
  tombstones: Tombstone[] = readTombstones(),
): Tombstone[] {
  const live = new Map(store.instincts.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: Tombstone[] = [];
  for (const t of tombstones) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const row = live.get(t.id);
    if (row) out.push({ ...t, domain: t.domain ?? row.domain });
  }
  return out;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const store = loadStore();

  switch (cmd) {
    case "add": {
      const cand = {
        trigger: argVal(args, "--trigger") ?? "",
        action: argVal(args, "--action") ?? "",
        domain: argVal(args, "--domain") ?? "",
        confidence: argVal(args, "--confidence") ? Number(argVal(args, "--confidence")) : undefined,
        source: argVal(args, "--source"),
        critical: argVal(args, "--critical") === "true",
      };
      const errors = validateCandidate(cand);
      if (errors.length > 0) {
        console.error(`[observer] rejected: ${errors.join("; ")}`);
        process.exit(1);
      }
      const { instincts, outcome } = mergeCandidate(store.instincts, cand, today());
      if (outcome.kind === "rejected") {
        console.error(`[observer] rejected: ${outcome.reasons.join("; ")}`);
        process.exit(1);
      }

      // ITEM 6 — one eviction policy. `add` no longer calls the legacy
      // pruneInstincts; every add is admitted or refused by the lifecycle's
      // own planLifecycle, so protection/liveness/supersession actually apply
      // to the write path instead of a second, older ranking.
      const lc = {
        today: today(),
        ...DEFAULT_LIFECYCLE,
        cap: Number(process.env.INSTINCT_CAP ?? INSTINCT_CAP),
      };
      const decision = admitCandidate(
        store.instincts as unknown as LifecycleInstinct[],
        outcome.instinct as unknown as LifecycleInstinct,
        lc,
      );
      if (!decision.admitted) {
        // Fail closed: report the refusal, change nothing, exit non-zero.
        // The old path printed "added" and then silently dropped the row.
        console.error(`[observer] REJECTED ${outcome.instinct.id}: ${decision.reason}`);
        process.exit(1);
      }
      saveStore({ instincts: decision.plan.kept as never[] });
      console.log(
        `[observer] ${outcome.kind}: ${outcome.instinct.id} (${outcome.instinct.domain}, conf=${outcome.instinct.confidence}, reinforced=${outcome.instinct.reinforced_count})` +
          (decision.evicted.length > 0
            ? ` — admitted at cap by evicting ${decision.evicted.map((e) => e.id).join(", ")}`
            : ""),
      );
      break;
    }
    case "brief": {
      const top = Number(argVal(args, "--top") ?? 5);
      const context = argVal(args, "--context") ?? "";
      const out = renderBriefing(selectForBriefing(store.instincts, top, context));
      if (out) console.log(out);
      break;
    }
    case "list": {
      const domain = argVal(args, "--domain");
      const items = rankInstincts(store.instincts).filter((i) => !domain || i.domain === domain);
      for (const i of items)
        console.log(`${i.id}  [${i.domain}] conf=${i.confidence} ×${i.reinforced_count} last=${i.last_seen}\n    ${i.trigger}\n    → ${i.action}`);
      console.log(`${items.length} instinct(s)`);
      break;
    }
    case "stats": {
      const byDomain = new Map<string, number>();
      for (const i of store.instincts) byDomain.set(i.domain, (byDomain.get(i.domain) ?? 0) + 1);
      console.log(
        JSON.stringify(
          {
            total: store.instincts.length,
            cap: INSTINCT_CAP,
            domains: Object.fromEntries(byDomain),
            store: STORE_PATH,
          },
          null,
          2,
        ),
      );
      break;
    }
    case "reinforce": {
      const id = argVal(args, "--id");
      const evidence = argVal(args, "--evidence");
      const inst = store.instincts.find((i) => i.id === id);
      if (!inst) {
        console.error(`[observer] no instinct with id ${id}`);
        process.exit(1);
      }
      // ITEM 8 — reinforcement must cite evidence. reinforced_count is the one
      // number that distinguishes "a pattern that worked" from "a pattern a job
      // counted", and it is what the protection gate trusts. Counting blind job
      // runs makes a threshold of 8 meaningless, so refuse without evidence.
      if (!evidence || evidence.trim().length < 8) {
        console.error(
          `[observer] REJECTED reinforce ${id}: --evidence is required. ` +
            `reinforced_count is the protection signal; cite the concrete episode ` +
            `(episode id, playbook run, or quoted outcome) that exercised this instinct.`,
        );
        process.exit(1);
      }
      inst.reinforced_count += 1;
      inst.last_seen = argVal(args, "--last-seen") ?? today();
      (inst as unknown as Record<string, unknown>).reinforce_evidence = evidence.trim();
      saveStore(store);
      console.log(`[observer] reinforced ${inst.id} → ×${inst.reinforced_count} last=${inst.last_seen}`);
      break;
    }
    case "supersede": {
      const oldId = argVal(args, "--id");
      const newId = argVal(args, "--by");
      if (!oldId || !newId) {
        console.error("[observer] usage: supersede --id inst_OLD --by inst_NEW");
        process.exit(1);
      }
      if (oldId === newId) {
        console.error("[observer] an instinct cannot supersede itself");
        process.exit(1);
      }
      const old = store.instincts.find((i) => i.id === oldId);
      const newer = store.instincts.find((i) => i.id === newId);
      if (!old) {
        console.error(`[observer] no instinct with id ${oldId}`);
        process.exit(1);
      }
      if (!newer) {
        console.error(`[observer] no instinct with id ${newId}`);
        process.exit(1);
      }
      if (old.superseded_by) {
        console.error(
          `[observer] ${oldId} is already superseded by ${old.superseded_by}; refusing to overwrite the audit pointer`,
        );
        process.exit(1);
      }
      // The demotion itself is the lifecycle's job; this command only writes the
      // marker and invokes it, so there is exactly one implementation of the
      // supersede factor and one place the audit stamp is applied.
      newer.supersedes = oldId;
      saveStore(store);
      const lc = { today: today(), ...DEFAULT_LIFECYCLE };
      const plan = planLifecycle(
        store.instincts as unknown as LifecycleInstinct[],
        lc,
      );
      saveStore({ instincts: plan.kept as never[] });
      const applied = plan.supersessions.find((s) => s.superseded === oldId);
      if (!applied) {
        console.error(
          `[observer] marker written to ${newId} but the lifecycle applied no demotion — ` +
            `check that ${oldId} exists and was not already superseded`,
        );
        process.exit(1);
      }
      console.log(
        `[observer] supersede applied: ${oldId} ${applied.from} → ${applied.to} (superseded by ${newId})`,
      );
      break;
    }
    case "supersede-candidates": {
      const domain = argVal(args, "--domain");
      const limit = Number(argVal(args, "--limit") ?? 20);
      const found = findSupersessionCandidates(store.instincts, { domain, limit });
      if (found.length === 0) {
        console.log(
          "[observer] no supersession candidates — nothing in the store contradicts anything else",
        );
        break;
      }
      console.log(
        `[observer] ${found.length} supersession candidate(s) — REVIEW, then apply with ` +
          `\`supersede --id OLD --by NEW\`:\n`,
      );
      for (const p of found) {
        console.log(
          `  ${p.superseded} → ${p.superseder}  [${p.domain}] (${p.reason})\n` +
            `    ${p.detail}\n`,
        );
      }
      break;
    }
    case "remove": {
      const id = argVal(args, "--id");
      const domain = argVal(args, "--domain");
      const reason = (argVal(args, "--reason") ?? "").trim();
      if (!id && !domain) {
        console.error(
          "[observer] usage: remove --id inst_NNN --reason R | remove --domain D --reason R",
        );
        process.exit(1);
      }
      if (id && domain) {
        console.error("[observer] remove takes --id or --domain, not both");
        process.exit(1);
      }
      // A delete with no stated reason cannot be reviewed later, so it is refused.
      if (reason.length < 8) {
        console.error(
          `[observer] REJECTED remove ${id ?? domain}: --reason is required (min 8 chars). ` +
            `Record WHY the row must go so a later resurrection is diagnosable.`,
        );
        process.exit(1);
      }
      const target = store.instincts.filter(
        (i) => (id ? i.id === id : i.domain === domain),
      );
      if (target.length === 0) {
        console.error(`[observer] no instinct matches ${id ?? `domain ${domain}`}`);
        process.exit(1);
      }
      const before = store.instincts.length;
      const kept = store.instincts.filter((i) => !target.includes(i));
      store.instincts = kept;
      saveStore(store);
      appendTombstones(
        target.map((i) => ({
          id: i.id,
          domain: i.domain,
          reason,
          removed_at: new Date().toISOString(),
          removed_by: "observer.ts remove" as const,
          store_md5_before: "",
        })),
      );
      console.log(
        `[observer] removed ${target.length} instinct(s) (${before} → ${kept.length}); ` +
          `tombstoned → ${TOMBSTONE_PATH}\n  reason: ${reason}`,
      );
      break;
    }
    case "verify": {
      const tombstones = readTombstones();
      const resurrections = findResurrections(store, tombstones);
      if (resurrections.length === 0) {
        console.log(
          `[observer] verify OK — ${tombstones.length} tombstone(s), 0 resurrected, ` +
            `${store.instincts.length} live instinct(s).`,
        );
        break;
      }
      console.error(
        `[observer] verify FAILED — ${resurrections.length} tombstoned instinct(s) are BACK ` +
          `in the live store:\n`,
      );
      for (const t of resurrections) {
        console.error(`  ${t.id} [${t.domain}] ${t.reason} (removed ${t.removed_at})`);
      }
      process.exit(1);
    }
    default:
      console.log(
        "usage: observer.ts <add|brief|list|stats|reinforce|remove|verify|supersede|supersede-candidates>\n" +
          "  add --trigger T --action A --domain D [--confidence 0.7] [--critical true] [--source session-observation]\n" +
          "  brief [--top 5] [--context text]\n  list [--domain D]\n  stats\n  reinforce --id inst_NNN\n" +
          "  supersede --id inst_OLD --by inst_NEW\n  supersede-candidates [--domain D] [--limit 20]\n" +
          "  remove --id inst_NNN --reason R | --domain D --reason R\n  verify",
      );
  }
}
