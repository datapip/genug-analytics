import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";
import { insertRejectedEvent } from "./rejectedEvents.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("insertRejectedEvent stores ts, reason, and event", () => {
  const db = setupDb();
  insertRejectedEvent(
    db,
    "unknown_event_type",
    "2026-01-01T00:00:00.000Z",
    "produt_added_to_cart",
  );

  const row = db.prepare("SELECT * FROM rejected_events").get() as {
    reason: string;
    event: string | null;
    ts: string;
  };
  assert.equal(row.reason, "unknown_event_type");
  assert.equal(row.event, "produt_added_to_cart");
  assert.equal(row.ts, "2026-01-01T00:00:00.000Z");
});

test("insertRejectedEvent stores a null event when none is known", () => {
  const db = setupDb();
  insertRejectedEvent(db, "invalid_envelope", "2026-01-01T00:00:00.000Z");

  const row = db.prepare("SELECT * FROM rejected_events").get() as {
    event: string | null;
  };
  assert.equal(row.event, null);
});

test("insertRejectedEvent stores a detail when given", () => {
  const db = setupDb();
  insertRejectedEvent(
    db,
    "invalid_props",
    "2026-01-01T00:00:00.000Z",
    "order_completed",
    "value: Expected number, received string",
  );

  const row = db.prepare("SELECT * FROM rejected_events").get() as {
    detail: string | null;
  };
  assert.equal(row.detail, "value: Expected number, received string");
});

test("insertRejectedEvent stores a null detail when none is given", () => {
  const db = setupDb();
  insertRejectedEvent(
    db,
    "unknown_event_type",
    "2026-01-01T00:00:00.000Z",
    "produt_added_to_cart",
  );

  const row = db.prepare("SELECT * FROM rejected_events").get() as {
    detail: string | null;
  };
  assert.equal(row.detail, null);
});
