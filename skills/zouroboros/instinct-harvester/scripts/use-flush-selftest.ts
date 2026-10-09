// use-flush-selftest.ts — the measure link's contract, in one place.
//
//   bun use-flush-selftest.ts   (exit 0 = all pass)
//
// The invariant under test is NOT "the counter goes up". It is narrower and
// harder: the flush may only ever add two fields from a surface event
// (times_injected, last_seen), must be idempotent under re-runs, must survive a
// truncated/rotated journal, and must never touch confidence, reinforced_count
// or row membership. If it can, then reinforcement is being manufactured from
// "the model was shown a line" and the protection signal is a lie.
//
// Temp store + temp journal only. Never touches .zo/instincts.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { load as yamlLoad, dump as yamlDump } from "./yaml-compat";
import { flushUseJournal, parseEntries, aggregate, type FlushResult } from "./use-flush";
import type { LifecycleInstinct } from "./lifecycle";import { normalizeYmd } from "./lifecycle";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ck(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    failures.push(name);
    console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}
function ok(name: string, cond: boolean) {
  ck(name, cond === true, true);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "use-flush-test-"));
let caseNo = 0;

function fixtureStore(rows: Partial<LifecycleInstinct>[] = []): string {
  const p = path.join(tmp, `store-${caseNo++}.yaml`);
  fs.writeFileSync(p, yamlDump({ instincts: rows }));
  return p;
}
function line(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: "2026-09-30T12:00:00.000Z",
    ids: ["inst_a"],
    mh: "0123456789ab",
    ...over,
  })}\n`;
}
function writeJournal(p: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join(""), "utf8");
}
function readStore(p: string): Record<string, LifecycleInstinct> {
  const doc = yamlLoad(fs.readFileSync(p, "utf8")) as { instincts: LifecycleInstinct[] };
  // js-yaml returns an unquoted date as a Date; the assertions compare strings.
  return Object.fromEntries(
    doc.instincts.map((i) => [i.id, { ...i, last_seen: normalizeYmd(i.last_seen) }]),
  );
}
function run(opts: Parameters<typeof flushUseJournal>[0] = {}): FlushResult {
  return flushUseJournal({ today: "2026-09-30", ...opts });
}
const row = (over: Partial<LifecycleInstinct> = {}): Partial<LifecycleInstinct> => ({
  id: "inst_a",
  trigger: "when the store at cap refuses an add",
  action: "Read the refusal reason before retrying; the cap is the policy.",
  domain: "instinct-harvester",
  confidence: 0.9,
  reinforced_count: 0,
  last_seen: "2026-06-21",
  ...over,
});

// ── 1. no journal, no write ────────────────────────────────────────────────────
{
  const store = fixtureStore([row()]);
  const before = fs.readFileSync(store, "utf8");
  const r = run({ storePath: store, journal: path.join(tmp, "absent.jsonl"), evidenceOut: null });
  ck("absent journal: zero turns", r.turns, 0);
  ck("absent journal: zero updates", r.updated.length, 0);
  ck("absent journal: nothing written", fs.readFileSync(store, "utf8"), before);
  ok("absent journal: no cursor file created", !fs.existsSync(path.join(tmp, "absent.jsonl.cursor.json")));
}

// ── 2. one turn, two ids ──────────────────────────────────────────────────────
{
  const store = fixtureStore([row(), row({ id: "inst_b" })]);
  const j = path.join(tmp, "j2.jsonl");
  writeJournal(j, [line({ ids: ["inst_a", "inst_b"] })]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  const after = readStore(store);
  ck("one turn credits each rendered id once", after.inst_a.times_injected, 1);
  ck("one turn credits the second id once", after.inst_b.times_injected, 1);
  ck("last_seen advances to the injection date", after.inst_a.last_seen, "2026-09-30");
  ck("unknown ids list is empty when every id exists", r.unknown, []);
}

// ── 3. idempotency: a second flush with no new lines changes nothing ───────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j3.jsonl");
  writeJournal(j, [line()]);
  run({ storePath: store, journal: j, evidenceOut: null });
  const mid = fs.readFileSync(store, "utf8");
  const again = run({ storePath: store, journal: j, evidenceOut: null });
  ck("re-flush credits nothing", again.updated.length, 0);
  ck("re-flush leaves the store byte-identical", fs.readFileSync(store, "utf8"), mid);
  ck("re-flush does not double the count", readStore(store).inst_a.times_injected, 1);

  // a genuinely new turn is the only thing that moves the number
  fs.appendFileSync(j, line({ ts: "2026-09-30T13:00:00.000Z" }), "utf8");
  run({ storePath: store, journal: j, evidenceOut: null });
  ck("a new turn adds exactly one", readStore(store).inst_a.times_injected, 2);
}

// ── 4. forward-only: an older injection must not rewind last_seen ─────────────
{
  const store = fixtureStore([row({ last_seen: "2026-09-30" })]);
  const j = path.join(tmp, "j4.jsonl");
  writeJournal(j, [line({ ts: "2026-07-04T09:00:00.000Z" })]);
  run({ storePath: store, journal: j, evidenceOut: null });
  const after = readStore(store).inst_a;
  ck("last_seen never moves backwards", after.last_seen, "2026-09-30");
  ck("an older injection still counts as use", after.times_injected, 1);
}

// ── 5. reinforcement stays evidence-gated ─────────────────────────────────────
{
  const store = fixtureStore([row({ confidence: 0.55, reinforced_count: 3 })]);
  const j = path.join(tmp, "j5.jsonl");
  writeJournal(j, [line(), line({ ts: "2026-09-30T12:05:00.000Z" })]);
  run({ storePath: store, journal: j, evidenceOut: null });
  const after = readStore(store).inst_a;
  ck("confidence is never touched by use", after.confidence, 0.55);
  ck("reinforced_count is never touched by use", after.reinforced_count, 3);
}

// ── 6. an id with no row is dropped, not resurrected ──────────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j6.jsonl");
  writeJournal(j, [line({ ids: ["inst_gone", "inst_a"] })]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  ck("a pruned id is reported as unknown", r.unknown, ["inst_gone"]);
  ck("no row is created for a pruned id", readStore(store).inst_gone, undefined);
  ck("the surviving id is still credited", readStore(store).inst_a.times_injected, 1);
}

// ── 7. malformed lines cost a count, never the run ────────────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j7.jsonl");
  writeJournal(j, [
    "not json at all\n",
    line({ ids: "inst_a" }), // ids must be an array
    line({ ts: "not-a-date", ids: ["inst_a"] }),
    line(),
  ]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  const after = readStore(store).inst_a;
  ok("a malformed line does not abort the flush", r.turns >= 1);
  ok("valid lines in the same file still apply", (after.times_injected ?? 0) >= 1);
  ok("a garbage ts cannot corrupt last_seen", /^\d{4}-\d{2}-\d{2}$/.test(after.last_seen));
}

// ── 8. a line with no ids credits nothing ─────────────────────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j8.jsonl");
  writeJournal(j, [line({ ids: [] })]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  ck("an empty id list credits nothing", r.updated.length, 0);
  ck("an empty id list leaves the store empty of counts", readStore(store).inst_a.times_injected, undefined);
}

// ── 9. rotation: both generations are drained in one pass, in order ────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j9.jsonl");
  writeJournal(j, [line({ ts: "2026-09-29T10:00:00.000Z" })]);
  run({ storePath: store, journal: j, evidenceOut: null });
  // the injector rotates: current becomes the .1 generation, a new file starts.
  // recordUse() writes the rotation map before the rename, so use the real thing.
  fs.writeFileSync(`${j}.rotations.json`, JSON.stringify({ ["j9.jsonl.1"]: "j9.jsonl" }));
  fs.renameSync(j, `${j}.1`);
  writeJournal(j, [line({ ts: "2026-09-30T10:00:00.000Z" })]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  ck("a rotated flush counts both generations once", readStore(store).inst_a.times_injected, 2);
  ck("rotation is reported as two segments", r.segments.length, 2);
  ck("last_seen takes the newest of the two dates", readStore(store).inst_a.last_seen, "2026-09-30");
  // and a third pass must not recount either generation
  const r2 = run({ storePath: store, journal: j, evidenceOut: null });
  ck("rotation is not recounted on the next pass", r2.updated.length, 0);
  ck("post-rotation count is still 2", readStore(store).inst_a.times_injected, 2);
}

// ── 10. a truncated segment is re-read from zero, and says so ──────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j10.jsonl");
  writeJournal(j, [line(), line({ ts: "2026-09-30T13:00:00.000Z" })]);
  run({ storePath: store, journal: j, evidenceOut: null });
  fs.writeFileSync(j, line(), "utf8"); // truncated below the cursor
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  ok("cursor past EOF is reported as a note", r.notes.some((n) => n.includes("rereading from 0")));
}

// ── 11. a half-written trailing line waits for the next pass ───────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j11.jsonl");
  fs.mkdirSync(path.dirname(j), { recursive: true });
  fs.writeFileSync(j, line().slice(0, 40), "utf8"); // no trailing newline
  run({ storePath: store, journal: j, evidenceOut: null });
  ck("a partial line is not consumed", readStore(store).inst_a.times_injected, undefined);
  fs.writeFileSync(j, line(), "utf8"); // the writer finishes the line
  run({ storePath: store, journal: j, evidenceOut: null });
  ck("the completed line is consumed on the next pass", readStore(store).inst_a.times_injected, 1);
}

// ── 12. dry run touches neither the store nor the cursor ──────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j12.jsonl");
  writeJournal(j, [line()]);
  const before = fs.readFileSync(store, "utf8");
  const r = run({ storePath: store, journal: j, dryRun: true, evidenceOut: null });
  ck("dry run still reports what it would do", r.updated.length, 1);
  ck("dry run writes no store", fs.readFileSync(store, "utf8"), before);
  ok("dry run writes no cursor", !fs.existsSync(`${j}.cursor.json`));
  ok("dry run is flagged in the result", r.dryRun === true);
}

// ── 13. evidence output is written and refuses to overclaim ────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j13.jsonl");
  const out = path.join(tmp, "evidence-13.md");
  writeJournal(j, [line({ persona: "assistant" })]);
  const r = run({ storePath: store, journal: j, evidenceOut: out });
  ok("evidence file is written", fs.existsSync(out));
  const md = fs.readFileSync(out, "utf8");
  ok("evidence names the instinct", md.includes("inst_a"));
  ok("evidence attributes the persona", md.includes("assistant"));
  ok("evidence states that injection is not correctness", /NOT that it was/.test(md));
  ok("evidence offers a citable string", md.includes("observer.ts reinforce --id"));
  ok("evidence path is reported back", r.evidencePath === out);
}

// ── 14. persona distribution is aggregated, not invented ───────────────────────
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j14.jsonl");
  writeJournal(j, [
    line({ persona: "assistant" }),
    line({ persona: "financial-advisor", ts: "2026-09-30T12:01:00.000Z" }),
    line({ ts: "2026-09-30T12:02:00.000Z" }),
  ]);
  const r = run({ storePath: store, journal: j, evidenceOut: null });
  ck("three turns across two personas", r.turns, 3);
  ck("per-persona counts", r.personas, { assistant: 1, "financial-advisor": 1, "unknown": 1 });
}

// ── 15. a missing store is a no-op, not a crash ───────────────────────────────
{
  const j = path.join(tmp, "j15.jsonl");
  writeJournal(j, [line()]);
  const r = run({ storePath: path.join(tmp, "does-not-exist.yaml"), journal: j, evidenceOut: null });
  ck("missing store: the id is simply unknown", r.unknown, ["inst_a"]);
  ck("missing store: nothing was written", fs.existsSync(path.join(tmp, "does-not-exist.yaml")), false);
}

// ── 16. parsing is total: junk in, no throw out ───────────────────────────────
{
  const entries = parseEntries("garbage\n{}\n" + line({ ids: ["x", "y"], persona: "p" }));
  ck("only well-formed entries survive", entries.length, 1);
  ck("ids are preserved in order", entries[0].ids, ["x", "y"]);
  const agg = aggregate(entries);
  ck("aggregation keeps the newest timestamp", agg.byId.get("x")?.turns, 1);
  ck("aggregation keeps the persona set", agg.byId.get("x")?.personas, ["p"]);
}

// ── 17. turns and distinct prompts are different numbers ───────────────────────
// A trigger that matches on every message in a domain ("instinct store yaml",
// "memory gate") will be injected on a large share of turns. That is a real
// signal about *relevance of the trigger*, and if it is the only number we
// keep, it reads as a pattern that works. Counting the same prompt N times
// once is the counterweight, and both have to survive into the report.
{
  const store = fixtureStore([row()]);
  const j = path.join(tmp, "j17.jsonl");
  writeJournal(j, [
    line({ ts: "2026-09-30T01:00:00.000Z", mh: "aaaaaaaaaaaa" }),
    line({ ts: "2026-09-30T02:00:00.000Z", mh: "aaaaaaaaaaaa" }),
    line({ ts: "2026-09-30T03:00:00.000Z", mh: "bbbbbbbbbbbb" }),
  ]);
  const r = run({ storePath: store, journal: j, evidenceOut: path.join(tmp, "ev17.md") });
  const row17 = readStore(store).inst_a;
  ck("turns is 3", row17.times_injected, 3);
  ck("distinct prompts is 2", row17.distinct_prompts, 2);
  ck("a repeat is still a turn, never a rewind", row17.last_seen, "2026-09-30");
  ck("flush result carries the distinct delta", r.updated[0].distinctDelta, 2);
  ck("flush result carries the raw turn delta", r.updated[0].delta, 3);
  ck("flush result carries the cumulative distinct total", r.updated[0].distinctTotal, 2);
  const ev = fs.readFileSync(path.join(tmp, "ev17.md"), "utf8");
  ck("evidence table shows a distinct-prompt column", ev.includes("| turns | distinct prompts |"), true);
  ck("evidence calls the distinct column the honest reach signal", ev.includes("the distinct column is the"), true);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`use-flush selftest: ${pass} pass / ${fail} fail`);
if (fail > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
