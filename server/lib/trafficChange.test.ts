import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { normalizePeriodBound, type Period } from "./period.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";
import { addDays, localDayStart } from "./timezone.js";
import { getTrafficChange, judge, shiftDays } from "./trafficChange.js";

const HOUR = 60 * 60 * 1000;
const TZ = "Europe/Berlin";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

let nextId = 0;
function session(
  db: Database.Database,
  at: number,
  overrides: { event?: string; deviceType?: string } = {},
) {
  const id = `s${nextId++}`;
  insertEvent(db, {
    event: overrides.event ?? "page_view",
    visitorId: id,
    sessionId: id,
    ts: new Date(at).toISOString(),
    url: "https://example.com/",
    deviceType: overrides.deviceType,
    props: {},
  });
}

// `perDay` sessions on every local day from `first` to `last`, one an
// hour from local midnight — so the same count lands in each day, 23 or
// 25 hours long.
function daily(
  db: Database.Database,
  first: string,
  last: string,
  perDay: number,
) {
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const start = localDayStart(day, TZ);
    for (let h = 0; h < perDay; h++) session(db, start + h * HOUR);
  }
}

function day(date: string): Period {
  return {
    from: normalizePeriodBound(date, "from", TZ),
    to: normalizePeriodBound(date, "to", TZ),
  };
}

function change(
  db: Database.Database,
  period: Period,
  now: Date,
  event?: string,
  clauseFor: (p: Period) => SegmentClause = () => NO_SEGMENT,
) {
  return getTrafficChange(db, period, now, TZ, "page_view", event, clauseFor);
}

const LATER = new Date("2027-01-01T00:00:00.000Z");

test("4 → 6 is too few to tell, 40 → 60 is a rise", () => {
  assert.equal(judge(6, [4, 4, 4, 4]).verdict, "too_few_to_tell");
  const rise = judge(60, [40, 40, 40, 40]);
  assert.equal(rise.verdict, "above_usual_range");
  assert.equal(rise.changePct, 50);
  assert.equal(judge(48, [40, 40, 40, 40]).verdict, "within_usual_range");
  assert.equal(judge(20, [40, 40, 40, 40]).verdict, "below_usual_range");
});

test("a lumpy baseline widens the band past sqrt(mean)", () => {
  // Mean 40, but the weeks swing from 20 to 60: 60 is ordinary here.
  const lumpy = judge(60, [20, 60, 20, 60]);
  assert.equal(lumpy.verdict, "within_usual_range");
  assert.ok(lumpy.usualHigh! > 80);
});

test("a zero baseline gives no Infinity or NaN anywhere", () => {
  const small = judge(3, [0, 0, 0, 0]);
  assert.equal(small.verdict, "too_few_to_tell");
  const big = judge(30, [0, 0, 0, 0]);
  assert.equal(big.verdict, "above_usual_range");
  assert.equal(big.changePct, null);
  assert.equal(big.change, 30);
  for (const value of Object.values(big)) {
    if (typeof value === "number") assert.ok(Number.isFinite(value));
  }
});

test("a steady site is within its usual range", () => {
  const db = setupDb();
  daily(db, "2026-08-01", "2026-09-30", 12);
  const result = change(db, day("2026-09-29"), LATER);
  assert.equal(result.sessions.current, 12);
  assert.equal(result.sessions.baselineMean, 12);
  assert.equal(result.sessions.verdict, "within_usual_range");
  assert.equal(result.viewEvents.verdict, "within_usual_range");
  assert.deepEqual(
    result.baselinePeriods.map((b) => b.weeksBack),
    [1, 2, 3, 4],
  );
});

test("baseline weeks before the oldest row are left out, not counted as zeros", () => {
  const db = setupDb();
  // Tracking started nine days before the day asked about: one usable week.
  daily(db, "2026-09-20", "2026-09-30", 12);
  const result = change(db, day("2026-09-29"), LATER);
  assert.equal(result.sessions.baselinePeriodsUsed, 1);
  assert.equal(result.sessions.verdict, "too_little_history");
  assert.equal(result.sessions.changePct, null);
  // The zeros are still shown, so the human can see why.
  assert.equal(result.baselinePeriods[3]!.sessions, 0);
});

test("a day still running is compared up to the same clock time", () => {
  const db = setupDb();
  // One session an hour, all day, for six weeks.
  daily(db, "2026-08-15", "2026-09-29", 24);
  for (let h = 0; h < 10; h++)
    session(db, localDayStart("2026-09-30", TZ) + h * HOUR);
  const now = new Date(localDayStart("2026-09-30", TZ) + 10 * HOUR);
  const result = change(db, day("2026-09-30"), now);
  assert.equal(result.period.cutAtNow, true);
  assert.equal(result.sessions.current, 10);
  // Each baseline day is cut at 10:00 too, so this is no change, not -58%.
  assert.equal(result.sessions.baselineMean, 11);
  assert.equal(result.sessions.verdict, "within_usual_range");
});

