import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { rank, type Ranked } from "./aggregate.js";

export interface RejectedEventBreakdown {
  reason: string;
  event: string | null;
  requests: number;
  // The most recent occurrence's detail (e.g. "props.value: Expected
  // number, received string") — one representative example, not
  // grouped on, since occurrences of the same (reason, event) can each
  // fail for a slightly different reason. Relies on SQLite's documented
  // behavior that a bare column alongside a MAX() aggregate comes from
  // the row that produced that max — same trick getEntryPages/
  // getExitPages already use for "the url at the earliest/latest ts".
  lastDetail: string | null;
  // When the most recent one arrived, from the same MAX(ts) row that
  // produced lastDetail. Without it a count is unreadable: three
  // rejections in a seven-day window is either a live breakage or a
  // bug fixed on Monday, and those need opposite responses.
  lastSeen: string;
}

// Same "group and count" shape as getTopEvents/getEventsByProperty — grouped by
// (reason, event) rather than event alone, since for unknown_event_type
// specifically the event name itself (a likely typo, e.g.
// "produt_added_to_cart") is often the single most useful piece of
// information, not just how many times it happened.
export function getTopRejectedEvents(
  db: Database.Database,
  period: Period,
  limit: number,
): Ranked<RejectedEventBreakdown> {
  // MAX(ts) does double duty: it triggers the bare-column-from-the-max-row
  // behavior that gives `lastDetail` the newest occurrence's detail, and
  // it is itself returned as `lastSeen`.
  const rows = db
    .prepare(
      `SELECT reason, event, COUNT(*) AS requests, MAX(ts) AS ts, detail AS lastDetail
       FROM rejected_events
       WHERE ts BETWEEN @from AND @to
       GROUP BY reason, event`,
    )
    .all({
      from: period.from,
      to: period.to,
    }) as (Omit<RejectedEventBreakdown, "lastSeen"> & { ts: string })[];

  return rank(
    rows.map(({ reason, event, requests, lastDetail, ts }) => ({
      reason,
      event,
      requests,
      lastDetail,
      lastSeen: ts,
    })),
    (row) => row.requests,
    limit,
  );
}

// The cockpit's simple stat card just needs a total, not the
// breakdown — same relationship get_traffic_summary's sessions/events
// counts have to get_top_events' breakdown.
export function getRejectedEventCount(
  db: Database.Database,
  period: Period,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM rejected_events
       WHERE ts BETWEEN @from AND @to`,
    )
    .get({ from: period.from, to: period.to }) as { count: number };
  return row.count;
}
