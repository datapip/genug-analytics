import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { roundTo } from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

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

// Shared by every day-bucketed query: a trend needs every day present,
// not just the ones that happen to have data, or a quiet day silently
// disappears instead of showing as a dip.
export function enumerateDays(fromIso: string, toIso: string): string[] {
  const cursor = new Date(fromIso);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toIso);
  end.setUTCHours(0, 0, 0, 0);

  const days: string[] = [];
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
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
  date: string; // YYYY-MM-DD, UTC
}

// Same additive interactionEvents/viewEvents shape as getTrafficSummary,
// just bucketed by day, so an agent that learned that vocabulary from
// get_traffic_summary doesn't need a second one here. Days are UTC
// calendar days (see "Data model" in docs/decisions.md) and zero-filled, so a
// quiet day reads as a dip rather than vanishing from the series.
export function getTrafficByDay(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByDay[] {
  const totals = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts) AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<string>[];

  const viewEvents = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts) AS bucket, COUNT(*) AS count
             FROM events
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    bucket: string;
    count: number;
  }[];

  const counts = bucketedCounts(totals, viewEvents);
  return enumerateDays(period.from, period.to).map((date) => ({
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
]; // index matches SQLite's strftime('%w', ts): 0 = Sunday

// Displayed Monday-first, not Sunday-first (SQLite's own order) — the
// conventional business-week reading for "which days get the most
// traffic".
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface TrafficByDayOfWeek extends TrafficCounts {
  day: string; // "Monday".."Sunday"
}

// Same UTC caveat as getTrafficByDay (see "Data model" in docs/decisions.md):
// a day-of-week bucket is which UTC day an event landed on, not the
// visitor's own local weekday — for a deployment whose visitors are far
// from UTC, traffic near midnight local time can land in the "wrong"
// UTC weekday bucket.
export function getTrafficByDayOfWeek(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByDayOfWeek[] {
  const totals = db
    .prepare(
      `SELECT CAST(strftime('%w', ts) AS INTEGER) AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<number>[];

  const viewEvents = db
    .prepare(
      `SELECT CAST(strftime('%w', ts) AS INTEGER) AS bucket, COUNT(*) AS count
             FROM events
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
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
  hour: number; // 0-23, UTC
}

// UTC, not the visitor's local hour — far more noticeable here than for
// day-of-week or day bucketing: "peak traffic at 14:00" only means the
// site owner's local peak hour if they happen to be near UTC. Documented
// here rather than solved (see docs/decisions.md's "Day-bucketing is UTC only"
// for why: strftime can't group by an IANA zone, only a fixed offset
// that breaks across DST).
export function getTrafficByHour(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): TrafficByHour[] {
  const totals = db
    .prepare(
      `SELECT CAST(strftime('%H', ts) AS INTEGER) AS bucket,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS total
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY bucket`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as BucketTotals<number>[];

  const viewEvents = db
    .prepare(
      `SELECT CAST(strftime('%H', ts) AS INTEGER) AS bucket, COUNT(*) AS count
             FROM events
             WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
             GROUP BY bucket`,
    )
    .all({
      pageViewEvent,
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
