import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { rank, type Ranked } from "./aggregate.js";

export interface RejectedEventBreakdown {
  reason: string;
  event: string | null;
  requests: number;
  // The newest rejection's detail (such as "props.value: Expected number,
  // received string"), as one example. Rows are not grouped by it, since
  // rejections of the same event can differ slightly. SQLite returns a
  // plain column next to MAX() from the row that has the maximum, which
  // is how this gets the newest row's detail.
  lastDetail: string | null;
  // When the newest one arrived. Without it, three rejections in a week
  // could be a live problem or one fixed on Monday, which need different
  // responses.
  lastSeen: string;
}

// Counts rejections by reason and event name. The name matters most for
// unknown_event_type, where it is often a typo such as
// "produt_added_to_cart".
export function getTopRejectedEvents(
  db: Database.Database,
  period: Period,
  limit: number,
): Ranked<RejectedEventBreakdown> {
  // MAX(ts) is returned as `lastSeen`, and also makes SQLite take
  // `lastDetail` from the newest row.
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

// Just the total, for the cockpit's stat card.
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
