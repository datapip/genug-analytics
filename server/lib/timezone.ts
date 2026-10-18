import type Database from "better-sqlite3";

// Days and hours in the site's time zone. Every stored `ts` is in UTC;
// this module only decides where a local day or hour begins and ends.
// Using UTC midnight instead would, for a site in Berlin, count a visit
// at 00:30 on the previous day.
//
// SQLite's strftime can only shift by a fixed offset, and a fixed offset
// is wrong for half the year wherever clocks change. So the offsets are
// worked out here with Intl and passed to SQL as time spans with one
// offset each (`localSpans`): one span for most periods, two or three
// when a clock change falls inside.
//
// Every function takes the time zone as a parameter instead of reading
// the environment, so tests can use any zone.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // h23 rather than `hour12: false`, which shows midnight as "24" in
      // some JavaScript engines.
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

// Adds whole days to a YYYY-MM-DD date. Done on the date itself, not by
// adding 24 hours to a time, because a day with a clock change has 23 or
// 25 hours.
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// The first moment of a local day, in milliseconds since 1970. Found by
// binary search rather than by subtracting an offset, because the offset
// at midnight is what we don't know yet. In the few zones that change
// clocks at 00:00, midnight doesn't exist on that day; the day then
// starts at the change, which is what this returns.
export function localDayStart(date: string, timezone: string): number {
  // Every real offset is within ±14 hours, so the day starts in this
  // range.
  const nominal = new Date(`${date}T00:00:00.000Z`).getTime();
  let lo = nominal - 15 * 60 * MINUTE_MS;
  let hi = nominal + 15 * 60 * MINUTE_MS;
  // Always true in the loop: lo is before the day, hi is inside it or
  // after.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timezone) < date) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Every local day a period touches, in order. A trend needs every day,
// not only days with data, or a quiet day would vanish instead of
// showing as a dip.
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

// The period cut into spans that each have one UTC offset. The spans
// touch without overlapping ([start, end)), because an overlap would
// count a row twice and a gap would drop it. The outer edges are open
// ('' and '9999' sort before and after every timestamp), since the
// query's own `ts BETWEEN @from AND @to` limits the period. The clock
// changes in between are written with toISOString(), the format `ts` is
// stored in, so the text comparison works (see lib/period.ts).
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

  // Step one day at a time. No zone changes its clock twice in a day, so
  // a change between two steps is found by binary search within that day.
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

// Joins each event to the span it falls in, so a query can group by
// local time with `strftime(fmt, ts, span_offset || ' minutes')`. The
// spans are passed as one JSON parameter, @spans (from `localSpans`
// below), so the SQL text stays fixed. The column names have a `span_`
// prefix so they can't clash with columns of `events`, which a segment
// clause added after this uses without a table name.
export const LOCAL_SPANS_CTE = `local_spans AS (
  SELECT json_extract(value, '$.start') AS span_start,
         json_extract(value, '$.end') AS span_end,
         json_extract(value, '$.offset') AS span_offset
  FROM json_each(@spans))`;

export const JOIN_LOCAL_SPANS =
  "JOIN local_spans ON ts >= span_start AND ts < span_end";

// Searches only between the first and last stored row in the period,
// not the bounds asked for: an agent may ask from year 1 (about 740,000
// days), but the rows only cover the time the deployment has run. Finding
// the first and last row takes two quick index lookups.
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
  // No rows to group, so any single span will do.
  if (first === null || last === null) {
    return JSON.stringify([{ start: "", end: "9999", offset: 0 }]);
  }
  return JSON.stringify(offsetSpans(first, last, timezone));
}
