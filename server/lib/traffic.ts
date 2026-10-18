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

// Queries about how much traffic there was and when: totals, per day,
// per weekday, per hour. Used by mcp/traffic.ts.
//
// Every query takes an optional segment (lib/segment.ts) and adds its
// condition to the WHERE, so "traffic from mobile" is the same query
// with a segment, not a separate tool.

export interface TrafficSummary {
  sessions: number;
  // Distinct visitor_ids. Over several days, a visitor without consent
  // counts once per day they came, because their id changes daily (see
  // "Visitor identification" in docs/decisions.md). The tool
  // description says so.
  visitors: number;
  // Every event that is not a page view. Together with viewEvents it adds
  // up to all events.
  interactionEvents: number;
  // The number of page views. There is always a page-view event (see
  // the schema registry), so zero really means no page views.
  viewEvents: number;
}

export function getTrafficSummary(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficSummary {
  // One pass over the rows: page views are counted with a condition next
  // to the totals, not in a second query.
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT session_id) AS sessions,
         COUNT(DISTINCT visitor_id) AS visitors,
         COUNT(*) AS total,
         COUNT(CASE WHEN event = @pageViewEvent THEN 1 END) AS viewEvents
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}`,
    )
    .get({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    sessions: number;
    visitors: number;
    total: number;
    viewEvents: number;
  };

  return {
    sessions: row.sessions,
    visitors: row.visitors,
    interactionEvents: row.total - row.viewEvents,
    viewEvents: row.viewEvents,
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

// Shared by the per-day, per-weekday and per-hour queries: combines the
// totals with the page-view counts and splits them as getTrafficSummary
// does. Each query keeps its own SQL, because passing the strftime()
// expression in would mean building SQL from a variable, which this
// project avoids.
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

// The same fields as getTrafficSummary, per day. Days are in the site's
// time zone (lib/timezone.ts), and days without events are included as
// zero, so a quiet day shows as a dip instead of disappearing. A day
// with a clock change lasts 23 or 25 hours, which shows as a small dip
// or bump.
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

// Returned Monday first (SQLite starts on Sunday), as a work week is
// usually read.
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface TrafficByDayOfWeek extends TrafficCounts {
  day: string; // "Monday".."Sunday"
}

// The weekday in the site's time zone, not the visitor's, because the
// owner reads the result in their own calendar.
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

// The hour in the site's time zone, not the visitor's. When clocks go
// back, two real hours fall into one hour; when they go forward, one
// hour is empty. Over more than a few days that hardly matters, and the
// tool description says so.
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
  // Time from first to last event, averaged over all sessions. A session
  // with one event counts as 0 seconds.
  averageSeconds: number;
  // How many of those sessions viewed at least one page: the basis of the
  // bounce rate. A session with only custom events never viewed a page,
  // so it can't have bounced.
  sessionsWithViews: number;
  // Sessions with only one page view, as getBouncePages counts them per
  // page, for the whole site.
  bounced: number;
  // bounced / sessionsWithViews, 0-1.
  bounceRate: number;
}

// Numbers that need the whole session: duration and bounce rate, over
// sessions that started in the period. They are computed when queried
// (see "Project maturity" in docs/decisions.md). Adding up
// getBouncePages' rows would not give the site-wide bounce rate, because
// that list is cut off.
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
