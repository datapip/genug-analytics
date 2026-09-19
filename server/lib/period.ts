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
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PeriodEdge = "from" | "to";

export function normalizePeriodBound(value: string, edge: PeriodEdge): string {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.test(trimmed);
  // Bare dates are pinned to UTC explicitly rather than relying on
  // `new Date("2026-09-30")` happening to treat a date-only string as
  // UTC — that's correct per spec, but it's the kind of rule that reads
  // as an accident to anyone checking this later.
  const parsed = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid ISO8601 date: "${value}". Use a bare date (2026-09-30) or a full timestamp (2026-09-30T14:00:00Z).`,
    );
  }

  // JS rejects an out-of-range month but silently *rolls over* an
  // out-of-range day: new Date("2026-02-30") is March 2nd. Accepting
  // that would quietly widen the window by two days — the same kind of
  // invisible wrongness this module exists to stop — so a date-only
  // bound has to survive a round-trip to be trusted.
  //
  // Only checkable for the date-only form: a full timestamp carrying a
  // UTC offset can legitimately land on a different calendar day than
  // the one written (2026-09-30T01:00:00+02:00 really is the 29th in
  // UTC), so the same comparison there would reject valid input.
  if (dateOnly && parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(
      `Invalid ISO8601 date: "${value}" is not a real calendar date.`,
    );
  }

  // A bare date names a whole day, so as an upper bound it has to mean
  // the end of that day — otherwise "to: 2026-09-30" excludes
  // everything that actually happened on the 30th, which is the exact
  // bug this function exists to prevent.
  if (dateOnly && edge === "to") {
    return new Date(parsed.getTime() + MS_PER_DAY - 1).toISOString();
  }

  return parsed.toISOString();
}
