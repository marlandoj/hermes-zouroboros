// store-surgery.ts — edit a handful of fields in instincts.yaml without touching
// the rest of the file.
//
// Why this exists: the instinct store is a 200-row YAML document that several
// writers share (observer.ts add/reinforce, lifecycle.ts saveStore, supersede).
// A measurement pass that re-serializes the whole document — the natural way to
// "update two fields" with js-yaml — re-quotes, re-orders and re-wraps every row
// it did not mean to change. The result looks like a measurement and is actually
// a rewrite of the corpus: indistinguishable from data loss in a diff, and
// impossible to revert without a backup. The 2026-09-30 lifecycle remediation
// held to "the live store is byte-identical" for exactly this reason, and a
// measurement write that quietly breaks that is worse than no measurement.
//
// Contract:
//   FAIL CLOSED. The edit is applied to the file text, then the result is parsed
//   and compared field by field against the intent. A mismatch aborts before the
//   original is replaced, so the live store is never left half-edited.

import * as fs from "node:fs";
import { load as parseYaml } from "./yaml-compat";

export interface FieldEdit {
  id: string;
  lastSeen: string;
  timesInjected: number;
  distinctPrompts: number;
}

export interface SurgeryResult {
  wrote: boolean;
  reason: string;
  rows: number;
  bytesBefore: number;
  bytesAfter: number;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** Start offset of the list item whose `- id: <id>` is at or below `from`. */
function findRowStart(lines: string[], id: string, from: number): number {
  const needle = `- id: ${id}`;
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() === needle) return i;
  }
  return -1;
}

function findFieldEnd(lines: string[], start: number, end: number, itemIndent: number): number {
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= itemIndent) return i;
  }
  return end;
}

function scalar(value: string): string {
  // A bare 2026-09-30 is a YAML timestamp: every reader turns it into a Date,
  // and this store writes every other date quoted. Emitting one unquoted value
  // would make a single row disagree with the format of the other 199.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `'${value}'` : value;
}

function setField(
  lines: string[],
  rowStart: number,
  rowEnd: number,
  itemIndent: number,
  key: string,
  value: string,
): void {
  const at = rowStart + 1;
  for (let i = at; i < rowEnd; i++) {
    if (lines[i].trim().startsWith(`${key}:`)) {
      const indent = " ".repeat(indentOf(lines[i]));
      lines[i] = `${indent}${key}: ${scalar(value)}`;
      return;
    }
  }
  // Append immediately after the `- id:` line so the row keeps its own block.
  const indent = " ".repeat(itemIndent + 2);
  lines.splice(at, 0, `${indent}${key}: ${scalar(value)}`);
}

export function writeStoreSurgically(storePath: string, edits: FieldEdit[]): SurgeryResult {
  let original: string;
  try {
    original = fs.readFileSync(storePath, "utf8");
  } catch (err) {
    return { wrote: false, reason: `unreadable store: ${String(err)}`, rows: 0, bytesBefore: 0, bytesAfter: 0 };
  }
  if (edits.length === 0) {
    return { wrote: false, reason: "no edits requested", rows: 0, bytesBefore: original.length, bytesAfter: original.length };
  }

  const lines = original.split("\n");
  let changed = 0;

  for (const edit of edits) {
    const rowStart = findRowStart(lines, edit.id, 0);
    if (rowStart === -1) continue;
    const itemIndent = indentOf(lines[rowStart]);
    const rowEnd = findFieldEnd(lines, rowStart, lines.length, itemIndent);
    setField(lines, rowStart, rowEnd, itemIndent, "last_seen", edit.lastSeen);
    const rowEnd2 = findFieldEnd(lines, rowStart, lines.length, itemIndent);
    setField(lines, rowStart, rowEnd2, itemIndent, "times_injected", String(edit.timesInjected));
    const rowEnd3 = findFieldEnd(lines, rowStart, lines.length, itemIndent);
    setField(lines, rowStart, rowEnd3, itemIndent, "distinct_prompts", String(edit.distinctPrompts));
    changed++;
  }

  if (changed === 0) {
    return { wrote: false, reason: "no requested id was present in the store text", rows: 0, bytesBefore: original.length, bytesAfter: original.length };
  }

  const next = lines.join("\n");

  // Verify the edit against a real parse of the RESULT before it replaces
  // anything: same row count, same ids, and the requested fields actually landed.
  let before: any;
  let after: any;
  try {
    before = (parseYaml(original) as { instincts?: unknown[] } | null)?.instincts;
    after = (parseYaml(next) as { instincts?: unknown[] } | null)?.instincts;
  } catch (err) {
    return { wrote: false, reason: `result does not parse: ${String(err)}`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
  }
  if (!Array.isArray(before) || !Array.isArray(after) || after.length !== before.length) {
    return {
      wrote: false,
      reason: `row count changed (${Array.isArray(before) ? before.length : "?"} -> ${Array.isArray(after) ? after.length : "?"})`,
      rows: changed,
      bytesBefore: original.length,
      bytesAfter: next.length,
    };
  }
  const afterById = new Map<string, any>(after.map((r: any) => [r?.id, r]));
  for (const edit of edits) {
    const row = afterById.get(edit.id);
    if (!row) return { wrote: false, reason: `id ${edit.id} vanished from the result`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
    const dayOf = (v: unknown): string => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      return String(v);
    };    if (dayOf(row.last_seen) !== edit.lastSeen) {
      return { wrote: false, reason: `id ${edit.id}: last_seen is ${String(row.last_seen)}, wanted ${edit.lastSeen}`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
    }
    if (Number(row.times_injected) !== edit.timesInjected) {
      return { wrote: false, reason: `id ${edit.id}: times_injected is ${String(row.times_injected)}, wanted ${edit.timesInjected}`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
    }
    if (Number(row.distinct_prompts) !== edit.distinctPrompts) {
      return { wrote: false, reason: `id ${edit.id}: distinct_prompts is ${String(row.distinct_prompts)}, wanted ${edit.distinctPrompts}`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
    }
  }

  const tmp = `${storePath}.surgery-tmp`;
  try {
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, storePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { wrote: false, reason: `write failed: ${String(err)}`, rows: changed, bytesBefore: original.length, bytesAfter: next.length };
  }

  return { wrote: true, reason: "ok", rows: changed, bytesBefore: original.length, bytesAfter: next.length };
}
