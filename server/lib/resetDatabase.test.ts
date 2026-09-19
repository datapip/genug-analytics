import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { insertRejectedEvent } from "../db/rejectedEvents.js";
import { insertBotActivity } from "../db/botActivity.js";
import { resetDatabase } from "./resetDatabase.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("resetDatabase empties events, rejected_events and bot_activity, and reports how many rows each held", () => {
  const db = setupDb();
  const ts = "2026-01-01T00:00:00.000Z";

  insertEvent(db, {
    event: "page_view",
    visitorId: "visitor-1",
    sessionId: "session-1",
    ts,
    url: "https://site.example/",
    props: {},
  });
  insertRejectedEvent(db, "unknown_event_type", ts, "bogus_event");
  insertBotActivity(db, ts, 5);

  const result = resetDatabase(db);

  assert.deepEqual(result, {
    eventsDeleted: 1,
    rejectedEventsDeleted: 1,
    botActivityDeleted: 1,
  });

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    0,
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM rejected_events").get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM bot_activity").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("resetDatabase on an already-empty database reports zeroes rather than failing", () => {
  const db = setupDb();
  assert.deepEqual(resetDatabase(db), {
    eventsDeleted: 0,
    rejectedEventsDeleted: 0,
    botActivityDeleted: 0,
  });
});
