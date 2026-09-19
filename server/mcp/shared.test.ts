import { test } from "node:test";
import assert from "node:assert/strict";
import {
  invertedPeriodError,
  periodLengthInDays,
  hasDeclaredProp,
} from "./shared.js";

function errorMessage(result: ReturnType<typeof invertedPeriodError>) {
  return result === undefined
    ? undefined
    : (JSON.parse(result.content[0]!.text) as { error: string }).error;
}

test("invertedPeriodError passes a normal period through", () => {
  assert.equal(
    invertedPeriodError("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"),
    undefined,
  );
});

// A single-instant period is degenerate but not a mistake — an event
// could land exactly on it.
test("invertedPeriodError allows from === to", () => {
  assert.equal(
    invertedPeriodError("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
    undefined,
  );
});

// Without this, swapped arguments produce an empty result, which an
// agent reports as "no data" with full confidence — the same class of
// silent wrong answer normalizePeriodBound exists to prevent.
test("invertedPeriodError catches swapped bounds and names both", () => {
  const message = errorMessage(
    invertedPeriodError("2026-09-30T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
  );
  assert.match(message!, /inverted/);
  assert.match(message!, /2026-09-30/);
  assert.match(message!, /2026-09-01/);
});

// String comparison is only valid because both bounds are already
// normalized to the exact shape toISOString() produces — the same
// property every metrics query relies on when comparing ts in SQL.
test("invertedPeriodError compares by instant, not lexically by accident", () => {
  assert.equal(
    invertedPeriodError("2026-09-09T23:59:59.999Z", "2026-09-10T00:00:00.000Z"),
    undefined,
  );
  assert.notEqual(
    invertedPeriodError("2026-09-10T00:00:00.000Z", "2026-09-09T23:59:59.999Z"),
    undefined,
  );
});

test("periodLengthInDays counts both ends", () => {
  assert.equal(
    periodLengthInDays("2026-09-01T00:00:00.000Z", "2026-09-01T23:59:59.999Z"),
    1,
    "a single day is 1, not 0",
  );
  assert.equal(
    periodLengthInDays("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"),
    30,
  );
});

// The case that made a cap necessary: unbounded, this produced 3.65M
// day entries and a 250MB response.
test("periodLengthInDays handles an all-time range", () => {
  assert.equal(
    periodLengthInDays("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"),
    3_652_059,
  );
});

// `in` would match inherited Object.prototype keys, so these passed the
// guard and produced an empty breakdown rather than the explanatory
// error an undeclared prop is supposed to get — the "a mistake must
// look like a mistake" rule, broken by one keyword.
test("hasDeclaredProp rejects inherited Object.prototype keys", () => {
  for (const inherited of ["constructor", "toString", "valueOf"]) {
    assert.equal(
      hasDeclaredProp("page_view", inherited),
      false,
      `"${inherited}" is not a declared prop of page_view`,
    );
  }
});

test("hasDeclaredProp still accepts a genuinely declared prop", () => {
  assert.equal(hasDeclaredProp("page_view", "page_title"), true);
});
