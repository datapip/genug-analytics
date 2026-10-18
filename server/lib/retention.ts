import type Database from "better-sqlite3";

// 13 months: the same 396 days as the consent cookie in
// routes/events.ts. See "Data lifecycle" in docs/decisions.md.
export const DEFAULT_RETENTION_DAYS = 396;

// Reads RETENTION_DAYS. Unset means DEFAULT_RETENTION_DAYS, `-1` means
// keep forever (returned as undefined), and any other positive number
// means that many days. A bad value stops the server at startup.
//
// `0` gets its own error instead of meaning "forever": "0 days" sounds
// like "keep nothing", and someone who guessed wrong would only find out
// once their data was gone. Nobody reads `-1` as a number of days, so
// it has to be looked up, which is safer for a setting this destructive.
export function parseRetentionDays(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  const days = Number(value);
  if (days === -1) return undefined;
  if (days === 0) {
    throw new Error(
      `RETENTION_DAYS=0 is not accepted — it reads as "keep nothing", ` +
        `not "keep forever". Use -1 for no limit.`,
    );
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(
      `RETENTION_DAYS must be a positive number of days, or -1 for no limit, got: ${value}`,
    );
  }
  return days;
}

// The cutoff time for keeping `days` days, shared by the prune
// functions below so they all compute it the same way.
function retentionCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function pruneOldEvents(db: Database.Database, days: number): number {
  return db
    .prepare(`DELETE FROM events WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

// Rejected requests follow the same RETENTION_DAYS as events, so there
// is only one retention setting.
export function pruneOldRejectedEvents(
  db: Database.Database,
  days: number,
): number {
  return db
    .prepare(`DELETE FROM rejected_events WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

// Bot counts follow RETENTION_DAYS too. There is at most one row per
// hour, so this only matters on a long-running deployment.
export function pruneOldBotActivity(
  db: Database.Database,
  days: number,
): number {
  return db
    .prepare(`DELETE FROM bot_activity WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

export function countEventsForVisitor(
  db: Database.Database,
  visitorId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE visitor_id = ?`)
    .get(visitorId) as { count: number };
  return row.count;
}

export function deleteVisitorData(
  db: Database.Database,
  visitorId: string,
): number {
  const result = db
    .prepare(`DELETE FROM events WHERE visitor_id = ?`)
    .run(visitorId);
  // secure_delete (db/connection.ts) overwrites the deleted rows in the
  // database file, but SQLite's write-ahead log still has copies until a
  // checkpoint. TRUNCATE also empties the log, so once this returns the
  // rows are gone from both. If a backup is running at that moment, the
  // checkpoint may wait; the next automatic one completes it.
  if (result.changes > 0) db.pragma("wal_checkpoint(TRUNCATE)");
  return result.changes;
}
