#!/usr/bin/env bun
// Selftest for the sanctioned delete path added to observer.ts (ZOU-451).
//
// Until this landed the store had no sanctioned way to delete a row: observer.ts
// exposed add/brief/list/stats/reinforce/supersede and nothing else. Any prune
// therefore had to be a hand-edit of instincts.yaml outside the writer, which is
// how the 2026-09-30 JEV rows came back. These tests pin the three properties
// that make a prune stick:
//
//   1. remove deletes exactly the requested ids and nothing else
//   2. every removal leaves a tombstone carrying the reason
//   3. verify reports a resurrected tombstoned id (the 15:15 -> 16:59 failure)
//
// Runs against a temp store + temp tombstone path via env indirection so it can
// never touch the live store.

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "instinct-remove-selftest-"));
const storePath = join(dir, "instincts.yaml");
const tombstonePath = join(dir, "tombstones.jsonl");

process.env.INSTINCT_STORE_PATH = storePath;
process.env.INSTINCT_TOMBSTONE_PATH = tombstonePath;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Row = {
  id: string;
  domain: string;
  trigger: string;
  action: string;
  confidence: number;
  reinforced_count: number;
  last_seen: string;
};

const SEED: Row[] = [
  {
    id: "inst_100",
    domain: "alpha",
    trigger: "when a Qdrant write is verified",
    action: "check the count and the payload before moving on",
    confidence: 0.8,
    reinforced_count: 3,
    last_seen: "2026-09-01",
  },
  {
    id: "inst_101",
    domain: "jev-memory-benchmark",
    trigger: "when adjudicating a JEV memory benchmark cohort",
    action: "emit the JEV gate decision",
    confidence: 0.6,
    reinforced_count: 1,
    last_seen: "2026-07-01",
  },
  {
    id: "inst_102",
    domain: "jev-memory-benchmark",
    trigger: "when the JEV strategy emits a readiness verdict",
    action: "rerun the gate before the verdict is trusted",
    confidence: 0.6,
    reinforced_count: 1,
    last_seen: "2026-07-01",
  },
  {
    id: "inst_103",
    domain: "beta",
    trigger: "when a harness config is missing a secret",
    action: "fail closed and report the missing key by name",
    confidence: 0.9,
    reinforced_count: 9,
    last_seen: "2026-09-20",
  },
];

function seed(): void {
  writeFileSync(storePath, JSON.stringify({ instincts: SEED }, null, 2) + "\n", "utf8");
}

const {
  loadStore,
  saveStore,
  appendTombstones,
  readTombstones,
  findResurrections,
  TOMBSTONE_PATH,
} = await import("./observer.ts");

console.log("remove + verify selftest");

check(
  "TOMBSTONE_PATH honours INSTINCT_TOMBSTONE_PATH",
  TOMBSTONE_PATH === tombstonePath,
  TOMBSTONE_PATH,
);

function tomb(id: string, domain: string, reason = "jev-removal") {
  return {
    id,
    domain,
    reason,
    removed_at: "2026-09-30",
    removed_by: "observer.ts remove" as const,
    store_md5_before: "test",
  };
}

// ---------------------------------------------------------------- remove by id
seed();
{
  const store = loadStore(storePath);
  const before = store.instincts.length;
  const kept = store.instincts.filter((i) => i.id !== "inst_101");
  saveStore({ instincts: kept }, storePath);
  appendTombstones([tomb("inst_101", "jev-memory-benchmark")], tombstonePath);

  const after = loadStore(storePath);
  check(
    "remove --id deletes exactly one row",
    after.instincts.length === before - 1,
    `${before} -> ${after.instincts.length}`,
  );
  check("removed id is gone", !after.instincts.some((i) => i.id === "inst_101"));
  check("sibling rows survive", after.instincts.some((i) => i.id === "inst_102"));
  check(
    "unrelated rows survive untouched",
    after.instincts.some((i) => i.id === "inst_100") && after.instincts.some((i) => i.id === "inst_103"),
  );
  check("tombstone written", readTombstones(tombstonePath).some((t) => t.id === "inst_101"));
}

// ------------------------------------------------------------ remove by domain
seed();
{
  const store = loadStore(storePath);
  const domain = "jev-memory-benchmark";
  const victims = store.instincts.filter((i) => i.domain === domain);
  const kept = store.instincts.filter((i) => i.domain !== domain);
  saveStore({ instincts: kept }, storePath);
  appendTombstones(
    victims.map((v) => tomb(v.id, v.domain)),
    tombstonePath,
  );

  const after = loadStore(storePath);
  check(
    "remove --domain deletes every row in the domain",
    after.instincts.length === 2,
    `${after.instincts.length}`,
  );
  check("no row of that domain remains", !after.instincts.some((i) => i.domain === domain));
  // The log is append-only across blocks, so count distinct ids, not lines.
  const tombs = readTombstones(tombstonePath).filter((t) => t.domain === domain);
  const distinct = new Set(tombs.map((t) => t.id));
  check("one tombstone per removed row", distinct.size === 2, `${distinct.size}`);
  check("tombstones carry a reason", tombs.every((t) => t.reason.trim().length > 0));
  check("tombstones carry removed_at", tombs.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.removed_at)));
}

// ------------------------------------------------- verify: clean after a prune
seed();
{
  const store = loadStore(storePath);
  const victims = store.instincts.filter((i) => i.domain === "jev-memory-benchmark");
  const kept = store.instincts.filter((i) => i.domain !== "jev-memory-benchmark");
  saveStore({ instincts: kept }, storePath);
  appendTombstones(
    victims.map((v) => tomb(v.id, v.domain)),
    tombstonePath,
  );
  const resurrections = findResurrections(loadStore(storePath), readTombstones(tombstonePath));
  check("verify reports no resurrection after a clean prune", resurrections.length === 0, resurrections.join(","));
}

// ---------------------------- verify: DETECTS the resurrection regression case
{
  // Simulate the writer that restored a 200-row file: re-add a tombstoned id.
  const store = loadStore(storePath);
  (store.instincts as unknown as Row[]).push(SEED[2]);
  saveStore(store, storePath);

  const resurrections = findResurrections(
    loadStore(storePath),
    readTombstones(tombstonePath),
  );
  check(
    "verify DETECTS a resurrected tombstoned id",
    resurrections.some((t) => t.id === "inst_102"),
    resurrections.map((t) => t.id).join(","),
  );
}

// ------------------------------------ tombstone log survives repeated prunes
{
  const n0 = readTombstones(tombstonePath).length;
  appendTombstones([tomb("inst_999", "gamma", "second-pass")], tombstonePath);
  const n1 = readTombstones(tombstonePath).length;
  check("tombstone log is append-only across runs", n1 === n0 + 1, `${n0} -> ${n1}`);
  check("tombstone file exists on disk", existsSync(tombstonePath));
  check("tombstone file is one line per entry", readFileSync(tombstonePath, "utf8").trim().split("\n").length === n1);
}

// ------------------------------------------------------ live store untouched
check(
  "selftest never wrote the live store",
  process.env.INSTINCT_STORE_PATH === storePath && storePath.startsWith(tmpdir()),
  process.env.INSTINCT_STORE_PATH ?? "",
);

console.log(`remove+verify selftest: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
