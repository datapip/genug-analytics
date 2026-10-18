import { test } from "node:test";
import assert from "node:assert/strict";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// These check the SQL text itself, because a test of the numbers can't
// see these properties: without `ts >= @from` the results are the same,
// only slower; an added `ts <= @to` would change results (also tested in
// content.test.ts).
const outerCondition = IN_SESSION_STARTED_IN_PERIOD.slice(
  0,
  IN_SESSION_STARTED_IN_PERIOD.indexOf("AND session_id IN ("),
);

test("the condition bounds the outer query by the period's start", () => {
  assert.match(outerCondition, /ts >= @from/);
});

// >=, not >: a session whose first event is exactly at @from belongs to
// the period, and > would drop that event and report its second page as
// the entry (also tested in content.test.ts).
test("the bound includes the instant the period starts", () => {
  assert.doesNotMatch(outerCondition, /ts > @from/);
});

// A session that started in the period is read in full, including after
// the period ended, so there must be no `ts <= @to`.
test("the condition puts no ceiling on the outer query", () => {
  assert.doesNotMatch(outerCondition, /@to/);
});
