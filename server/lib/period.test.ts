import test from "node:test";
import assert from "node:assert/strict";
import { normalizePeriodBound } from "./period.js";

test("normalizePeriodBound leaves an already-canonical timestamp alone", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T14:05:06.123Z", "from"),
    "2026-09-30T14:05:06.123Z",
  );
});

test("normalizePeriodBound expands a bare date to the start of the day for `from`", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30", "from"),
    "2026-09-30T00:00:00.000Z",
  );
});

// The bug this whole module exists for: a bare date as an upper bound
// used to sort below every real timestamp on that day, dropping all of it.
test("normalizePeriodBound expands a bare date to the END of the day for `to`", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30", "to"),
    "2026-09-30T23:59:59.999Z",
  );
});

test("normalizePeriodBound adds missing milliseconds", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T00:00:00Z", "from"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound converts a non-UTC offset to UTC", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T02:00:00+02:00", "from"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound tolerates surrounding whitespace", () => {
  assert.equal(
    normalizePeriodBound("  2026-09-30  ", "from"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound throws on an unparseable value", () => {
  assert.throws(
    () => normalizePeriodBound("last tuesday", "from"),
    /Invalid ISO8601 date/,
  );
});

// JS would roll this over to March 2nd rather than rejecting it, which
// would silently widen the requested window by two days.
test("normalizePeriodBound throws on a day that rolls over into the next month", () => {
  assert.throws(
    () => normalizePeriodBound("2026-02-30", "from"),
    /not a real calendar date/,
  );
});

test("normalizePeriodBound throws on an out-of-range month", () => {
  assert.throws(
    () => normalizePeriodBound("2026-13-01", "from"),
    /Invalid ISO8601 date/,
  );
});

// A genuine leap day must still be accepted — the round-trip check
// above must not be so strict that it rejects real dates.
test("normalizePeriodBound accepts a real leap day", () => {
  assert.equal(
    normalizePeriodBound("2028-02-29", "from"),
    "2028-02-29T00:00:00.000Z",
  );
});

// An offset timestamp legitimately lands on a different UTC calendar
// day than the one written, so the round-trip check must not apply here.
test("normalizePeriodBound accepts an offset timestamp that shifts to the previous UTC day", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T01:00:00+02:00", "from"),
    "2026-09-29T23:00:00.000Z",
  );
});

test("normalizePeriodBound throws on an empty string", () => {
  assert.throws(() => normalizePeriodBound("", "from"), /Invalid ISO8601 date/);
});

// The end-of-day expansion must not leak into the next day, since `to`
// is an inclusive bound in every query that consumes it.
test("normalizePeriodBound's end-of-day bound stays inside the same day", () => {
  const to = normalizePeriodBound("2026-09-30", "to");
  assert.equal(to.slice(0, 10), "2026-09-30");
  assert.ok(to < "2026-10-01T00:00:00.000Z");
});
