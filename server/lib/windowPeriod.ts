import { z } from "zod";
import { addDays, localDate, localDayStart } from "./timezone.js";

// The cockpit's four period buttons. Only these are offered: a free
// date range is analysis, which is the agent's job (see
// docs/decisions.md, "Core design principle").
//
// "today" and "24h" are rolling windows ending now — a partial,
// still-moving period is what those labels promise. "7d" and "30d" are
// the N complete days before today, fixed once the day turns over, so
// the number does not move between two reloads on the same day. Days
// are the site's own (TIMEZONE, lib/timezone.ts), so "Today" starts at
// the owner's midnight rather than at UTC's.
export const windowRangeSchema = z.enum(["today", "24h", "7d", "30d"]);
export type WindowRange = z.infer<typeof windowRangeSchema>;

export const DEFAULT_WINDOW_RANGE: WindowRange = "7d";

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID = windowRangeSchema.options.join(", ");

export type ParsedWindowRange =
  { ok: true; range: WindowRange } | { ok: false; error: string };

// A missing range is the default. A wrong one is refused, never
// defaulted: scripts call this route too (docs/deploying.md), and a
// silent fallback hands them 7-day numbers under any other question.
// `days` is refused by name because it is the old parameter, and a
// script still sending `days=30` would otherwise get 7d without a word.
export function parseWindowRange(
  query: Record<string, unknown>,
): ParsedWindowRange {
  if (query.days !== undefined) {
    return {
      ok: false,
      error: `The days parameter was replaced by range. Use one of: ${VALID}.`,
    };
  }
  if (query.range === undefined) {
    return { ok: true, range: DEFAULT_WINDOW_RANGE };
  }
  const parsed = windowRangeSchema.safeParse(query.range);
  return parsed.success
    ? { ok: true, range: parsed.data }
    : { ok: false, error: `range must be one of: ${VALID}.` };
}

export function windowPeriod(
  range: WindowRange,
  now: Date,
  timezone: string,
): { from: string; to: string } {
  const today = localDate(now, timezone);
  const todayStart = localDayStart(today, timezone);
  // Counted back in calendar days, not in 24-hour steps, so 7d still
  // starts at a midnight when a clock change falls inside it.
  const fullDays = (n: number) => ({
    from: new Date(localDayStart(addDays(today, -n), timezone)).toISOString(),
    // `to` is inclusive (queries use BETWEEN), so stop 1 ms before today.
    to: new Date(todayStart - 1).toISOString(),
  });
  switch (range) {
    case "today":
      return {
        from: new Date(todayStart).toISOString(),
        to: now.toISOString(),
      };
    case "24h":
      return {
        from: new Date(now.getTime() - DAY_MS).toISOString(),
        to: now.toISOString(),
      };
    case "7d":
      return fullDays(7);
    case "30d":
      return fullDays(30);
  }
}
