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

// Reads and resets in one step — takes the counter as a parameter
// (rather than closing over module state) for the same reason
// rateLimit.ts's isWithinRateLimit does: testable with a throwaway
// counter, no state leaking between test cases. Safe against the real
// request path incrementing concurrently: Node is single-threaded and
// this has no `await` in it, so nothing can run between reading
// `count` and resetting it.
export function drainBotHits(counter: BotActivityCounter): number {
  const count = counter.count;
  counter.count = 0;
  return count;
}

// Module singleton for real use: routes/events.ts's bot check calls
// recordBotHit(botActivityCounter) on every drop, and index.ts's hourly
// job drains and persists it.
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
