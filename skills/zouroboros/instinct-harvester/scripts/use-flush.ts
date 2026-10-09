// use-flush.ts — the measure link. Turns the read-side use journal into store signal.
//
//   bun use-flush.ts [--journal PATH] [--cursor PATH] [--store PATH]
//                    [--evidence-out PATH] [--dry-run]
//
// The read side (Skills/zo-memory-system/scripts/instinct-injector.ts) appends one
// JSON line per turn naming the instincts that were actually injected. This drains
// that journal into the two store fields that are honestly derivable from a
// surface event:
//
//   times_injected  +1 per turn the pattern was rendered into the gate output
//   last_seen        bumped to the date of the most recent injection (forward-only)
//
// It deliberately does NOT touch reinforced_count. Reinforcement means "this pattern
// was exercised and it worked", and only an observer with the episode in front of it
// can say that — observer.ts refuse to count blind runs for exactly this reason. The
// flush therefore writes an evidence candidate list the daily synthesis job can cite
// (or refuse) instead of manufacturing the protection signal on its own.
//
// Crash safety: the cursor is persisted BEFORE the store is written. A crash between
// the two loses a few counts (under-count, the safe direction). The reverse order
// would re-apply the same lines on the next run and inflate the count.

import * as fs from "node:fs";
import * as path from "node:path";
import { writeStoreSurgically } from "./store-surgery";
import { defaultStorePath, instinctsDir } from "./paths";
import {
  loadStore,
  ageInDays,
  type LifecycleInstinct,
} from "./lifecycle";

export const JOURNAL_PATH = path.join(instinctsDir(), "use-journal.jsonl");
export const CURSOR_PATH = `${JOURNAL_PATH}.cursor.json`;
export const DEFAULT_EVIDENCE_OUT = path.join(instinctsDir(), "use-evidence.md");

export interface UseAggregate {
  id: string;
  /** Injection events — one per turn the pattern was rendered. */
  turns: number;
  /**
   * Distinct prompt fingerprints behind those events. An agent loop that
   * re-sends one message 50 times produced 50 turns and 1 prompt; reporting
   * only `turns` would read as 50x the reach that actually happened, so the
   * report and any future protection criterion use THIS number.
   */
  distinct: number;
  lastTs: string;
  personas: string[];
  /** `${persona}|${mh}` keys, not persisted. */
  fingerprints: Set<string>;
}

export interface FlushResult {
  journal: string;
  segments: string[];
  linesRead: number;
  turns: number;
  updated: Array<{
    id: string;
    delta: number;
    total: number;
    distinctDelta: number;
    distinctTotal: number;
    lastSeen: string;
    prevLastSeen: string;
  }>;
  unknown: string[];
  aggregates: UseAggregate[];
  personas: Record<string, number>;
  wrote: boolean;
  dryRun: boolean;
  evidencePath?: string;
  notes: string[];
}

interface Cursor {
  files: Record<string, number>;
  updatedAt?: string;
}

function readCursor(p: string): Cursor {
  try {
    if (!fs.existsSync(p)) return { files: {} };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Cursor;
    return { files: parsed?.files ?? {} };
  } catch {
    return { files: {} };
  }
}

/**
 * The injector records every rename it performs, because the flush identifies a
 * segment by file name. Without this transfer a rotated generation starts at
 * offset 0 and its already-counted lines are counted a second time.
 */
function readRotations(p: string): Record<string, string> {
  try {
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Drop the consumed prefix so the steady-state journal stays small. Bytes an
 *  appending gate writes after this point are past `consumed` and survive. */
function trimConsumed(file: string, consumed: number): void {
  try {
    if (consumed > 0 && fs.statSync(file).size > consumed) fs.truncateSync(file, consumed);
  } catch {
    // Trimming is housekeeping; the cursor is the source of truth either way.
  }
}

/** Consume only whole lines: a torn final line is an append in flight, not data. */
function readSegment(file: string, offset: number): { text: string; consumed: number } {
  const size = fs.statSync(file).size;
  const start = offset > size ? 0 : offset; // rotated or truncated under us
  if (start >= size) return { text: "", consumed: start };
  const buf = fs.readFileSync(file);
  const tail = buf.subarray(start).toString("utf8");
  const lastNl = tail.lastIndexOf("\n");
  if (lastNl < 0) return { text: "", consumed: start };
  return { text: tail.slice(0, lastNl + 1), consumed: start + Buffer.byteLength(tail.slice(0, lastNl + 1), "utf8") };
}

export function parseEntries(text: string): Array<{ ts: string; persona?: string; ids: string[]; mh?: string }> {
  const out: Array<{ ts: string; persona?: string; ids: string[]; mh?: string }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; persona?: string; ids?: string[] };
      if (typeof e?.ts !== "string" || !Array.isArray(e.ids)) continue;
      out.push({ ts: e.ts, persona: e.persona, ids: e.ids.filter((i) => typeof i === "string"), mh: (e as { mh?: string }).mh });
    } catch {
      // A corrupt line is skipped, not fatal: the journal is telemetry and a
      // bad line must not be able to stop the store from being measured.
    }
  }
  return out;
}

