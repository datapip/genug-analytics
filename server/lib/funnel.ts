import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { roundTo } from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";

// Whether a funnel is followed per session or per visitor. Session is
// the default because it works for every visitor: without consent a
// visitor_id changes at the site's midnight (see "Visitor
// identification" in docs/decisions.md), so a per-visitor funnel would
// lose anyone who viewed at 23:50 and bought at 00:10, and could never
// span several days. Per visitor is for sites with consent, where the id
// lasts and "viewed on Monday, bought on Thursday" can be answered.
export type FunnelScope = "session" | "visitor";

// The column for each scope. Looked up here so the SQL only ever
// contains one of these two fixed names, never the caller's value.
const SCOPE_COLUMN: Record<FunnelScope, string> = {
  session: "session_id",
  visitor: "visitor_id",
};

export interface FunnelStep {
  event: string;
  // Sessions or visitors (depending on the scope) that reached this
  // step. The MCP tool renames the field to say which.
  reached: number;
  // Share of the first step's count that reached this step, from 0 to
  // 1. Always 1 for the first step.
  conversionRate: number;
}

// A step only counts if it happened after the previous step; doing the
// steps out of order doesn't count as moving through the funnel.
// The ids still in the funnel are passed to advanceFunnelStep as one
// JSON array, not one parameter per id. SQLite allows at most 32,766
// parameters per statement, and 30 days of a site with about 1,100
// visitors a day (each a new id every day without consent) is more.
export function getStepsFunnel(
  db: Database.Database,
  steps: string[],
  period: Period,
  scope: FunnelScope = "session",
  segment: SegmentClause = NO_SEGMENT,
): FunnelStep[] {
  if (steps.length === 0) return [];
  const column = SCOPE_COLUMN[scope];

  // The segment decides who enters the funnel. Later steps only look
  // at those ids, so the segment is applied once, here.
  const firstStepRows = db
    .prepare(
      `SELECT ${column} AS key, MIN(ts) AS ts
       FROM events
       WHERE event = @event AND ts BETWEEN @from AND @to${segment.sql}
       GROUP BY ${column}`,
    )
    .all({
      event: steps[0],
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    key: string;
    ts: string;
  }[];

  let current = new Map(firstStepRows.map((row) => [row.key, row.ts]));
  const starting = current.size;
  const results: FunnelStep[] = [
    { event: steps[0]!, reached: current.size, conversionRate: 1 },
  ];

  for (let i = 1; i < steps.length; i++) {
    current = advanceFunnelStep(db, steps[i]!, period, current, column);
    results.push({
      event: steps[i]!,
      reached: current.size,
      // Rounded, so the agent gets 0.3333 rather than
      // 0.33333333333333331.
      conversionRate: starting === 0 ? 0 : roundTo(current.size / starting, 4),
    });
  }

  return results;
}

// Takes the ids still in the funnel (session or visitor id -> when they
// reached the previous step) and returns those that did `event` after
// that, each with the time they first did it.
function advanceFunnelStep(
  db: Database.Database,
  event: string,
  period: Period,
  current: Map<string, string>,
  column: string,
): Map<string, string> {
  const keys = [...current.keys()];
  if (keys.length === 0) return new Map();

  // json_each turns the array into rows SQLite can join with, so all
  // ids together take one parameter, however many there are.
  const rows = db
    .prepare(
      `SELECT ${column} AS key, ts
       FROM events
       WHERE event = ? AND ts BETWEEN ? AND ?
         AND ${column} IN (SELECT value FROM json_each(?))
       ORDER BY ts ASC`,
    )
    .all(event, period.from, period.to, JSON.stringify(keys)) as {
    key: string;
    ts: string;
  }[];

  const timestampsByKey = new Map<string, string[]>();
  for (const row of rows) {
    const list = timestampsByKey.get(row.key) ?? [];
    list.push(row.ts);
    timestampsByKey.set(row.key, list);
  }

  const next = new Map<string, string>();
  for (const [key, previousTs] of current) {
    // Rows are sorted by time, so the first one after previousTs is the
    // earliest time this id did this step. "After" is strict: two events
    // in the same millisecond don't count as in order. That is rare,
    // since the server sets each event's time as it arrives.
    const qualifyingTs = timestampsByKey
      .get(key)
      ?.find((ts) => ts > previousTs);
    if (qualifyingTs !== undefined) next.set(key, qualifyingTs);
  }
  return next;
}
