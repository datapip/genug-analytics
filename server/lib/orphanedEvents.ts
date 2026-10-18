import type Database from "better-sqlite3";

export interface OrphanedEventGroup {
  event: string;
  events: number;
  // When the last one arrived. That is roughly when the event was
  // renamed or deleted, since nothing can be stored under the name after.
  lastSeen: string;
}

// Stored events whose name no registered event has ("orphaned" rows).
//
// They can only come from renaming or deleting an event: /events
// rejects a name that isn't registered, so no new rows can appear under
// it.
//
// Why report them: queries that group by the stored name
// (getTopEvents, getRecentEvents) still show them under the old name,
// but queries that look up a registered name miss them, and no tool
// accepts the old name. Worst case is renaming the page-view event: the
// old page views drop out of the page tools, and getTrafficSummary
// counts them as interactionEvents. The totals look right while the
// split is wrong, which is harder to spot than a zero.
//
// Not limited to a period: the old rows fall out of any recent period
// but stay just as invisible, so a period would hide the problem the
// longer it lasts.
//
// No row limit either: only the deployment's own renames create these,
// not visitors, so there are a handful at most.
export function getOrphanedEvents(
  db: Database.Database,
  registeredEvents: readonly string[],
): OrphanedEventGroup[] {
  // The registered names are passed as one JSON array and unpacked with
  // json_each, instead of one `?` per name. That keeps the SQL fixed and
  // can't hit SQLite's limit on the number of parameters.
  return db
    .prepare(
      `SELECT event, COUNT(*) AS events, MAX(ts) AS lastSeen
       FROM events
       WHERE event NOT IN (SELECT value FROM json_each(@registered))
       GROUP BY event
       ORDER BY events DESC`,
    )
    .all({
      registered: JSON.stringify(registeredEvents),
    }) as OrphanedEventGroup[];
}
