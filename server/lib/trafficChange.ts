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

// "Did traffic really change, or is this noise?" The comparison itself
// is a subtraction the agent can do; what it cannot do is tell 4 → 6
// from 40 → 60. See "get_traffic_change" in docs/decisions.md for why
// this exists after compare_periods was removed.

// How many earlier copies of the period make up the baseline, and how
// many must be usable for a verdict. Fewer than three gives a standard
// deviation that means nothing.
export const BASELINE_PERIODS = 4;
const MIN_BASELINE_PERIODS = 3;
// Below this on both sides there is no verdict. 4 → 6 is +50% and
// means nothing; a minimum count is what keeps that out of a report.
const MIN_COUNT = 10;
// How far from the usual a count must be, in noise widths, to count.
const NOISE_WIDTHS = 2;
// Capped so four baselines (31 days → 5 weeks apart) stay well inside
// the default retention of 396 days.
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
  // How many of the baseline periods this metric was judged against:
  // those that start before its oldest stored row are left out.
  baselinePeriodsUsed: number;
  baselineMean: number | null;
  usualLow: number | null;
  usualHigh: number | null;
  change: number | null;
  // Null when the baseline mean is zero: a rise from nothing has no
  // percentage, and Infinity would serialize as null anyway.
  changePct: number | null;
  verdict: ChangeVerdict;
}

export interface BaselinePeriod extends Period {
  weeksBack: number;
  // Every stored row in the period, ignoring the segment. Zero means
  // nothing was being collected, and the period is left out.
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

// Moves an instant by whole local days, keeping its wall-clock time: a
// Tuesday 10:00 becomes the Tuesday 10:00 a week earlier even when a
// clock change lies between them. Subtracting 7 × 24 hours would land
// an hour off. The time of day is measured from the nominal midnight,
// not from localDayStart: in zones that change clocks at midnight a day
// can start at 01:00, and measuring from there shifts by an hour.
export function shiftDays(
  instant: number,
  days: number,
  timezone: string,
): number {
  const date = localDate(instant, timezone);
  const target = addDays(date, days);
  // A day's first instant maps to the target day's first instant, which
  // need not be the same wall-clock time when either starts at 01:00.
  if (instant === localDayStart(date, timezone)) {
    return localDayStart(target, timezone);
  }
  const wall = instant + offsetMinutes(instant, timezone) * MINUTE_MS;
  const intoDay = wall - Date.parse(`${date}T00:00:00.000Z`);
  const targetWall = Date.parse(`${target}T00:00:00.000Z`) + intoDay;
  // Wall clock back to an instant: the offset to subtract is the one in
  // force at the answer, so take it at a first guess and again there.
  const guess = targetWall - offsetMinutes(targetWall, timezone) * MINUTE_MS;
  return targetWall - offsetMinutes(guess, timezone) * MINUTE_MS;
}

// An inclusive end is shifted as the exclusive end it stands for, so a
// bare date's 23:59:59.999 stays the last moment of the shifted day.
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

// The verdict for one metric. Noise is the larger of two estimates:
// sqrt(mean) is what counts arriving at random would show, and the
// baseline's own spread catches real traffic being lumpier than that
// (a shared link, a newsletter, a bot burst). Using only the first
// flags too much; using only the second lets four lucky equal weeks
// make the band zero wide.
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

// The period against the same span 1..BASELINE_PERIODS weeks earlier
// (whole multiples of a week for a longer period), so the weekday mix
// always matches. `clauseFor` resolves the segment per period, since an
// entry-based condition depends on which sessions started in it.
export function getTrafficChange(
  db: Database.Database,
  period: Period,
  now: Date,
  timezone: string,
  pageViewEvent: string,
  event: string | undefined,
  clauseFor: (period: Period) => SegmentClause,
): TrafficChange {
  // A period still running is compared up to now, and each baseline up
  // to the same local clock time, or "today so far" reads as a drop.
  const cutAtNow = Date.parse(period.to) > now.getTime();
  const current: Period = cutAtNow
    ? { from: period.from, to: now.toISOString() }
    : period;

  // The step comes from the whole period asked for, not the part before
  // now: "this week so far" is still compared with earlier weeks.
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

  // A baseline nobody was tracking would count as zeros, and any period
  // would read as a rise. Two ways to spot one: it starts before the
  // metric's oldest row (a new deployment, or rows deleted by
  // retention), or nothing at all was stored in it (a stray test event
  // months before the script went live, or weeks the snippet was gone).
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