export function aggregate(
  entries: Array<{ ts: string; persona?: string; ids: string[]; mh?: string }>,
): {
  byId: Map<string, UseAggregate>;
  personas: Record<string, number>;
  turns: number;
} {
  const byId = new Map<string, UseAggregate>();
  const personas: Record<string, number> = {};
  let turns = 0;
  for (const e of entries) {
    turns++;
    // Every turn lands in the histogram, attributed or not. A histogram that
    // silently drops the unattributed ones no longer sums to `turns`, so its
    // denominator cannot be checked.
    const who = e.persona || "unknown";
    personas[who] = (personas[who] ?? 0) + 1;
    // The fingerprint key is deliberately coarse: one prompt re-sent many times
    // is one prompt, and a prompt that is re-sent on a later day is counted
    // again (dedup is per flush, not per lifetime — a cross-flush fingerprint
    // set would grow the store for no measurement gain).
    const fp = `${who}|${e.mh ?? "?"}`;
    for (const id of e.ids) {
      const cur = byId.get(id) ?? {
        id,
        turns: 0,
        distinct: 0,
        lastTs: "",
        personas: [],
        fingerprints: new Set<string>(),
      };
      cur.turns += 1;
      if (!cur.fingerprints.has(fp)) {
        cur.fingerprints.add(fp);
        cur.distinct += 1;
      }
      if (e.ts > cur.lastTs) cur.lastTs = e.ts;
      if (e.persona && !cur.personas.includes(e.persona)) cur.personas.push(e.persona);
      byId.set(id, cur);
    }
  }
  return { byId, personas, turns };
}

/** Later of two YYYY-MM-DD strings, tolerating junk. */
function maxDate(a: string, b: string): string {
  const av = /^\d{4}-\d{2}-\d{2}$/.test(a) ? a : "";
  const bv = /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : "";
  if (!av) return bv;
  if (!bv) return av;
  return av >= bv ? av : bv;
}

export function applyAggregates(
  rows: LifecycleInstinct[],
  byId: Map<string, UseAggregate>,
): { rows: LifecycleInstinct[]; updated: FlushResult["updated"]; unknown: string[] } {
  const index = new Map(rows.map((i) => [i.id, i]));
  const updated: FlushResult["updated"] = [];
  const unknown: string[] = [];
  for (const [id, agg] of byId) {
    const row = index.get(id);
    if (!row) {
      // Pruned or superseded away between the turn and this flush. Dropping the
      // count is correct: the row it belonged to no longer exists.
      unknown.push(id);
      continue;
    }
    const prevSeen = row.last_seen ?? "";
    const nextSeen = maxDate(prevSeen, agg.lastTs.slice(0, 10));
    row.times_injected = (row.times_injected ?? 0) + agg.turns;
    row.distinct_prompts = (row.distinct_prompts ?? 0) + agg.distinct;
    row.last_seen = nextSeen;
    updated.push({
      id,
      delta: agg.turns,
      total: row.times_injected,
      distinctDelta: agg.distinct,
      distinctTotal: row.distinct_prompts,
      lastSeen: nextSeen,
      prevLastSeen: prevSeen,
    });
  }
  updated.sort((a, b) => b.delta - a.delta || a.id.localeCompare(b.id));
  return { rows, updated, unknown };
}

