import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindowRange, windowPeriod } from "./windowPeriod.js";
import { enumerateDays } from "./traffic.js";

const MIDDAY = new Date("2026-09-28T14:30:00.000Z");
const MIDNIGHT = new Date("2026-09-28T00:00:00.000Z");

test("7d is the seven complete UTC days before today", () => {
  assert.deepEqual(windowPeriod("7d", MIDDAY), {
    from: "2026-09-21T00:00:00.000Z",
    to: "2026-09-27T23:59:59.999Z",
  });
});

test("30d starts thirty days before today", () => {
  assert.equal(windowPeriod("30d", MIDDAY).from, "2026-08-29T00:00:00.000Z");
});

test("today runs from UTC midnight to now", () => {
  assert.deepEqual(windowPeriod("today", MIDDAY), {
    from: "2026-09-28T00:00:00.000Z",
    to: "2026-09-28T14:30:00.000Z",
  });
});

test("at exactly midnight, today is empty and 7d ends 1 ms earlier", () => {
  const today = windowPeriod("today", MIDNIGHT);
  assert.equal(today.from, today.to);
  assert.equal(windowPeriod("7d", MIDNIGHT).to, "2026-09-27T23:59:59.999Z");
});

// Pins the "complete days" promise across both modules: the daily
// chart must get exactly N buckets, none of them today.
test("the daily chart gets exactly 7 and 30 days, without today", () => {
  for (const [range, n] of [
    ["7d", 7],
    ["30d", 30],
  ] as const) {
    const { from, to } = windowPeriod(range, MIDDAY);
    const days = enumerateDays(from, to);
    assert.equal(days.length, n);
    assert.ok(!days.includes("2026-09-28"));
  }
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
