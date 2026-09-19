import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertRejectedEvent } from "../db/rejectedEvents.js";
import {
  getTopRejectedEvents,
  getRejectedEventCount,
} from "./rejectedEvents.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

test("getTopRejectedEvents groups by reason and event, ranked by count descending", () => {
  const db = setupDb();
  // Distinct counts per group (3, 2, 1) — SQL doesn't guarantee a stable
  // order among ties, so equal counts would make this test flaky.
  for (let i = 0; i < 3; i++) {
    insertRejectedEvent(
      db,
      "unknown_event_type",
      `2026-01-01T10:0${i}:00.000Z`,
      "produt_added_to_cart",
    );
  }
  for (let i = 0; i < 2; i++) {
    insertRejectedEvent(
      db,
      "invalid_props",
      `2026-01-01T11:0${i}:00.000Z`,
      "order_completed",
    );
  }
  insertRejectedEvent(db, "invalid_envelope", "2026-01-01T12:00:00.000Z");

  const result = getTopRejectedEvents(db, PERIOD, 10).items;

  assert.deepEqual(result, [
    {
      reason: "unknown_event_type",
      event: "produt_added_to_cart",
      requests: 3,
      lastDetail: null,
      lastSeen: "2026-01-01T10:02:00.000Z",
    },
    {
      reason: "invalid_props",
      event: "order_completed",
      requests: 2,
      lastDetail: null,
      lastSeen: "2026-01-01T11:01:00.000Z",
    },
    {
      reason: "invalid_envelope",
      event: null,
      requests: 1,
      lastDetail: null,
      lastSeen: "2026-01-01T12:00:00.000Z",
    },
  ]);
});

test("getTopRejectedEvents' lastDetail and lastSeen both come from the most recent occurrence, not the first", () => {
  const db = setupDb();
  insertRejectedEvent(
    db,
    "invalid_props",
    "2026-01-01T10:00:00.000Z",
    "order_completed",
    "value: Expected number, received string",
  );
  insertRejectedEvent(
    db,
    "invalid_props",
    "2026-01-01T11:00:00.000Z",
    "order_completed",
    "currency: Required",
  );

  const result = getTopRejectedEvents(db, PERIOD, 10).items;

  assert.deepEqual(result, [
    {
      reason: "invalid_props",
      event: "order_completed",
      requests: 2,
      lastDetail: "currency: Required",
      lastSeen: "2026-01-01T11:00:00.000Z",
    },
  ]);
});

test("getTopRejectedEvents respects the period boundary", () => {
  const db = setupDb();
  insertRejectedEvent(db, "invalid_envelope", "2025-12-31T23:59:59.000Z"); // before PERIOD
  const result = getTopRejectedEvents(db, PERIOD, 10).items;
  assert.deepEqual(result, []);
});

test("getRejectedEventCount returns the total within a period", () => {
  const db = setupDb();
  insertRejectedEvent(
    db,
    "unknown_event_type",
    "2026-01-01T10:00:00.000Z",
    "a",
  );
  insertRejectedEvent(db, "invalid_props", "2026-01-01T10:01:00.000Z", "b");
  insertRejectedEvent(db, "invalid_envelope", "2025-12-31T23:59:59.000Z"); // outside PERIOD

  assert.equal(getRejectedEventCount(db, PERIOD), 2);
});

test("getRejectedEventCount is 0 for an empty table", () => {
  const db = setupDb();
  assert.equal(getRejectedEventCount(db, PERIOD), 0);
});
