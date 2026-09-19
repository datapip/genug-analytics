import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { roundTo } from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";

// Whether a funnel is walked per session or per visitor. Session is
// the default because it is the only scope that is correct for every
// visitor: a consentless visitor_id rotates at UTC midnight (see
// "Visitor identification" in docs/decisions.md), so a visitor-scoped
// funnel silently loses anyone who viewed at 23:50 and bought at 00:10,
// and can never span days at all. Visitor scope is for consentful
// deployments, where a persistent id makes "viewed a product on Monday,
// bought on Thursday" a real question — the one this tool was first
// written for, before it was clear that the default mode couldn't
// answer it.
export type FunnelScope = "session" | "visitor";

// The column each scope is keyed on. A lookup rather than interpolating
// the caller's value: the scope is typed, but the SQL below still only
// ever sees one of these two literals.
const SCOPE_COLUMN: Record<FunnelScope, string> = {
  session: "session_id",
  visitor: "visitor_id",
};

export interface FunnelStep {
  event: string;
  // Sessions or visitors that reached this step, per the scope. The
  // MCP layer names the field for the unit; here it is one shape.
  reached: number;
  // Share of the first step's count that reached this step, 0-1.
  // Always 1 for the first step itself.
  conversionRate: number;
}

// A step only counts if it happened *after* the qualifying timestamp
// for the previous step — reaching steps out of order doesn't count as
// progressing through the funnel.
// The key set is passed to advanceFunnelStep as a single JSON array
// rather than one bound parameter per id. SQLite caps a statement at
// SQLITE_MAX_VARIABLE_NUMBER (32,766 by default), so an IN list built
// from the set used to throw "too many SQL variables" at the agent past
// roughly 33,000 keys — reachable for the target user, since consentless
// visitor_ids rotate daily and about 1,100 visitors a day over a 30-day
// window gets there. This removes that ceiling outright instead of
// chunking around it, stays index-backed, and is measurably faster than
// the chunked IN list it replaced.
export function getStepsFunnel(
  db: Database.Database,
  steps: string[],
  period: Period,
  scope: FunnelScope = "session",
  segment: SegmentClause = NO_SEGMENT,
): FunnelStep[] {
  if (steps.length === 0) return [];
  const column = SCOPE_COLUMN[scope];

  // The segment narrows who enters the funnel; later steps are then
  // looked up for exactly those keys, so it needs applying once.
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
      // Rounded like bounceRate: the agent reads this back as a figure,
      // and a raw division hands it 0.33333333333333331.
      conversionRate: starting === 0 ? 0 : roundTo(current.size / starting, 4),
    });
  }

  return results;
}

// Given the keys still in the funnel (session or visitor id -> the ts
// they reached the previous step at), returns only those that also
// reached `event` afterward, mapped to the ts of their first qualifying
// occurrence.
function advanceFunnelStep(
  db: Database.Database,
  event: string,
  period: Period,
  current: Map<string, string>,
  column: string,
): Map<string, string> {
  const keys = [...current.keys()];
  if (keys.length === 0) return new Map();

  // json_each expands the array into rows SQLite can join against, so
  // the whole key set costs one bound parameter no matter how large it
  // is. Still one statement per step, still index-backed.
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
    // Rows are ts-ascending, so the first one past previousTs is this
    // key's earliest qualifying occurrence of this step. Strictly past:
    // two events the server stamped in the same millisecond don't count
    // as ordered, which server-assigned timestamps on separate requests
    // make rare enough to note rather than tie-break on row id.
    const qualifyingTs = timestampsByKey
      .get(key)
      ?.find((ts) => ts > previousTs);
    if (qualifyingTs !== undefined) next.set(key, qualifyingTs);
  }
  return next;
}
