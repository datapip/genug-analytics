import type Database from "better-sqlite3";
import type { Period } from "./period.js";

export interface BotActivityCounter {
  count: number;
}

export function createBotActivityCounter(): BotActivityCounter {
  return { count: 0 };
}

export function recordBotHit(counter: BotActivityCounter): void {
  counter.count++;
}

// Returns the count and resets it to zero. The counter is a parameter so
// each test can use its own. No request can increment it between the read
// and the reset: Node runs one thing at a time and there is no `await`
// here.
export function drainBotHits(counter: BotActivityCounter): number {
  const count = counter.count;
  counter.count = 0;
  return count;
}

// The counter the running server uses: routes/events.ts adds one for
// every bot request it drops, and an hourly job in index.ts drains it
// into the database.
export const botActivityCounter: BotActivityCounter =
  createBotActivityCounter();

export function getBotActivityCount(
  db: Database.Database,
  period: Period,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total
       FROM bot_activity
       WHERE ts BETWEEN @from AND @to`,
    )
    .get({ from: period.from, to: period.to }) as { total: number };
  return row.total;
}
