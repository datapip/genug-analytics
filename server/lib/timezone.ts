import type Database from "better-sqlite3";

// The site's own calendar. Every stored `ts` is a UTC instant, and that
// stays true; this module is only about where one day or hour ends and
// the next begins. Those cuts used to be at UTC midnight, which for a
// site in Berlin is 01:00 or 02:00 local time — a visit at 00:30 was
// counted on the previous day and at hour 22, plausible while wrong.
//
// SQLite's strftime can shift by a fixed offset but knows nothing of
// IANA zones, and a fixed offset is wrong for half the year wherever
// clocks change. So the offsets are worked out here, with Intl, and
// handed to SQL as spans of constant offset (`localSpans`): one span
// for most periods, two or three when a clock change falls inside.
//
// Every function takes the zone explicitly rather than reading it from
// the environment, so a test can pin any zone and none of them holds
// state beyond a cache of formatters.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // h23, not the default h12 or `hour12: false`: the latter prints
      // midnight as "24" in some engines.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// Minutes the zone is ahead of UTC at this instant: 120 for Berlin in
// summer, 60 in winter, -300 for New York in winter.
export function offsetMinutes(instant: number, timezone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  // The formatter has no milliseconds, so compare whole seconds.
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return Math.round((wallClock - whole) / MINUTE_MS);
}

// The local calendar date of an instant, as YYYY-MM-DD.
export function localDate(instant: Date | number, timezone: string): string {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return new Date(ms + offsetMinutes(ms, timezone) * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
}

// Calendar arithmetic on a YYYY-MM-DD, in whole days. Done on the date
// itself, not by adding 24 hours to an instant: a day with a clock
// change has 23 or 25.
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// The first instant of a local calendar day, as epoch ms. Found by
// bisection rather than by subtracting an offset: the offset at
// midnight is the thing being looked for, and in the few zones that
// change their clocks at 00:00 local midnight does not exist at all —
// the day then starts at the change, which is what this returns.
export function localDayStart(date: string, timezone: string): number {
  // Every real offset lies within ±14 hours, so the day starts in here.
  const nominal = new Date(`${date}T00:00:00.000Z`).getTime();
  let lo = nominal - 15 * 60 * MINUTE_MS;
  let hi = nominal + 15 * 60 * MINUTE_MS;
  // Invariant: lo is before the day, hi is inside it or after.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timezone) < date) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Every local calendar day a period touches, in order. A trend needs
// every day present, not only the ones with data, or a quiet day
// vanishes instead of showing as a dip.
export function enumerateDays(
  fromIso: string,
  toIso: string,
  timezone: string,
): string[] {
  const last = localDate(new Date(toIso), timezone);
  const days: string[] = [];
  for (
    let day = localDate(new Date(fromIso), timezone);
    day <= last;
    day = addDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

export interface OffsetSpan {
  start: string;
  end: string;
  offset: number;
}

// The period cut into pieces of constant offset. Contiguous and
// half-open by construction — [start, end) — because an overlap would
// count a row twice and a gap would drop it, both silently. The outer
// edges are left open ('' and '9999' sort around every timestamp): the
// query's own `ts BETWEEN @from AND @to` bounds the period, so only the
// clock changes inside it need to be exact. Those are emitted with
// toISOString(), the one format `ts` is stored in, or the string
// comparison goes wrong the way lib/period.ts describes.
export function offsetSpans(
  fromIso: string,
  toIso: string,
  timezone: string,
): OffsetSpan[] {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  const spans: OffsetSpan[] = [];
  let start = "";
  let offset = offsetMinutes(from, timezone);

  // A day at a time: no zone changes its clock twice within one day,
  // so a change between two steps is found by bisecting that day.
  for (let prev = from; prev < to;) {
    const next = Math.min(prev + DAY_MS, to);
    const nextOffset = offsetMinutes(next, timezone);
    if (nextOffset !== offset) {
      let lo = prev;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetMinutes(mid, timezone) === offset) lo = mid;
        else hi = mid;
      }
      const change = new Date(hi).toISOString();
      spans.push({ start, end: change, offset });
      start = change;
      offset = nextOffset;
    }
    prev = next;
  }
  spans.push({ start, end: "9999", offset });
  return spans;
}

// Joins each event to the span it falls in, so a query can bucket on
// local time with `strftime(fmt, ts, span_offset || ' minutes')`. The
// spans arrive as one bound JSON parameter, @spans, from `localSpans`
// below — the same one-parameter idiom as a segment's lists — so the
// SQL text is fixed and nothing is built from a value. The column names
// are prefixed so none of them can shadow a column of `events`, which
// a segment clause pasted after this refers to unqualified.
export const LOCAL_SPANS_CTE = `local_spans AS (
  SELECT json_extract(value, '$.start') AS span_start,
         json_extract(value, '$.end') AS span_end,
         json_extract(value, '$.offset') AS span_offset
  FROM json_each(@spans))`;

export const JOIN_LOCAL_SPANS =
  "JOIN local_spans ON ts >= span_start AND ts < span_end";

// Scanned between the first and last stored row in the period, not
// between the bounds asked for: an agent can ask from year 1, which is
// ~740,000 daily steps, while the rows — stamped by this server on
// arrival — span at most the deployment's life. Two lookups on the ts
// index, each a single seek.
export function localSpans(
  db: Database.Database,
  period: { from: string; to: string },
  timezone: string,
): string {
  const { first, last } = db
    .prepare(
      `SELECT (SELECT MIN(ts) FROM events WHERE ts BETWEEN @from AND @to) AS first,
              (SELECT MAX(ts) FROM events WHERE ts BETWEEN @from AND @to) AS last`,
    )
    .get({ from: period.from, to: period.to }) as {
    first: string | null;
    last: string | null;
  };
  // No rows, nothing to bucket: any single span will do.
  if (first === null || last === null) {
    return JSON.stringify([{ start: "", end: "9999", offset: 0 }]);
  }
  return JSON.stringify(offsetSpans(first, last, timezone));
}