export function renderEvidence(
  result: FlushResult,
  rows: LifecycleInstinct[],
  today: string,
): string {
  const byId = new Map(rows.map((i) => [i.id, i]));
  const lines: string[] = [
    `# Instinct use evidence — ${today}`,
    "",
    `Journal: \`${result.journal}\``,
    `Turns observed: ${result.turns} · instincts touched: ${result.aggregates.length} · ` +
      `store rows updated: ${result.updated.length} · unknown ids: ${result.unknown.length}`,
    "",
    "Injection means the pattern was rendered into the gate block and therefore reached a",
    "model. It is evidence that the pattern is *reachable and relevant*, NOT that it was",
    "*right*. Reinforcement still requires an observer that saw the outcome. Cite a line",
    "below with `observer.ts reinforce --id <id> --evidence \"<line>\"` only when the",
    "synthesis actually judged that instance.",
    "",
    "`turns` is raw injection events; `distinct prompts` is the count of unique",
    "message fingerprints behind them. An agent loop that re-sends one message",
    "many times produces many turns and ONE prompt — the distinct column is the",
    "honest reach signal, and it is what a future reuse-protection rule should use.",
    "",
    "| instinct | domain | turns | distinct prompts | total turns | total distinct | last injection | liveness@today |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const u of result.updated) {
    const row = byId.get(u.id);
    const domain = row?.domain ?? "?";
    const age = row ? ageInDays(row.last_seen, today) : 0;
    const live = Math.pow(0.5, age / 30);
    lines.push(
      `| ${u.id} | ${domain} | ${u.delta} | ${u.distinctDelta} | ${u.total} | ` +
        `${u.distinctTotal} | ${u.lastSeen} | ${live.toFixed(3)} |`,
    );
  }
  if (result.updated.length === 0) lines.push("| (none) | — | 0 | 0 | 0 | 0 | — | — |");
  lines.push("", "## Citable evidence strings", "");
  for (const u of result.updated.slice(0, 20)) {
    const agg = result.aggregates.find((a) => a.id === u.id);
    const who = agg?.personas.length ? ` (${agg.personas.join(", ")})` : "";
    lines.push(
      `- \`use-journal ${today}: ${u.id} injected in ${u.delta} turn(s) ` +
        `across ${u.distinctDelta} distinct prompt(s)${who}, cumulative ` +
        `${u.total} turns / ${u.distinctTotal} distinct, last ${u.lastSeen}\``,
    );
  }
  if (result.aggregates.length === 0) {
    lines.push("- (no injections recorded since the last flush)");
  }
  return lines.join("\n") + "\n";
}

