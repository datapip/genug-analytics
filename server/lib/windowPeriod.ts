import { z } from "zod";
import { addDays, localDate, localDayStart } from "./timezone.js";

// The cockpit's four period buttons. There is no free date range: that is
// analysis, which is the agent's job (see "Core design principle" in
// docs/decisions.md).
//
// "today" and "24h" end now, so their numbers keep changing. "7d" and
// "30d" are the 7 or 30 complete days before today, so their numbers stay
// the same all day. Days follow TIMEZONE (lib/timezone.ts), so "Today"
// starts at the owner's midnight, not at UTC midnight.
export const windowRangeSchema = z.enum(["today", "24h", "7d", "30d"]);
export type WindowRange = z.infer<typeof windowRangeSchema>;

export const DEFAULT_WINDOW_RANGE: WindowRange = "7d";

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID = windowRangeSchema.options.join(", ");

export type ParsedWindowRange =
  { ok: true; range: WindowRange } | { ok: false; error: string };

// No range means the default. An unknown range is an error, not the
// default: scripts call this route too (docs/deploying.md), and would
// otherwise get 7-day numbers for a question they didn't ask. A `days`
// parameter gets its own error, because a script sending `days=30` would
// otherwise silently get 7 days.
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
  // Count back in calendar days, not 24-hour steps, so "7d" still starts
  // at midnight when it contains a clock change.
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
