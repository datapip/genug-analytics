import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import type { SegmentClause } from "./segment.js";
import { getTrafficSummary } from "./traffic.js";
import {
  addDays,
  enumerateDays,
  localDate,
  localDayStart,
  offsetMinutes,
} from "./timezone.js";

// "Did traffic really change, or is this noise?" The agent can subtract
// two numbers itself, but it can't tell whether 4 → 6 means anything,
// while 40 → 60 might. See "get_traffic_change" in docs/decisions.md.

// How many earlier periods of the same length make up the baseline, and
// how many must be usable for a verdict. With fewer than three, the
// standard deviation means nothing.
export const BASELINE_PERIODS = 4;
const MIN_BASELINE_PERIODS = 3;
// Below this count on both sides there is no verdict: 4 → 6 is +50% but
// means nothing.
const MIN_COUNT = 10;
// How far from normal a count must be, in multiples of the noise, to
// count as a change.
const NOISE_WIDTHS = 2;
// The longest period accepted, so four baseline periods (31 days each,
// 5 weeks apart) stay well inside the default retention of 396 days.
export const MAX_CHANGE_DAYS = 31;

const MINUTE_MS = 60 * 1000;

export type ChangeVerdict =
  | "too_little_history"
  | "too_few_to_tell"
  | "within_usual_range"
  | "above_usual_range"
  | "below_usual_range";

export interface MetricChange {
  current: number;
  // How many baseline periods this metric was compared with. Periods
  // that start before its oldest stored row are left out.
  baselinePeriodsUsed: number;
  baselineMean: number | null;
  usualLow: number | null;
  usualHigh: number | null;
  change: number | null;
  // Null when the baseline average is zero: a rise from nothing has no
  // percentage (and Infinity would become null in JSON anyway).
  changePct: number | null;
  verdict: ChangeVerdict;
}

export interface BaselinePeriod extends Period {
  weeksBack: number;
  // All stored rows in the period, ignoring the segment. Zero means
  // nothing was being collected, so the period is left out.
  rowsStored: number;
  sessions: number;
  viewEvents: number;
  events?: number;
}

export interface TrafficChange {
  period: Period & { cutAtNow: boolean };
  baselinePeriods: BaselinePeriod[];
  sessions: MetricChange;
  viewEvents: MetricChange;
  events?: MetricChange & { event: string };
}

// Moves a time by whole local days, keeping the clock time: Tuesday
// 10:00 becomes Tuesday 10:00 a week earlier, even across a clock change
// (subtracting 7 × 24 hours would be an hour off). The time of day is
// measured from 00:00, not from localDayStart: where clocks change at
// midnight a day can start at 01:00, which would shift it by an hour.
export function shiftDays(
  instant: number,
  days: number,
  timezone: string,
): number {
  const date = localDate(instant, timezone);
  const target = addDays(date, days);
  // The start of a day maps to the start of the target day, which may be
  // a different clock time if either day starts at 01:00.
  if (instant === localDayStart(date, timezone)) {
    return localDayStart(target, timezone);
  }
  const wall = instant + offsetMinutes(instant, timezone) * MINUTE_MS;
  const intoDay = wall - Date.parse(`${date}T00:00:00.000Z`);
  const targetWall = Date.parse(`${target}T00:00:00.000Z`) + intoDay;
  // Convert the clock time back to a UTC time. The offset needed is the
  // one at the result, so guess once, then take the offset there.
  const guess = targetWall - offsetMinutes(targetWall, timezone) * MINUTE_MS;
  return targetWall - offsetMinutes(guess, timezone) * MINUTE_MS;
}

// Shifts an inclusive end (like 23:59:59.999) by shifting the next
// moment and subtracting 1 ms again, so it stays the last moment of the
// shifted day.
function shiftPeriod(period: Period, days: number, timezone: string): Period {
  const from = shiftDays(Date.parse(period.from), days, timezone);
  const to = shiftDays(Date.parse(period.to) + 1, days, timezone) - 1;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

function oldestRow(db: Database.Database, event: string | null) {
  const row = (
    event === null
      ? db.prepare(`SELECT MIN(ts) AS oldest FROM events`).get()
      : db
          .prepare(`SELECT MIN(ts) AS oldest FROM events WHERE event = @event`)
          .get({ event })
  ) as { oldest: string | null };
  return row.oldest;
}

function countRows(db: Database.Database, period: Period): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows FROM events WHERE ts BETWEEN @from AND @to`,
    )
    .get({ from: period.from, to: period.to }) as { rows: number };
  return row.rows;
}

function countEvent(
  db: Database.Database,
  period: Period,
  event: string,
  segment: SegmentClause,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS events FROM events
       WHERE event = @event AND ts BETWEEN @from AND @to${segment.sql}`,
    )
    .get({ event, from: period.from, to: period.to, ...segment.params }) as {
    events: number;
  };
  return row.events;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The verdict for one metric. The noise is the larger of two estimates:
