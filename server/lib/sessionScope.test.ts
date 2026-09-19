import { test } from "node:test";
import assert from "node:assert/strict";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// Assertions about the SQL itself, which is unusual here and
// deliberate: both properties are invisible to a test that only checks
// numbers. Losing the floor changes no answer, only how much of the
// table every session-scoped query walks — a defect that shows up as a
// slow cockpit two years later. Gaining a ceiling changes answers, in
// the one direction the straddling-session tests in content.test.ts
// already guard.
const outerCondition = IN_SESSION_STARTED_IN_PERIOD.slice(
  0,
  IN_SESSION_STARTED_IN_PERIOD.indexOf("AND session_id IN ("),
);

test("the condition bounds the outer query by the period's start", () => {
  assert.match(outerCondition, /ts >= @from/);
});

// >=, not >. A session whose very first event lands exactly on @from
// belongs to this period, and a strict comparison would drop that row
// while keeping the session — reporting its *second* page as where it
// entered. The behavioural half of this is in content.test.ts.
test("the bound includes the instant the period starts", () => {
  assert.doesNotMatch(outerCondition, /ts > @from/);
});

// A session that started inside the period is read in full, including
// what it did after the period ended — that is where a session starting
// late genuinely exited. A ceiling here would look symmetrical and be
// wrong.
test("the condition puts no ceiling on the outer query", () => {
  assert.doesNotMatch(outerCondition, /@to/);
});
