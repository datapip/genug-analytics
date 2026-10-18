import type Database from "better-sqlite3";

// How far back to look to learn the site's usual quiet periods, and how
// much history is needed before trusting it. Two weeks includes several
// quiet nights and weekends; with under three days of data there is not
// enough to judge.
const LOOKBACK_DAYS = 14;
const MIN_HISTORY_DAYS = 3;
// A gap shorter than this is never reported, however busy the site.
// Otherwise a site with an event a minute would be flagged after a
// ten-minute lull, and a warning that fires too often gets ignored.
const MIN_SILENCE_HOURS = 1;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SilenceVerdict =
  "never_seen" | "too_little_to_tell" | "normal" | "longer_than_usual";

export interface Silence {
  // The newest event ever stored (not only within the lookback).
  lastSeen: string | null;
  hoursSince: number | null;
  // The longest gap between two events in the lookback, which ends at
  // lastSeen. So it never includes the gap that is still going on.
  longestEarlierGapHours: number | null;
  verdict: SilenceVerdict;
}

export interface CollectionHealth {
  now: string;
  events: Silence;
  pageViews: Silence;
  eventsLast24h: number;
  rejectedLast24h: number;
}

// Fixed SQL snippets. The event name is passed as a bound parameter,
// never pasted into the SQL.
const ANY_EVENT = "";
const ONE_EVENT = " AND event = @event";

function silence(
  db: Database.Database,
  now: Date,
  event: string | null,
): Silence {
  const filter = event === null ? ANY_EVENT : ONE_EVENT;
  const bound = event === null ? {} : { event };
  const nowIso = now.toISOString();

  const range = db
    .prepare(
      `SELECT MIN(ts) AS first, MAX(ts) AS last
       FROM events
       WHERE ts <= @now${filter}`,
    )
    .get({ now: nowIso, ...bound }) as {
    first: string | null;
    last: string | null;
  };
  if (range.first === null || range.last === null) {
    return {
      lastSeen: null,
      hoursSince: null,
      longestEarlierGapHours: null,
      verdict: "never_seen",
    };
  }

  const hoursSince = (now.getTime() - Date.parse(range.last)) / HOUR_MS;
  // The lookback ends at the last event, not at now. If it ended at now,
  // a site with no events for longer than the lookback would have nothing
  // to learn from and answer too_little_to_tell, exactly when tracking has
  // been broken longest.
  const since = new Date(
    Date.parse(range.last) - LOOKBACK_DAYS * DAY_MS,
  ).toISOString();
  // LAG pairs each event with the one before it; the biggest difference
  // is the longest gap inside the lookback.
  const gap = db
    .prepare(
      `SELECT MAX((julianday(ts) - julianday(prev)) * 24) AS hours
       FROM (
         SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev
         FROM events
         WHERE ts BETWEEN @since AND @last${filter}
       )`,
    )
    .get({ since, last: range.last, ...bound }) as { hours: number | null };

  const historyDays = (now.getTime() - Date.parse(range.first)) / DAY_MS;
  // With fewer than two events there is no gap to measure, and a new
  // deployment hasn't had its usual quiet periods yet.
  const tooLittle = gap.hours === null || historyDays < MIN_HISTORY_DAYS;

  let verdict: SilenceVerdict;
  if (tooLittle) verdict = "too_little_to_tell";
  else if (hoursSince > Math.max(gap.hours!, MIN_SILENCE_HOURS))
    verdict = "longer_than_usual";
  else verdict = "normal";

  return {
    lastSeen: range.last,
    hoursSince: round1(hoursSince),
    longestEarlierGapHours: gap.hours === null ? null : round1(gap.hours),
    verdict,
  };
}

// The newest stored event of any kind, for the cockpit's "last event"
// line. Events dated after now are ignored, as in silence(): a clock that
// was set back can leave such rows, and they would read as events still
// to come.
export function getLastEventAt(
  db: Database.Database,
  now: Date,
): string | null {
  const { last } = db
    .prepare(`SELECT MAX(ts) AS last FROM events WHERE ts <= @now`)
    .get({ now: now.toISOString() }) as { last: string | null };
  return last;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Whether events are still arriving, judged against the site's own
// history. A fixed rule like "no events in 24 hours" is wrong both ways:
// a busy shop is broken after one quiet hour, while a small site is often
// quiet all weekend. Page views are checked separately (the caller passes
// the page-view event's name), because automatic page tracking can break
// while custom events keep arriving.
export function getCollectionHealth(
  db: Database.Database,
  now: Date,
  pageViewEvent: string,
): CollectionHealth {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const { events } = db
    .prepare(
      `SELECT COUNT(*) AS events FROM events WHERE ts BETWEEN @dayAgo AND @now`,
    )
    .get({ dayAgo, now: nowIso }) as { events: number };
  const { rejected } = db
    .prepare(
      `SELECT COUNT(*) AS rejected FROM rejected_events
       WHERE ts BETWEEN @dayAgo AND @now`,
    )
    .get({ dayAgo, now: nowIso }) as { rejected: number };

  return {
    now: nowIso,
    events: silence(db, now, null),
    pageViews: silence(db, now, pageViewEvent),
    eventsLast24h: events,
    rejectedLast24h: rejected,
  };
}
