import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { roundTo } from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";
import {
  enumerateDays,
  JOIN_LOCAL_SPANS,
  LOCAL_SPANS_CTE,
  localSpans,
} from "./timezone.js";

// "How much traffic, and when" — aggregate activity over a period,
// however it's bucketed. Pairs with mcp/traffic.ts, which exposes these.
//
// Every query takes an optional segment (lib/segment.ts) and pastes its
// clause into the WHERE, so "traffic from mobile" or "sessions that
// bought X" is the same query narrowed, not a second tool.

export interface TrafficSummary {
  sessions: number;
  // Distinct visitor_ids. The first number anyone asks for, and the one
  // this shape lacked for longest: it hid inside the consent and
  // new-vs-returning splits. Over a multi-day period a consentless
  // visitor counts once per day they came (daily-rotating id, see
  // "Visitor identification" in docs/decisions.md); the description
  // says so rather than leaving the number out.
  visitors: number;
  // Every event that ISN'T the page-view event — deliberately not the
  // full total, so this and viewEvents are additive (sum to everything
  // that happened) instead of viewEvents being a confusing subset of an
  // "events" field that already included it.
  interactionEvents: number;
  // Count of the page-view event specifically. Always present: exactly
  // one registered event carries the pageView tag (see the schema
  // registry), so zero here honestly means zero page views.
  viewEvents: number;
}

