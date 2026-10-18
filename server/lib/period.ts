import { addDays, localDayStart } from "./timezone.js";

export interface Period {
  from: string; // ISO8601, inclusive
  to: string; // ISO8601, inclusive
}

// Every query compares `ts` as text, because SQLite has no date type.
// Stored timestamps always look exactly like `new Date().toISOString()`:
// full date and time, milliseconds, and `Z`.
//
// A bound in any other format gives wrong results instead of an error.
// "2026-09-30" as an upper bound sorts before every timestamp on that day
// ("2026-09-30T00:00:00.000Z" > "2026-09-30"), so the whole day is
// missing from the result. Without milliseconds it goes wrong the other
// way: "…T00:00:00Z" sorts after "…T00:00:00.000Z", so an event exactly
// on the boundary is dropped.
//
// The caller is usually an AI agent, which very often sends a plain
// YYYY-MM-DD and would report a short answer as fact. So every bound is
// converted to the stored format first.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodEdge = "from" | "to";

// A plain date means a day in the site's time zone (TIMEZONE,
// lib/timezone.ts), because that is the day the owner means by
// "yesterday". A full timestamp has its own offset, so the time zone
// doesn't change it.
export function normalizePeriodBound(
  value: string,
  edge: PeriodEdge,
  timezone: string,
): string {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.test(trimmed);
  const parsed = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid ISO8601 date: "${value}". Use a bare date (2026-09-30) or a full timestamp (2026-09-30T14:00:00Z).`,
    );
  }

  if (!dateOnly) return parsed.toISOString();

  // JavaScript rejects an invalid month but quietly moves an invalid day
  // forward: new Date("2026-02-30") is March 2nd, which would widen the
  // period by two days. So a plain date must come back unchanged after
  // parsing (checked on the UTC parse above).
  //
  // This only works for plain dates. A timestamp with an offset can
  // correctly fall on another day in UTC (2026-09-30T01:00:00+02:00 is
  // the 29th in UTC), so the same check would reject valid input.
  if (parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(
      `Invalid ISO8601 date: "${value}" is not a real calendar date.`,
    );
  }

  // A plain date as an upper bound means the end of that day; otherwise
  // "to: 2026-09-30" would leave out the 30th. The end is the next day's
  // start minus 1 ms, not start + 24 hours, because a day with a clock
  // change lasts 23 or 25 hours.
  const start =
    edge === "to"
      ? localDayStart(addDays(trimmed, 1), timezone) - 1
      : localDayStart(trimmed, timezone);
  return new Date(start).toISOString();
}
