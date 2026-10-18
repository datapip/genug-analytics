import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import {
  rank,
  rankSessionsBy,
  mapRanked,
  roundTo,
  type Ranked,
} from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";
import {
  enumerateDays,
  JOIN_LOCAL_SPANS,
  LOCAL_SPANS_CTE,
  localSpans,
} from "./timezone.js";

// Queries about events and their props (what happened), as opposed to
// pages (content.ts). Used by mcp/events.ts.
//
// Every query takes an optional segment (lib/segment.ts) and adds its
// condition to the WHERE: "orders from visitors who came from Google" is
// getPropertySum with a segment, not a separate query.

export interface TopEvent {
  event: string;
  events: number;
}

// Counts every event type, including page views.
export function getTopEvents(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<TopEvent> {
  const rows = db
    .prepare(
      `SELECT event, COUNT(*) AS events
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY event`,
    )
    .all({ from: period.from, to: period.to, ...segment.params }) as TopEvent[];
  return rank(rows, (row) => row.events, limit);
}

export interface EventTrendDay {
  date: string; // YYYY-MM-DD, in the site's zone
  events: number;
  sessions: number;
  visitors: number;
}

// One event per day: "did signups grow this month?". Uses the same local
// days as getTrafficByDay, with days without events filled in as zero,
// and counts the same way: a session or visitor active on two days
// counts on both.
export function getEventTrend(
  db: Database.Database,
  event: string,
  period: Period,
  timezone: string,
  segment: SegmentClause = NO_SEGMENT,
): EventTrendDay[] {
  const rows = db
    .prepare(
      `WITH ${LOCAL_SPANS_CTE}
       SELECT strftime('%Y-%m-%d', ts, span_offset || ' minutes') AS date,
              COUNT(*) AS events,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors
       FROM events ${JOIN_LOCAL_SPANS}
       WHERE event = @event AND ts BETWEEN @from AND @to${segment.sql}
       GROUP BY date`,
    )
    .all({
      event,
      spans: localSpans(db, period, timezone),
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as EventTrendDay[];

  const byDate = new Map(rows.map((row) => [row.date, row]));
  return enumerateDays(period.from, period.to, timezone).map(
    (date) => byDate.get(date) ?? { date, events: 0, sessions: 0, visitors: 0 },
  );
}

export interface EntryEvent {
  event: string;
  sessions: number;
}

// Ranks the first event of each session by event type, not by page. For
// sites where the url hardly changes (such as a single-page app that
// never updates the address bar), getEntryPages says little. Works for
// any events, with or without page views.
export function getEntryEvents(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<EntryEvent> {
  const rows = db
    .prepare(
      `SELECT event, MIN(ts) AS first_ts
       FROM events
       WHERE ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({ from: period.from, to: period.to, ...segment.params }) as {
    event: string;
  }[];

  return mapRanked(
    rankSessionsBy(rows, (row) => row.event, limit),
    ({ key, sessions }) => ({ event: key, sessions }),
  );
}

export interface ExitEvent {
  event: string;
  sessions: number;
}

// Same as getEntryEvents, but for the last event of each session.
export function getExitEvents(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<ExitEvent> {
  const rows = db
    .prepare(
      `SELECT event, MAX(ts) AS last_ts
       FROM events
       WHERE ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({ from: period.from, to: period.to, ...segment.params }) as {
    event: string;
  }[];

  return mapRanked(
    rankSessionsBy(rows, (row) => row.event, limit),
    ({ key, sessions }) => ({ event: key, sessions }),
  );
}

// Only lowercase letters, digits and underscores, the same rule the
// schema registry applies to prop names. This keeps the json_extract
// path below simple. It isn't a security check: the path is passed as a
// bound parameter, never pasted into the SQL.
const PROPERTY_KEY_PATTERN = /^[a-z0-9_]+$/;

export function isValidPropertyKey(key: string): boolean {
  return PROPERTY_KEY_PATTERN.test(key);
}

export interface PropertyBreakdown {
  value: unknown;
  events: number;
}

// Counts one event type grouped by the value of one of its props, for
// example product_added_to_cart grouped by product_id. Rows without the
// prop are left out, not counted under "null".
export function getEventsByProperty(
  db: Database.Database,
  event: string,
  propertyKey: string,
  period: Period,
  limit: number,
  isList = false,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<PropertyBreakdown> {
  const jsonPath = `$.${propertyKey}`;
  const rows = db
    .prepare(
      (isList ? LIST_BREAKDOWN_SQL : SCALAR_BREAKDOWN_SQL) +
        segment.sql +
        GROUP_BY_VALUE,
    )
    .all({
      jsonPath,
      event,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as PropertyBreakdown[];
  return rank(rows, (row) => row.events, limit);
}

// The segment condition goes between WHERE and GROUP BY, so both
// queries end at their WHERE and share this GROUP BY.
const GROUP_BY_VALUE = `
   GROUP BY value`;

const SCALAR_BREAKDOWN_SQL = `SELECT json_extract(props, @jsonPath) AS value, COUNT(*) AS events
   FROM events
   WHERE event = @event
     AND ts BETWEEN @from AND @to
     AND json_extract(props, @jsonPath) IS NOT NULL`;

// A list prop holds several values in one row. json_extract would
// return the whole array as one string, so ["a","b"] and ["b","a"] would
// be two different values. json_each turns the array into one row per
// value instead.
//
// COUNT(DISTINCT events.id), not COUNT(*), counts events that contain a
// value, so an event repeating a tag counts once for it. The counts can
// add up to more than the number of events, since one event can have
// several values; get_events_by_property's description says so.
const LIST_BREAKDOWN_SQL = `SELECT je.value AS value, COUNT(DISTINCT events.id) AS events
   FROM events, json_each(json_extract(events.props, @jsonPath)) je
   WHERE event = @event
     AND ts BETWEEN @from AND @to`;

export interface PropertySum {
  sum: number;
  average: number;
  // How many values were summed, which is what `average` divides by. One
  // per event for a normal prop, one per value for a list prop.
  values: number;
}

// Sum and average of a number prop over the period, for example the
// total and average revenue from order_completed's value prop. The caller
// (mcp/events.ts) must check that the prop is a number first: SUM over a
// text prop returns 0 instead of an error. Rows without the prop are
// left out of the sum, the average and the count.
export function getPropertySum(
  db: Database.Database,
  event: string,
  propertyKey: string,
  period: Period,
  isList = false,
  segment: SegmentClause = NO_SEGMENT,
): PropertySum {
  const jsonPath = `$.${propertyKey}`;
  const row = db
    .prepare((isList ? LIST_SUM_SQL : SCALAR_SUM_SQL) + segment.sql)
    .get({
      jsonPath,
      event,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    sum: number | null;
    average: number | null;
    value_count: number;
  };

  // SUM and AVG return NULL when no row matched. Return 0 instead, which
  // clearly reads as "no matching events".
  return {
    sum: roundTo(row.sum ?? 0, 2),
    average: roundTo(row.average ?? 0, 2),
    values: row.value_count,
  };
}

// `value_count`, not `values`: VALUES is an SQL keyword.
const SCALAR_SUM_SQL = `SELECT
     SUM(json_extract(props, @jsonPath)) AS sum,
     AVG(json_extract(props, @jsonPath)) AS average,
     COUNT(*) AS value_count
   FROM events
   WHERE event = @event
     AND ts BETWEEN @from AND @to
     AND json_extract(props, @jsonPath) IS NOT NULL`;

// Uses json_each like the breakdown above. The count is of values, not
// events: one event with three prices counts three. That keeps
// sum / values === average, as a reader would expect; the tool
// description says what the count means.
const LIST_SUM_SQL = `SELECT
     SUM(je.value) AS sum,
     AVG(je.value) AS average,
     COUNT(*) AS value_count
   FROM events, json_each(json_extract(events.props, @jsonPath)) je
   WHERE event = @event
     AND ts BETWEEN @from AND @to`;

// How many rows each event name has, over all time. Unlike getTopEvents
// it has no period, because it answers "how many rows would a rename
// move?".
//
// A plain object, because the cockpit looks names up in it.
export function getStoredEventCounts(
  db: Database.Database,
): Record<string, number> {
  const rows = db
    .prepare(`SELECT event, COUNT(*) AS events FROM events GROUP BY event`)
    .all() as TopEvent[];

  const counts: Record<string, number> = {};
  for (const { event, events } of rows) counts[event] = events;
  return counts;
}

// The number of rows stored under one event name, over all time. Used
// when creating or editing that event.
export function countStored(db: Database.Database, event: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE event = ?`)
    .get(event) as { count: number };
  return row.count;
}
