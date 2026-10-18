import type Database from "better-sqlite3";

// The caller passes `ts` instead of this function reading the clock, as
// insertEvent does, so a test can store rows at a fixed time.
export function insertBotActivity(
  db: Database.Database,
  ts: string,
  count: number,
): void {
  db.prepare(`INSERT INTO bot_activity (ts, count) VALUES (@ts, @count)`).run({
    ts,
    count,
  });
}
