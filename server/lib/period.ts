import { addDays, localDayStart } from "./timezone.js";

export interface Period {
  from: string; // ISO8601, inclusive
  to: string; // ISO8601, inclusive
}

// Every metrics query compares `ts` as a plain string — SQLite has no
// date type, and stored timestamps are always exactly what
// `new Date().toISOString()` produces: full ISO, milliseconds, `Z`.
//
// A bound in any other shape therefore compares *wrongly* rather than
// failing. "2026-09-30" as an upper bound sorts below every real
// timestamp on that day ("2026-09-30T00:00:00.000Z" > "2026-09-30"),
// so the whole day silently disappears from the result. A timestamp
// without milliseconds is off in the other direction: "…T00:00:00Z"
// sorts *above* "…T00:00:00.000Z", so an event exactly on the boundary
// is dropped.
//
// This matters more here than it would elsewhere, because the caller is
// an AI agent: a bare YYYY-MM-DD is the single most likely thing a model
// emits for "last 30 days", and a silently-short answer is one it will
// report confidently. Normalizing isn't defensive programming — it's the
// difference between a right answer and a wrong one nobody can see is
// wrong.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodEdge = "from" | "to";

// A bare date is a day in the site's own zone (TIMEZONE, lib/timezone.ts),
// because that is the day the owner means when they say "yesterday".
// A full timestamp names an instant and carries its own offset, so the
// zone does not touch it.
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

  // JS rejects an out-of-range month but silently *rolls over* an
  // out-of-range day: new Date("2026-02-30") is March 2nd. Accepting
  // that would quietly widen the window by two days — the same kind of
  // invisible wrongness this module exists to stop — so a date-only
  // bound has to survive a round-trip to be trusted. Checked on the
  // UTC parse above, where it is a pure calendar question.
  //
  // Only checkable for the date-only form: a full timestamp carrying a
  // UTC offset can legitimately land on a different calendar day than
  // the one written (2026-09-30T01:00:00+02:00 really is the 29th in
  // UTC), so the same comparison there would reject valid input.
  if (parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(
      `Invalid ISO8601 date: "${value}" is not a real calendar date.`,
    );
  }

  // A bare date names a whole day, so as an upper bound it has to mean
  // the end of that day — otherwise "to: 2026-09-30" excludes
  // everything that actually happened on the 30th, which is the exact
  // bug this function exists to prevent. The end is the next day's
  // start minus 1 ms, not start + 24 hours: a day with a clock change
  // lasts 23 or 25.
  const start =
    edge === "to"
      ? localDayStart(addDays(trimmed, 1), timezone) - 1
      : localDayStart(trimmed, timezone);
  return new Date(start).toISOString();
}
