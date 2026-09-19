import type Database from "better-sqlite3";

// `ts` is an explicit parameter, not computed in here — same reasoning
// as insertEvent/insertRejectedEvent: the caller stamps "now" once,
// which also makes this testable against a fixed period.
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
