import type Database from "better-sqlite3";

export interface ResetResult {
  eventsDeleted: number;
  rejectedEventsDeleted: number;
  botActivityDeleted: number;
}

// Deletes every stored event, rejected event and bot-activity row. It
// backs the cockpit's danger-zone button for clearing test traffic before
// launch. For deleting one visitor's data (a GDPR request), use
// deleteVisitorData instead. The event definitions are kept; only the
// collected rows go.
export function resetDatabase(db: Database.Database): ResetResult {
  const reset = db.transaction((): ResetResult => {
    const eventsDeleted = db.prepare(`DELETE FROM events`).run().changes;
    const rejectedEventsDeleted = db
      .prepare(`DELETE FROM rejected_events`)
      .run().changes;
    const botActivityDeleted = db
      .prepare(`DELETE FROM bot_activity`)
      .run().changes;
    return { eventsDeleted, rejectedEventsDeleted, botActivityDeleted };
  });
  return reset();
}
