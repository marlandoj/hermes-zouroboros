import { ControlPlaneError } from "../contracts.js";

export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function invalid(field: string, token: string, reason: string): never {
  throw new ControlPlaneError("schedule_invalid", `cron ${field} "${token}": ${reason}`);
}

function parseField(spec: FieldSpec, field: string): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>();
  let restricted = true;
  for (const token of field.split(",")) {
    if (token.length === 0) invalid(spec.name, field, "empty list entry");
    const [rangePart, stepPart, extra] = token.split("/");
    if (extra !== undefined) invalid(spec.name, token, "multiple step separators");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) invalid(spec.name, token, "step must be a positive integer");
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
      if (stepPart === undefined && field === "*") restricted = false;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined || !a || !b) invalid(spec.name, token, "malformed range");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) invalid(spec.name, token, "not an integer");
    if (lo < spec.min || hi > spec.max || lo > hi) {
      invalid(spec.name, token, `out of range ${spec.min}-${spec.max}`);
    }
    for (let value = lo; value <= hi; value += step) set.add(value);
  }
  return { set, restricted };
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ControlPlaneError("schedule_invalid", `cron expression must have 5 fields, got ${parts.length}`);
  }
  const minute = parseField(FIELDS[0], parts[0]);
  const hour = parseField(FIELDS[1], parts[1]);
  const dom = parseField(FIELDS[2], parts[2]);
  const month = parseField(FIELDS[3], parts[3]);
  const dow = parseField(FIELDS[4], parts[4]);
  // Vixie cron: 7 is an alias for Sunday.
  if (dow.set.has(7)) {
    dow.set.delete(7);
    dow.set.add(0);
  }
  return {
    minutes: minute.set,
    hours: hour.set,
    daysOfMonth: dom.set,
    months: month.set,
    daysOfWeek: dow.set,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

// Vixie day semantics: when both day fields are restricted the day matches if
// EITHER matches; otherwise only the restricted one (or any day) applies.
export function cronMatchesDay(cron: CronSchedule, dayOfMonth: number, month: number, dayOfWeek: number): boolean {
  if (!cron.months.has(month)) return false;
  const domMatch = cron.daysOfMonth.has(dayOfMonth);
  const dowMatch = cron.daysOfWeek.has(dayOfWeek);
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  if (cron.domRestricted) return domMatch;
  if (cron.dowRestricted) return dowMatch;
  return true;
}
