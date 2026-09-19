import type Database from "better-sqlite3";

export interface OrphanedEventGroup {
  event: string;
  events: number;
  // When the last one arrived — effectively when the event stopped
  // being registered, since nothing can have been written under the
  // name since.
  lastSeen: string;
}

// Stored events whose type the registry no longer has.
//
// These can only come from one thing: an event that was renamed or
// deleted. A name that was never registered cannot produce rows at all,
// because routes/events.ts rejects it at ingestion — so unlike
// rejected_events, which records requests that never became data, this
// is real data the registry has lost track of.
//
// What that costs is uneven, which is why it is worth reporting rather
// than leaving to be noticed. Queries that group by whatever is in the
// column still see these rows (getTopEvents, getRecentEvents), under
// the old name. Queries that resolve a *registered* name do not, and
// no tool will accept the old name as an argument. The bad case is
// renaming the page-view event: its history stops matching
// pageViewEventType, so top/entry/exit/bounce pages lose it entirely
// and getTrafficSummary counts those page views as interactionEvents
// instead. The totals stay plausible while the split is wrong, which is
// harder to spot than a zero.
//
// Deliberately not scoped to a period. A rename's orphans age out of
// any window while staying just as invisible, so a period-scoped
// version would stop reporting the problem precisely when it had been
// there longest.
//
// No limit either: the rows can only be produced by the deployment's
// own renames, never by traffic, so the number of distinct names here
// is a handful at most and not something a visitor can inflate.
export function getOrphanedEvents(
  db: Database.Database,
  registeredEvents: readonly string[],
): OrphanedEventGroup[] {
  // The registered names go in as one bound JSON array rather than a
  // generated run of placeholders — no SQL is built by interpolation,
  // and the number of registered events can't run into SQLite's bound
  // parameter ceiling. Same json_each idiom as lib/funnel.ts.
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
