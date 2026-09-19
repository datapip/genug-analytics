import type Database from "better-sqlite3";

export interface ResetResult {
  eventsDeleted: number;
  rejectedEventsDeleted: number;
  botActivityDeleted: number;
}

// Wipes every stored event, rejected event and bot-activity row. Unlike
// retention.ts's pruning (a cutoff date) or deleteVisitorData (one
// visitor), this is unscoped on purpose — it exists for the cockpit's
// danger zone, to clear out test traffic before a real launch, and a
// scoped version of "start over" would not serve that. Never call this
// for GDPR erasure.
//
// The event *schema* (registered event types) is untouched — only the
// rows they've collected.
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
