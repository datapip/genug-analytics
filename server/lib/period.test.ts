import test from "node:test";
import assert from "node:assert/strict";
import { normalizePeriodBound } from "./period.js";

test("normalizePeriodBound leaves an already-canonical timestamp alone", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T14:05:06.123Z", "from", "UTC"),
    "2026-09-30T14:05:06.123Z",
  );
});

test("normalizePeriodBound expands a bare date to the start of the day for `from`", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30", "from", "UTC"),
    "2026-09-30T00:00:00.000Z",
  );
});

// A plain date as the upper bound must include that whole day; compared
// as text it would sort before every timestamp of the day.
test("normalizePeriodBound expands a bare date to the END of the day for `to`", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30", "to", "UTC"),
    "2026-09-30T23:59:59.999Z",
  );
});

test("normalizePeriodBound adds missing milliseconds", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T00:00:00Z", "from", "UTC"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound converts a non-UTC offset to UTC", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T02:00:00+02:00", "from", "UTC"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound tolerates surrounding whitespace", () => {
  assert.equal(
    normalizePeriodBound("  2026-09-30  ", "from", "UTC"),
    "2026-09-30T00:00:00.000Z",
  );
});

test("normalizePeriodBound throws on an unparseable value", () => {
  assert.throws(
    () => normalizePeriodBound("last tuesday", "from", "UTC"),
    /Invalid ISO8601 date/,
  );
});

// JavaScript would turn this into March 2nd instead of rejecting it,
// making the period two days longer.
test("normalizePeriodBound throws on a day that rolls over into the next month", () => {
  assert.throws(
    () => normalizePeriodBound("2026-02-30", "from", "UTC"),
    /not a real calendar date/,
  );
});

test("normalizePeriodBound throws on an out-of-range month", () => {
  assert.throws(
    () => normalizePeriodBound("2026-13-01", "from", "UTC"),
    /Invalid ISO8601 date/,
  );
});

// A real leap day must still be accepted.
test("normalizePeriodBound accepts a real leap day", () => {
  assert.equal(
    normalizePeriodBound("2028-02-29", "from", "UTC"),
    "2028-02-29T00:00:00.000Z",
  );
});

// A timestamp with an offset can fall on another day in UTC, so the
// date check must not apply to it.
test("normalizePeriodBound accepts an offset timestamp that shifts to the previous UTC day", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T01:00:00+02:00", "from", "UTC"),
    "2026-09-29T23:00:00.000Z",
  );
});

test("normalizePeriodBound throws on an empty string", () => {
  assert.throws(
    () => normalizePeriodBound("", "from", "UTC"),
    /Invalid ISO8601 date/,
  );
});

// The end of the day must not reach into the next day, since `to` is
// included in every query.
test("normalizePeriodBound's end-of-day bound stays inside the same day", () => {
  const to = normalizePeriodBound("2026-09-30", "to", "UTC");
  assert.equal(to.slice(0, 10), "2026-09-30");
  assert.ok(to < "2026-10-01T00:00:00.000Z");
});

// A plain date is a day in the site's time zone. In Berlin summer time
// the 30th starts at 22:00 UTC on the 29th and ends at 22:00 UTC on the
// 30th.
test("normalizePeriodBound reads a bare date as a day in the site's zone", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30", "from", "Europe/Berlin"),
    "2026-09-29T22:00:00.000Z",
  );
  assert.equal(
    normalizePeriodBound("2026-09-30", "to", "Europe/Berlin"),
    "2026-09-30T21:59:59.999Z",
  );
});

// 25 October 2026 lasts 25 hours in Berlin. 24 hours after its start
// would stop an hour short and drop that day's last hour.
test("normalizePeriodBound's day with a clock change runs to the next local midnight", () => {
  assert.equal(
    normalizePeriodBound("2026-10-25", "from", "Europe/Berlin"),
    "2026-10-24T22:00:00.000Z",
  );
  assert.equal(
    normalizePeriodBound("2026-10-25", "to", "Europe/Berlin"),
    "2026-10-25T22:59:59.999Z",
  );
});

// The time zone only affects plain dates; a timestamp has its own
// offset.
test("normalizePeriodBound leaves a full timestamp alone whatever the zone", () => {
  assert.equal(
    normalizePeriodBound("2026-09-30T14:00:00Z", "from", "Europe/Berlin"),
    "2026-09-30T14:00:00.000Z",
  );
});

test("normalizePeriodBound still refuses a day that rolls over, in any zone", () => {
  assert.throws(
    () => normalizePeriodBound("2026-02-30", "from", "Europe/Berlin"),
    /not a real calendar date/,
  );
});