export function getTrafficSummary(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficSummary {
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(DISTINCT visitor_id) AS visitors,
         COUNT(*) AS total
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}`,
    )
    .get({ from: period.from, to: period.to, ...segment.params }) as {
    sessions: number;
    visitors: number;
    total: number;
  };

  const viewEventsRow = db
    .prepare(
      `SELECT COUNT(*) AS viewEvents
       FROM events
       WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}`,
    )
    .get({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    viewEvents: number;
  };

  return {
    sessions: row.sessions,
    visitors: row.visitors,
    interactionEvents: row.total - viewEventsRow.viewEvents,
    viewEvents: viewEventsRow.viewEvents,
  };
}

interface TrafficCounts {
  sessions: number;
  visitors: number;
  interactionEvents: number;
  viewEvents: number;
}

interface BucketTotals<K> {
  bucket: K;
  sessions: number;
  visitors: number;
  total: number;
}

// Holds the one rule the three bucketed queries below share: pair the
// totals with the optional page-view counts, then split them additively
// the way getTrafficSummary does. Their SQL stays written out per
// function — passing the strftime() expression in would mean building
// SQL text from a variable, which this project avoids even for
// hardcoded values (see getEntryPages, lib/retention.ts).
function bucketedCounts<K>(
  totals: BucketTotals<K>[],
  viewEvents: { bucket: K; count: number }[],
): (bucket: K) => TrafficCounts {
  const totalsByBucket = new Map(totals.map((row) => [row.bucket, row]));
  const viewsByBucket = new Map(
    viewEvents.map((row) => [row.bucket, row.count]),
  );

  return (bucket) => {
    const sessions = totalsByBucket.get(bucket)?.sessions ?? 0;
    const visitors = totalsByBucket.get(bucket)?.visitors ?? 0;
    const total = totalsByBucket.get(bucket)?.total ?? 0;
    const views = viewsByBucket.get(bucket) ?? 0;
    return {
      sessions,
      visitors,
      interactionEvents: total - views,
      viewEvents: views,
    };
  };
}

export interface TrafficByDay extends TrafficCounts {
  date: string; // YYYY-MM-DD, in the site's zone
}

// Same additive interactionEvents/viewEvents shape as getTrafficSummary,
// just bucketed by day, so an agent that learned that vocabulary from
// get_traffic_summary doesn't need a second one here. Days are calendar
// days in the site's zone (lib/timezone.ts) and zero-filled, so a quiet
// day reads as a dip rather than vanishing from the series. A day with
// a clock change lasts 23 or 25 hours and reads as a small dip or bump.
export function getTrafficByDay(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  timezone: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByDay[] {
  const spans = localSpans(db, period, timezone);
  const totals = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT strftime('%Y-%m-%d', ts, span_offset || ' minutes') AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events ${JOIN_LOCAL_SPANS}
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<string>[];

  const viewEvents = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT strftime('%Y-%m-%d', ts, span_offset || ' minutes') AS bucket, COUNT(*) AS count
             FROM events ${JOIN_LOCAL_SPANS}
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    bucket: string;
    count: number;
  }[];

  const counts = bucketedCounts(totals, viewEvents);
  return enumerateDays(period.from, period.to, timezone).map((date) => ({
    date,
    ...counts(date),
  }));
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]; // index matches SQLite's strftime('%w', …): 0 = Sunday

// Displayed Monday-first, not Sunday-first (SQLite's own order) — the
// conventional business-week reading for "which days get the most
// traffic".
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface TrafficByDayOfWeek extends TrafficCounts {
  day: string; // "Monday".."Sunday"
}

// The weekday in the site's zone, not the visitor's: a visitor in
// another zone near midnight lands on the site's weekday, which is the
// calendar the owner reads the result in.
export function getTrafficByDayOfWeek(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  timezone: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByDayOfWeek[] {
  const spans = localSpans(db, period, timezone);
  const totals = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT CAST(strftime('%w', ts, span_offset || ' minutes') AS INTEGER) AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events ${JOIN_LOCAL_SPANS}
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<number>[];

  const viewEvents = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT CAST(strftime('%w', ts, span_offset || ' minutes') AS INTEGER) AS bucket, COUNT(*) AS count
             FROM events ${JOIN_LOCAL_SPANS}
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    bucket: number;
    count: number;
  }[];

  const counts = bucketedCounts(totals, viewEvents);
  return WEEKDAY_DISPLAY_ORDER.map((dow) => ({
    day: WEEKDAY_NAMES[dow]!,
    ...counts(dow),
  }));
}

export interface TrafficByHour extends TrafficCounts {
  hour: number; // 0-23, in the site's zone
}

// The hour in the site's zone, not the visitor's. Where clocks change,
// the fall-back night puts two real hours into one bucket and the
// spring-forward night leaves one empty; over any period longer than a
// few days that is noise, and the tool description says so.
export function getTrafficByHour(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  timezone: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByHour[] {
  const spans = localSpans(db, period, timezone);
  const totals = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT CAST(strftime('%H', ts, span_offset || ' minutes') AS INTEGER) AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events ${JOIN_LOCAL_SPANS}
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<number>[];

  const viewEvents = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT CAST(strftime('%H', ts, span_offset || ' minutes') AS INTEGER) AS bucket, COUNT(*) AS count
             FROM events ${JOIN_LOCAL_SPANS}
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
      spans,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    bucket: number;
    count: number;
  }[];

  const counts = bucketedCounts(totals, viewEvents);
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    ...counts(hour),
  }));
}

export interface SessionSummary {
  // Sessions that started in the period.
  sessions: number;
  // First event to last, averaged over all of them. A single-event
  // session is 0 seconds, not excluded.
  averageSeconds: number;
  // Of those sessions, how many viewed at least one page — the
  // denominator of the bounce rate. A session made only of custom
  // events never entered on a page, so it can't have bounced off one.
  sessionsWithViews: number;
  // Sessions whose only page view was their first: the same definition
  // getBouncePages uses per entry page, summed site-wide.
  bounced: number;
  // bounced / sessionsWithViews, 0-1.
  bounceRate: number;
}

// The session-shaped numbers, in one place: duration and bounce are
// both "read the whole session, once it's over" — necessarily
// query-time aggregates (see "Project maturity" in docs/decisions.md)
// over sessions that started in the period. The site-wide bounce rate
// lived nowhere before; summing getBouncePages' top rows gave a wrong
// total the moment a page fell off the list.
export function getSessionSummary(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): SessionSummary {
  const rows = db
    .prepare(
      `SELECT MIN(ts) AS start, MAX(ts) AS end,
              SUM(event = @pageViewEvent) AS views
       FROM events
       WHERE ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    start: string;
    end: string;
    views: number;
  }[];

  if (rows.length === 0) {
    return {
      sessions: 0,
      averageSeconds: 0,
      sessionsWithViews: 0,
      bounced: 0,
      bounceRate: 0,
    };
  }

  let totalSeconds = 0;
  let sessionsWithViews = 0;
  let bounced = 0;
  for (const row of rows) {
    totalSeconds += (Date.parse(row.end) - Date.parse(row.start)) / 1000;
    if (row.views >= 1) sessionsWithViews += 1;
    if (row.views === 1) bounced += 1;
  }

  return {
    sessions: rows.length,
    averageSeconds: Math.round(totalSeconds / rows.length),
    sessionsWithViews,
    bounced,
    bounceRate:
      sessionsWithViews === 0 ? 0 : roundTo(bounced / sessionsWithViews, 4),
  };
}

export function hasAnyEvents(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT EXISTS(SELECT 1 FROM events) AS present`)
    .get() as { present: number };
  return row.present === 1;
}