export function flushUseJournal(opts: {
  journal?: string;
  cursor?: string;
  storePath?: string;
  evidenceOut?: string | null;
  dryRun?: boolean;
  today?: string;
} = {}): FlushResult {
  const journal = opts.journal ?? process.env.INSTINCT_USE_JOURNAL ?? JOURNAL_PATH;
  const cursorPath = opts.cursor ?? `${journal}.cursor.json`;
  const storePath = opts.storePath ?? process.env.INSTINCT_STORE_PATH ?? defaultStorePath();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const dryRun = opts.dryRun === true;
  const notes: string[] = [];

  // Oldest first: the rotated generation holds the earlier half of the day.
  const segments = [journal, `${journal}.1`]
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => (a === `${journal}.1` ? -1 : b === `${journal}.1` ? 1 : 0));

  const cursor = readCursor(cursorPath);
  // A rotation is a rename, and a rename makes the old name ambiguous: it now
  // refers to a DIFFERENT file that must be read from zero, while the bytes the
  // old cursor had already consumed live in the rotated file. The injector
  // records the rename for exactly this reason.
  const rotations = readRotations(`${journal}.rotations.json`);
  const rotatedNames = new Set(Object.keys(rotations));
  const reusedNames = new Set(Object.values(rotations));
  const retired: string[] = [];
  let linesRead = 0;
  const entries: Array<{ ts: string; persona?: string; ids: string[]; mh?: string }> = [];
  for (const seg of segments) {
    const key = path.basename(seg);
    const size = fs.existsSync(seg) ? fs.statSync(seg).size : 0;
    let offset: number;
    if (rotatedNames.has(key)) {
      // A rotated generation inherits the read position of the name it had.
      offset = cursor.files[key] ?? cursor.files[rotations[key]] ?? 0;
    } else if (reusedNames.has(key)) {
      // The file at this name was created after the rename, so it starts at
      // zero even though the cursor remembers the pre-rename file of this name.
      offset = 0;
    } else {
      offset = cursor.files[key] ?? 0;
    }
    if (offset > size) {
      notes.push(`${key}: cursor (${offset}) is past end of file (${size}) — segment was rotated or truncated, rereading from 0.`);
      offset = 0;
    }
    const { text, consumed } = readSegment(seg, offset);
    cursor.files[key] = consumed;
    if (rotatedNames.has(key) && consumed >= size) retired.push(key);
    if (text) {
      linesRead += text.split("\n").filter((l) => l.trim()).length;
      entries.push(...parseEntries(text));
    }
    if (consumed - offset > 0) trimConsumed(seg, consumed);
  }
  if (retired.length > 0) {
    // The mapping has done its job. Leaving it in place would keep forcing the
    // post-rename file back to offset 0 on every future run, which is exactly
    // the double count this mechanism exists to prevent.
    try {
      const left = { ...rotations };
      for (const k of retired) delete left[k];
      if (Object.keys(left).length === 0) fs.rmSync(`${journal}.rotations.json`, { force: true });
      else fs.writeFileSync(`${journal}.rotations.json`, JSON.stringify(left, null, 2), "utf8");
    } catch { /* the cursor is still authoritative; a stale map is only a rerun risk */ }
  }

  const { byId, personas, turns } = aggregate(entries);
  // A missing store is not a store to (re)create. Writing one here would
  // materialize an empty corpus that the gate would then read as authoritative.
  const storeExists = fs.existsSync(storePath);
  if (!storeExists && entries.length > 0) {
    notes.push(
      `store ${storePath} does not exist — ${entries.length} journal line(s) measured ` +
        `against nothing; no file was created.`,
    );
  }
  const rows = loadStore(storePath);
  const { updated, unknown } = applyAggregates(rows, byId);
  const aggregates = [...byId.values()].sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id));

  const result: FlushResult = {
    journal,
    segments,
    linesRead,
    turns,
    updated,
    unknown,
    aggregates,
    personas,
    wrote: false,
    dryRun,
    notes,
  };

  if (updated.length === 0 && entries.length === 0) {
    // Nothing new: leave the cursor file alone so a read-only cron does not
    // rewrite state on every pass.
    if (!dryRun) {
      result.evidencePath = opts.evidenceOut === null ? undefined : opts.evidenceOut ?? DEFAULT_EVIDENCE_OUT;
    }
    return result;
  }

  if (dryRun) {
    result.evidencePath = opts.evidenceOut === null ? undefined : opts.evidenceOut ?? DEFAULT_EVIDENCE_OUT;
    return result;
  }

  // Cursor first, then the store: a crash in between under-counts (safe) where
  // the other order would re-apply the same lines and inflate the count.
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify({ files: cursor.files, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  // The store is edited as TEXT, one field per row, and the edit is verified
  // against a full parse before the file is touched. A js-yaml round-trip would
  // re-quote and reorder every row — a rewrite of the corpus dressed up as a
  // measurement, and the exact reason the remediation could assert a byte-identical
  // store. If verification fails, nothing is written and the cursor is rolled back
  // so the next pass re-measures the same lines.
  if (storeExists) {
    const surgery = writeStoreSurgically(
      storePath,
      updated.map((u) => ({
        id: u.id,
        lastSeen: u.lastSeen,
        timesInjected: u.total,
        distinctPrompts: u.distinctTotal,
      })),
    );
    if (!surgery.wrote) {
      notes.push(`store surgery refused: ${surgery.reason}`);
      try {
        const before = fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, "utf8") : null;
        if (before) fs.writeFileSync(cursorPath, JSON.stringify(JSON.parse(before)), "utf8");
        fs.rmSync(`${storePath}.surgery-tmp`, { force: true });
      } catch { /* best effort */ }
      result.wrote = false;
      return result;
    }
  }
  result.wrote = true;

  const evidencePath = opts.evidenceOut === null ? undefined : opts.evidenceOut ?? DEFAULT_EVIDENCE_OUT;
  if (evidencePath) {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, renderEvidence(result, rows, today), "utf8");
    result.evidencePath = evidencePath;
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const res = flushUseJournal({
    journal: val("--journal"),
    cursor: val("--cursor"),
    storePath: val("--store"),
    evidenceOut: args.includes("--no-evidence") ? null : val("--evidence-out"),
    dryRun,
  });
  for (const n of res.notes) console.error(`[use-flush] note: ${n}`);
  console.log(
    `[use-flush] turns=${res.turns} lines=${res.linesRead} instincts=${res.aggregates.length} ` +
      `updated=${res.updated.length} unknown=${res.unknown.length} ${dryRun ? "DRY-RUN" : res.wrote ? "WROTE" : "NO-OP"}`,
  );
  for (const u of res.updated.slice(0, 10)) {
    console.log(
      `  ${u.id}  +${u.delta} turn(s) / +${u.distinctDelta} prompt(s) → ` +
        `${u.total} / ${u.distinctTotal}  last_seen ${u.prevLastSeen || "\u2205"} → ${u.lastSeen}`,
    );
  }
  if (res.evidencePath) console.log(`[use-flush] evidence: ${res.evidencePath}`);
  if (res.updated.length > 0 && !res.wrote && !dryRun) process.exit(1);
}
