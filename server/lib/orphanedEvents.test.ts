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

// The case this exists for: page_view renamed to seitenaufruf, and
// every row written before the rename now matching no page-scoped
// query — while still counting toward the totals, which is what makes
// it hard to spot without being told.
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

// An empty table is the normal case for a fresh deployment, and an
// empty registry can't happen (registry.ts refuses to start without a
// page-view event) — but neither should produce nonsense.
test("copes with no events at all", () => {
  assert.deepEqual(getOrphanedEvents(setupDb(), ["page_view"]), []);
});

// A name nothing registered can't get into this table — routes/events.ts
// rejects it at ingestion — so anything found here is the deployment's
// own doing, never a visitor's. That is what makes returning every row
// unbounded safe.
test("is not something traffic can fill up", () => {
  const db = setupDb();
  add(db, "page_view", "2026-01-01T10:00:00.000Z");
  assert.deepEqual(getOrphanedEvents(db, ["page_view"]), []);
});
