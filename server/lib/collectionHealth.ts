import type Database from "better-sqlite3";

// How far back "the usual silence" is learned from, and how much history
// there must be before it is believed. Two weeks holds a quiet weekend
// and a quiet night several times over; under three days of data the
// longest gap seen is just the gap since the site started.
const LOOKBACK_DAYS = 14;
const MIN_HISTORY_DAYS = 3;
// A silence shorter than this is never called unusual, however busy the
// site: on one that gets an event a minute, a ten-minute lull would
// otherwise be flagged, and an alert that cries wolf gets ignored.
const MIN_SILENCE_HOURS = 1;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SilenceVerdict =
  "never_seen" | "too_little_to_tell" | "normal" | "longer_than_usual";

export interface Silence {
  // The newest one stored, over all time (not only the lookback).
  lastSeen: string | null;
  hoursSince: number | null;
  // The longest quiet stretch between two events in the lookback,
  // not counting the one that is still going on.
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

// Fixed fragments, never built from a value: the name is bound.
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
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString();
  // LAG pairs each event with the one before it; the biggest difference
  // is the longest silence the site has had inside the window.
  const gap = db
    .prepare(
      `SELECT MAX((julianday(ts) - julianday(prev)) * 24) AS hours
       FROM (
         SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev
         FROM events
         WHERE ts BETWEEN @since AND @now${filter}
       )`,
    )
    .get({ since, now: nowIso, ...bound }) as { hours: number | null };

  const historyDays = (now.getTime() - Date.parse(range.first)) / DAY_MS;
  // Fewer than two events in the window leaves no gap to learn from, and
  // a young deployment has not yet had its usual quiet stretches.
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Is tracking still arriving, judged against the site's own history —
// not a fixed "no events in 24 hours" threshold, which is wrong in both
// directions: a busy shop is broken after one quiet hour, and a small
// site's ordinary weekend is not. The page-view event is passed in by
// the caller (never hardcoded; see pageViewEventType) and judged on its
// own, because the script can lose its automatic page tracking while
// custom events keep arriving.
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
