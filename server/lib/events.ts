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
import { enumerateDays } from "./traffic.js";

// "What happened" — keyed on event types and their props rather than on
// pages, so unlike content.ts nothing here needs a page-view event to
// exist. Pairs with mcp/events.ts.
//
// Every query takes an optional segment (lib/segment.ts) and pastes its
// clause into the WHERE: "orders from visitors who came from Google" is
// getPropertySum narrowed, not a second query.

export interface TopEvent {
  event: string;
  events: number;
}

// Every event type, not just page_view — get_top_pages already covers
// page views specifically; this is the "what's actually happening"
// breakdown across everything a deployment tracks.
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
  date: string; // YYYY-MM-DD, UTC
  events: number;
  sessions: number;
  visitors: number;
}

// One event over time: "did signups grow this month". getTrafficByDay
// covers everything together and a segment gives one number for the
// whole period, so before this a single event had no trend at all.
// Same UTC calendar days and zero-fill as getTrafficByDay, and the same
// per-day counting: a session or visitor active on two days is in both.
export function getEventTrend(
  db: Database.Database,
  event: string,
  period: Period,
  segment: SegmentClause = NO_SEGMENT,
): EventTrendDay[] {
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts) AS date,
              COUNT(*) AS events,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors
       FROM events
       WHERE event = @event AND ts BETWEEN @from AND @to${segment.sql}
       GROUP BY date`,
    )
    .all({
      event,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as EventTrendDay[];

  const byDate = new Map(rows.map((row) => [row.date, row]));
  return enumerateDays(period.from, period.to).map(
    (date) => byDate.get(date) ?? { date, events: 0, sessions: 0, visitors: 0 },
  );
}

export interface EntryEvent {
  event: string;
  sessions: number;
}

// Ranks by event TYPE, not page — for deployments where the url barely
// varies (e.g. a single-page app that never updates the address bar)
// and getEntryPages' path-based grouping would be meaningless. Not
// gated behind a pageView-tagged event at all, unlike getEntryPages —
// there's no "page" concept involved, just event names, so this works
// for every deployment regardless of whether page views are tracked.
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

// Same as getEntryEvents, but the event type with the latest ts per
// session.
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

// Only lowercase letters, digits, and underscores — the schema
// registry's checker enforces the same rule on every declared prop
// name. Rejecting anything else keeps the json_extract path below
// predictable, not a safety mechanism: it's passed as a bound
// parameter, not concatenated into the SQL text, so it was never an
// injection risk either way.
const PROPERTY_KEY_PATTERN = /^[a-z0-9_]+$/;

export function isValidPropertyKey(key: string): boolean {
  return PROPERTY_KEY_PATTERN.test(key);
}

export interface PropertyBreakdown {
  value: unknown;
  events: number;
}

// Counts one event type's occurrences grouped by one of its own prop
// values — the generic "break this event down by any dimension it
// declares" tool, e.g. product_added_to_cart grouped by product_id.
// Rows where the property is absent (json_extract returns NULL) are
// excluded rather than grouped under a "null" bucket.
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

// The segment clause goes between the WHERE and the GROUP BY, so the
// two statements end at their WHERE and share the GROUP BY.
const GROUP_BY_VALUE = `
   GROUP BY value`;

const SCALAR_BREAKDOWN_SQL = `SELECT json_extract(props, @jsonPath) AS value, COUNT(*) AS events
   FROM events
   WHERE event = @event
     AND ts BETWEEN @from AND @to
     AND json_extract(props, @jsonPath) IS NOT NULL`;

// A list prop holds several values in one row, and json_extract hands
// the whole array back as one opaque string — grouping by it would
// group by the entire array, so ["a","b"] and ["b","a"] would be two
// different "values". json_each expands the array into one row per
// value instead, which is what makes a list queryable at all.
//
// COUNT(DISTINCT events.id), not COUNT(*): it counts *events containing
// a value*, so an event that repeats one tag doesn't inflate that tag's
// number. The counts still sum to more than the number of events, since
// each event contributes to several of them — get_events_by_property's
// description says so, because a total that exceeds the event count
// otherwise reads as a bug.
const LIST_BREAKDOWN_SQL = `SELECT je.value AS value, COUNT(DISTINCT events.id) AS events
   FROM events, json_each(json_extract(events.props, @jsonPath)) je
   WHERE event = @event
     AND ts BETWEEN @from AND @to`;

export interface PropertySum {
  sum: number;
  average: number;
  // Values that went into the sum, i.e. what `average` is over. One per
  // event for an ordinary prop; one per value for a list prop.
  values: number;
}

// SUM/AVG twin of getEventsByProperty — instead of grouping occurrences by a
// prop's distinct values, aggregates the prop's own numeric value across
// every occurrence in the period (e.g. total/average revenue from an
// order_completed event's value prop). The caller (mcp/events.ts) is
// responsible for checking the property is actually numeric before
// calling this — SUM/AVG over a non-numeric prop would just silently
// return 0, the same "should look like a mistake" concern get_events_by_property
// avoids via registry validation. Rows where the property is absent are
// excluded from sum, average, and count alike, same as getEventsByProperty.
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

  // SUM/AVG return SQL NULL, not 0, when no row matched — an explicit
  // zero reads clearly as "no matching events," same reasoning as
  // getSessionSummary's zero-data case.
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

// Same json_each expansion as the breakdown above. The count is of
// *values* summed, not of events — one event carrying three prices
// contributes three. That keeps sum / values === average, which is the
// property a reader will assume holds; the tool description says which
// unit the count is in.
const LIST_SUM_SQL = `SELECT
     SUM(je.value) AS sum,
     AVG(je.value) AS average,
     COUNT(*) AS value_count
   FROM events, json_each(json_extract(events.props, @jsonPath)) je
   WHERE event = @event
     AND ts BETWEEN @from AND @to`;

// How many rows each event name holds, all time and unranked. Distinct
// from getTopEvents, which is period-scoped and ranked: this answers
// "how much history would a rename move", and a period-scoped answer
// would understate it by however much predates the window.
//
// Returned as a plain object because the cockpit looks names up in it
// rather than iterating, and because every caller wants a total that is
// zero for an event nothing has ever fired.
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