// sqrt(mean), the variation of counts arriving at random, and the
// baseline's actual spread, since real traffic is lumpier (a shared link,
// a newsletter, a bot burst). The first alone flags too much; the second
// alone would be zero after four equal weeks.
export function judge(current: number, baseline: number[]): MetricChange {
  if (baseline.length < MIN_BASELINE_PERIODS) {
    return {
      current,
      baselinePeriodsUsed: baseline.length,
      baselineMean: null,
      usualLow: null,
      usualHigh: null,
      change: null,
      changePct: null,
      verdict: "too_little_history",
    };
  }

  const mean = baseline.reduce((sum, n) => sum + n, 0) / baseline.length;
  const variance =
    baseline.reduce((sum, n) => sum + (n - mean) ** 2, 0) /
    (baseline.length - 1);
  const noise = Math.max(Math.sqrt(mean), Math.sqrt(variance));
  const low = Math.max(0, mean - NOISE_WIDTHS * noise);
  const high = mean + NOISE_WIDTHS * noise;

  let verdict: ChangeVerdict;
  if (Math.max(current, mean) < MIN_COUNT) verdict = "too_few_to_tell";
  else if (current > high) verdict = "above_usual_range";
  else if (current < low) verdict = "below_usual_range";
  else verdict = "within_usual_range";

  return {
    current,
    baselinePeriodsUsed: baseline.length,
    baselineMean: round1(mean),
    usualLow: round1(low),
    usualHigh: round1(high),
    change: round1(current - mean),
    changePct: mean === 0 ? null : round1(((current - mean) / mean) * 100),
    verdict,
  };
}

// Compares the period with the same span 1..BASELINE_PERIODS weeks
// earlier (whole weeks apart for longer periods), so the weekdays always
// match. `clauseFor` resolves the segment for each period, because an
// entry-page condition depends on which sessions started in it.
export function getTrafficChange(
  db: Database.Database,
  period: Period,
  now: Date,
  timezone: string,
  pageViewEvent: string,
  event: string | undefined,
  clauseFor: (period: Period) => SegmentClause,
): TrafficChange {
  // A period that hasn't ended is compared up to now, and each baseline
  // up to the same clock time; otherwise "today so far" would look like a
  // drop.
  const cutAtNow = Date.parse(period.to) > now.getTime();
  const current: Period = cutAtNow
    ? { from: period.from, to: now.toISOString() }
    : period;

  // The distance between periods comes from the whole period asked for,
  // not just the part until now, so "this week so far" is still compared
  // with earlier weeks.
  const days = enumerateDays(period.from, period.to, timezone).length;
  const stepDays = Math.ceil(days / 7) * 7;

  const measure = (p: Period) => {
    const clause = clauseFor(p);
    const summary = getTrafficSummary(db, p, pageViewEvent, clause);
    return {
      sessions: summary.sessions,
      viewEvents: summary.viewEvents,
      ...(event === undefined
        ? {}
        : { events: countEvent(db, p, event, clause) }),
    };
  };

  const counts = measure(current);
  const baselinePeriods: BaselinePeriod[] = [];
  for (let k = 1; k <= BASELINE_PERIODS; k++) {
    const shifted = shiftPeriod(current, -k * stepDays, timezone);
    baselinePeriods.push({
      weeksBack: (k * stepDays) / 7,
      ...shifted,
      rowsStored: countRows(db, shifted),
      ...measure(shifted),
    });
  }

  // A baseline period when nothing was tracked would count as zeros, and
  // every period would look like a rise. Such periods are left out when
  // they start before the metric's oldest row (a new deployment, or rows
  // deleted by retention) or have no stored rows at all (for example,
  // weeks when the script was missing from the site).
  const usable = (oldest: string | null) =>
    baselinePeriods.filter(
      (b) => oldest !== null && b.from >= oldest && b.rowsStored > 0,
    );
  const anyOldest = oldestRow(db, null);
  const viewOldest = oldestRow(db, pageViewEvent);

  return {
    period: { ...current, cutAtNow },
    baselinePeriods,
    sessions: judge(
      counts.sessions,
      usable(anyOldest).map((b) => b.sessions),
    ),
    viewEvents: judge(
      counts.viewEvents,
      usable(viewOldest).map((b) => b.viewEvents),
    ),
    ...(event === undefined
      ? {}
      : {
          events: {
            event,
            ...judge(
              counts.events!,
              usable(oldestRow(db, event)).map((b) => b.events!),
            ),
          },
        }),
  };
}
