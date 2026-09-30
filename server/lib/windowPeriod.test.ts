import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindowRange, windowPeriod } from "./windowPeriod.js";
import { enumerateDays } from "./timezone.js";

const MIDDAY = new Date("2026-09-28T14:30:00.000Z");
const MIDNIGHT = new Date("2026-09-28T00:00:00.000Z");

test("in UTC, 7d is the seven complete days before today", () => {
  assert.deepEqual(windowPeriod("7d", MIDDAY, "UTC"), {
    from: "2026-09-21T00:00:00.000Z",
    to: "2026-09-27T23:59:59.999Z",
  });
});

test("30d starts thirty days before today", () => {
  assert.equal(
    windowPeriod("30d", MIDDAY, "UTC").from,
    "2026-08-29T00:00:00.000Z",
  );
});

test("in UTC, today runs from UTC midnight to now", () => {
  assert.deepEqual(windowPeriod("today", MIDDAY, "UTC"), {
    from: "2026-09-28T00:00:00.000Z",
    to: "2026-09-28T14:30:00.000Z",
  });
});

test("at exactly midnight, today is empty and 7d ends 1 ms earlier", () => {
  const today = windowPeriod("today", MIDNIGHT, "UTC");
  assert.equal(today.from, today.to);
  assert.equal(
    windowPeriod("7d", MIDNIGHT, "UTC").to,
    "2026-09-27T23:59:59.999Z",
  );
});

// Pins the "complete days" promise across both modules: the daily
// chart must get exactly N buckets, none of them today.
test("the daily chart gets exactly 7 and 30 days, without today", () => {
  for (const [range, n] of [
    ["7d", 7],
    ["30d", 30],
  ] as const) {
    const { from, to } = windowPeriod(range, MIDDAY, "UTC");
    const days = enumerateDays(from, to, "UTC");
    assert.equal(days.length, n);
    assert.ok(!days.includes("2026-09-28"));
  }
});

// Berlin is two hours ahead in summer. 00:30 on the 29th local is
// 22:30 on the 28th in UTC, and "Today" must already be the 29th.
test("today starts at the site's midnight, not UTC's", () => {
  const justAfterMidnight = new Date("2026-09-28T22:30:00.000Z");
  assert.deepEqual(windowPeriod("today", justAfterMidnight, "Europe/Berlin"), {
    from: "2026-09-28T22:00:00.000Z",
    to: "2026-09-28T22:30:00.000Z",
  });
});

// Clocks go back on 25 October 2026, so the window starts at a summer
// midnight (UTC+2) and ends at a winter one (UTC+1). Counted in 24-hour
// steps it would start an hour off and cut the first day short.
test("7d across a clock change starts and ends at local midnights", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const period = windowPeriod("7d", now, "Europe/Berlin");
  assert.deepEqual(period, {
    from: "2026-10-20T22:00:00.000Z",
    to: "2026-10-27T22:59:59.999Z",
  });
  assert.deepEqual(enumerateDays(period.from, period.to, "Europe/Berlin"), [
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-10-27",
  ]);
});

test("a missing range is the 7d default", () => {
  assert.deepEqual(parseWindowRange({}), { ok: true, range: "7d" });
});

test("every offered range is accepted", () => {
  for (const range of ["today", "24h", "7d", "30d"]) {
    assert.deepEqual(parseWindowRange({ range }), { ok: true, range });
  }
});

test("an unknown or repeated range is refused, not defaulted", () => {
  for (const range of ["1", "365d", ["7d", "24h"]]) {
    const parsed = parseWindowRange({ range });
    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.error : "", /today, 24h, 7d, 30d/);
  }
});

test("the old days parameter is refused by name", () => {
  const parsed = parseWindowRange({ days: "30" });
  assert.equal(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.error : "", /replaced by range/);
});
