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

// A period of one instant is allowed: an event could be exactly then.
test("invertedPeriodError allows from === to", () => {
  assert.equal(
    invertedPeriodError("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
    undefined,
  );
});

// Swapped dates must be an error; an empty result would be reported as
// "no data".
test("invertedPeriodError catches swapped bounds and names both", () => {
  const message = errorMessage(
    invertedPeriodError("2026-09-30T00:00:00.000Z", "2026-09-01T00:00:00.000Z"),
  );
  assert.match(message!, /inverted/);
  assert.match(message!, /2026-09-30/);
  assert.match(message!, /2026-09-01/);
});

// Comparing as text only works because both bounds are already in the
// toISOString() format, as every query relies on.
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

// Without a maximum, a period from year 1 would produce millions of
// days.
test("periodLengthInDays handles an all-time range", () => {
  assert.equal(
    periodLengthInDays("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"),
    3_652_059,
  );
});

// With `in`, built-in object keys would count as declared props and give
// an empty result instead of an error.
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
