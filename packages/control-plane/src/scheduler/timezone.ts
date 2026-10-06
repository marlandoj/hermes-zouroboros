import { ControlPlaneError } from "../contracts.js";
import { cronMatchesDay, type CronSchedule } from "./cron.js";

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

// A local wall time resolves against the IANA database to exactly one UTC
// instant, two (fall-back repetition), or zero (spring-forward gap). The
// policies are fixed by the seed contract: a repeated local time fires exactly
// once at its earlier instant; a skipped local time fires at the first valid
// instant after the gap.
export type LocalResolution =
  | { readonly kind: "unique"; readonly utcMs: number }
  | { readonly kind: "duplicate"; readonly utcMs: number; readonly laterUtcMs: number }
  | { readonly kind: "gap"; readonly utcMs: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

export function assertValidZone(zone: string): void {
  try {
    formatterFor(zone);
  } catch {
    throw new ControlPlaneError("schedule_invalid", `unknown IANA timezone "${zone}"`);
  }
}

export function wallClock(utcMs: number, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(utcMs);
  const fields: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour === 24 ? 0 : fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

export function zoneOffsetMs(utcMs: number, zone: string): number {
  const wc = wallClock(utcMs, zone);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function matchesLocal(utcMs: number, zone: string, local: LocalTime): boolean {
  const wc = wallClock(utcMs, zone);
  return (
    wc.year === local.year &&
    wc.month === local.month &&
    wc.day === local.day &&
    wc.hour === local.hour &&
    wc.minute === local.minute
  );
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function resolveLocal(local: LocalTime, zone: string): LocalResolution {
  const base = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  const offsets = new Set<number>([
    zoneOffsetMs(base - DAY_MS, zone),
    zoneOffsetMs(base, zone),
    zoneOffsetMs(base + DAY_MS, zone),
  ]);
  const matches = [...new Set([...offsets].map((offset) => base - offset))]
    .filter((utcMs) => matchesLocal(utcMs, zone, local))
    .sort((a, b) => a - b);
  if (matches.length >= 2) return { kind: "duplicate", utcMs: matches[0], laterUtcMs: matches[1] };
  if (matches.length === 1) return { kind: "unique", utcMs: matches[0] };
  // Spring-forward gap: the transition instant is the first UTC minute whose
  // offset equals the post-transition offset, searched between the two
  // candidate instants the surrounding offsets imply.
  const offsetBefore = Math.min(...offsets);
  const offsetAfter = Math.max(...offsets);
  let lo = base - offsetAfter;
  let hi = base - offsetBefore;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (zoneOffsetMs(mid, zone) === offsetAfter) hi = mid;
    else lo = mid;
  }
  return { kind: "gap", utcMs: zoneOffsetMs(lo, zone) === offsetAfter ? lo : hi };
}

function localDateOf(utcMs: number, zone: string): { year: number; month: number; day: number } {
  const wc = wallClock(utcMs, zone);
  return { year: wc.year, month: wc.month, day: wc.day };
}

function addDays(date: { year: number; month: number; day: number }, days: number): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

// Nine years of local days. The binding case is `0 0 29 2 *`: the longest real
// gap between leap days is eight years across a non-leap century boundary
// (2096 -> 2104), so a two-year horizon rejected an ordinary vixie cron that
// fires perfectly well. The walk is a day-granularity scan, so the wider bound
// costs a bounded few thousand iterations only for expressions that are in fact
// rare.
const MAX_SEARCH_DAYS = 3_288;

// The next UTC instant strictly after `afterMs` at which the cron expression
// fires in the zone. Returns null when the expression cannot fire within the
// search horizon (e.g. February 30th, which can never fire), which registration
// treats as invalid.
export function nextCronFireUtc(cron: CronSchedule, zone: string, afterMs: number): number | null {
  const startDate = localDateOf(afterMs, zone);
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  // The walk starts one local day early: around a fall-back transition a UTC
  // instant after `afterMs` can carry an earlier local calendar date.
  for (let dayOffset = -1; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
    const date = addDays(startDate, dayOffset);
    if (!cronMatchesDay(cron, date.day, date.month, date.weekday)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const resolution = resolveLocal(
          { year: date.year, month: date.month, day: date.day, hour, minute },
          zone,
        );
        if (resolution.utcMs > afterMs) return resolution.utcMs;
      }
    }
  }
  return null;
}

export function nextIntervalFireUtc(anchorMs: number, intervalMs: number, afterMs: number): number {
  if (afterMs < anchorMs) return anchorMs;
  const elapsed = afterMs - anchorMs;
  const steps = Math.floor(elapsed / intervalMs) + 1;
  return anchorMs + steps * intervalMs;
}
