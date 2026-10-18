import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { getOrphanedEvents } from "./orphanedEvents.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function add(db: Database.Database, event: string, ts: string) {
  insertEvent(db, {
    event,
    visitorId: "v1",
    sessionId: "s1",
    ts,
    url: "https://example.com/",
    props: {},
  });
}

test("finds nothing when every stored event is registered", () => {
  const db = setupDb();
  add(db, "page_view", "2026-01-01T10:00:00.000Z");
  assert.deepEqual(getOrphanedEvents(db, ["page_view", "file_download"]), []);
});

// page_view renamed to seitenaufruf: the rows from before the rename
// match no page query but still count in totals, which is hard to spot
// without a report.
test("reports rows left behind by a rename, with when they stop", () => {
  const db = setupDb();
  add(db, "page_view", "2026-01-01T10:00:00.000Z");
  add(db, "page_view", "2026-01-02T10:00:00.000Z");
  add(db, "seitenaufruf", "2026-01-03T10:00:00.000Z");

  assert.deepEqual(getOrphanedEvents(db, ["seitenaufruf"]), [
    {
      event: "page_view",
      events: 2,
      lastSeen: "2026-01-02T10:00:00.000Z",
    },
  ]);
});

test("ranks by count, most abandoned rows first", () => {
  const db = setupDb();
  add(db, "old_a", "2026-01-01T10:00:00.000Z");
  for (const ts of ["2026-01-01T10:00:00.000Z", "2026-01-01T11:00:00.000Z"]) {
    add(db, "old_b", ts);
  }

  assert.deepEqual(
    getOrphanedEvents(db, ["page_view"]).map((row) => row.event),
    ["old_b", "old_a"],
  );
});

// An empty table (a new deployment) and an empty registry (can't happen,
// but still) must give a sensible answer.
test("copes with no events at all", () => {
  assert.deepEqual(getOrphanedEvents(setupDb(), ["page_view"]), []);
});

// Unknown names are rejected by /events, so orphaned rows only come from
// the deployment's own renames, never from visitors. So returning all of
// them without a limit is safe.
test("is not something traffic can fill up", () => {
  const db = setupDb();
  add(db, "page_view", "2026-01-01T10:00:00.000Z");
  assert.deepEqual(getOrphanedEvents(db, ["page_view"]), []);
});