test("weeks across a clock change line up on local days", () => {
  const db = setupDb();
  // 2026-10-25 has 25 hours in Berlin; same count every day regardless.
  daily(db, "2026-10-01", "2026-11-22", 20);
  const result = change(db, day("2026-11-01"), LATER);
  assert.equal(result.baselinePeriods[0]!.from, day("2026-10-25").from);
  assert.equal(result.baselinePeriods[0]!.to, day("2026-10-25").to);
  assert.equal(result.baselinePeriods[0]!.sessions, 20);
  assert.equal(result.sessions.verdict, "within_usual_range");

  // And the spring change: 2026-03-29 has 23 hours.
  const spring = setupDb();
  daily(spring, "2026-02-20", "2026-04-20", 20);
  const across = change(spring, day("2026-04-05"), LATER);
  assert.equal(across.baselinePeriods[0]!.from, day("2026-03-29").from);
  assert.equal(across.baselinePeriods[0]!.sessions, 20);
  assert.equal(across.sessions.verdict, "within_usual_range");
});

test("a time of day keeps its wall clock across a clock change", () => {
  const db = setupDb();
  daily(db, "2026-09-01", "2026-11-30", 1);
  // 10:00 to 14:00 Berlin time on the Sunday after the change.
  const result = change(
    db,
    {
      from: "2026-11-01T09:00:00.000Z",
      to: "2026-11-01T13:00:00.000Z",
    },
    LATER,
  );
  // A week earlier was still summer time, so 10:00 there is 08:00 UTC.
  assert.equal(result.baselinePeriods[0]!.from, "2026-10-25T09:00:00.000Z");
  assert.equal(result.baselinePeriods[1]!.from, "2026-10-18T08:00:00.000Z");
});

test("a period over a week steps back by whole weeks", () => {
  const db = setupDb();
  daily(db, "2026-06-01", "2026-09-30", 5);
  const result = change(
    db,
    { from: day("2026-09-20").from, to: day("2026-09-27").to },
    LATER,
  );
  assert.deepEqual(
    result.baselinePeriods.map((b) => b.weeksBack),
    [2, 4, 6, 8],
  );
  assert.equal(result.baselinePeriods[0]!.from, day("2026-09-06").from);
  assert.equal(result.sessions.current, 40);
  assert.equal(result.sessions.verdict, "within_usual_range");
});

test("the segment narrows the baseline weeks too, not only the current one", () => {
  const db = setupDb();
  daily(db, "2026-08-01", "2026-09-30", 12);
  // Mobile sessions only in the baseline weeks.
  for (const date of ["2026-09-22", "2026-09-15", "2026-09-08", "2026-09-01"]) {
    session(db, localDayStart(date, TZ) + 15 * HOUR, { deviceType: "mobile" });
  }
  const mobile: SegmentClause = {
    sql: " AND device_type = @segDevice",
    params: { segDevice: "mobile" },
  };
  const seen: Period[] = [];
  const result = change(db, day("2026-09-29"), LATER, undefined, (p) => {
    seen.push(p);
    return mobile;
  });
  assert.equal(result.sessions.current, 0);
  assert.deepEqual(
    result.baselinePeriods.map((b) => b.sessions),
    [1, 1, 1, 1],
  );
  assert.equal(seen.length, 5, "one resolution per period");
});

test("an event added recently has too little history while sessions do not", () => {
  const db = setupDb();
  daily(db, "2026-08-01", "2026-09-30", 12);
  for (const date of ["2026-09-15", "2026-09-22", "2026-09-29"]) {
    for (let i = 0; i < 15; i++) {
      session(db, localDayStart(date, TZ) + 16 * HOUR, { event: "signup" });
    }
  }
  const result = change(db, day("2026-09-29"), LATER, "signup");
  assert.equal(result.sessions.baselinePeriodsUsed, 4);
  assert.equal(result.events!.event, "signup");
  assert.equal(result.events!.current, 15);
  // The week of the first signup starts before it, so it is partial too.
  assert.equal(result.events!.baselinePeriodsUsed, 1);
  assert.equal(result.events!.verdict, "too_little_history");
});

test("a stray old row does not turn untracked weeks into zero traffic", () => {
  const db = setupDb();
  // One test event two months early, then the script went live.
  session(db, localDayStart("2026-07-30", TZ) + 12 * HOUR);
  daily(db, "2026-09-23", "2026-09-29", 12);
  const result = change(db, day("2026-09-29"), LATER);
  assert.equal(result.baselinePeriods[1]!.rowsStored, 0);
  assert.equal(result.sessions.baselinePeriodsUsed, 0);
  assert.equal(result.sessions.verdict, "too_little_history");
});

test("a time of day keeps its wall clock where a day starts at 01:00", () => {
  // Santiago jumps from 00:00 to 01:00 on 2026-09-06 (-04:00 to -03:00).
  const tz = "America/Santiago";
  // 03:00 local on the change day, a week back is 03:00 at -04:00.
  assert.equal(
    shiftDays(Date.parse("2026-09-06T06:00:00.000Z"), -7, tz),
    Date.parse("2026-08-30T07:00:00.000Z"),
  );
  // The day's first instant still maps to the other day's first instant.
  assert.equal(
    shiftDays(localDayStart("2026-09-06", tz), -7, tz),
    localDayStart("2026-08-30", tz),
  );
  assert.equal(
    shiftDays(localDayStart("2026-09-13", tz), -7, tz),
    localDayStart("2026-09-06", tz),
  );
});
