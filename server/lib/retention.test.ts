import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { insertRejectedEvent } from "../db/rejectedEvents.js";
import { insertBotActivity } from "../db/botActivity.js";
import {
  DEFAULT_RETENTION_DAYS,
  parseRetentionDays,
  pruneOldEvents,
  pruneOldRejectedEvents,
  pruneOldBotActivity,
  countEventsForVisitor,
  deleteVisitorData,
} from "./retention.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("parseRetentionDays defaults to DEFAULT_RETENTION_DAYS when unset", () => {
  assert.equal(parseRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
});

test("parseRetentionDays parses a valid positive number", () => {
  assert.equal(parseRetentionDays("30"), 30);
});

// -1 is the explicit way to ask for unlimited retention now that unset
// no longer means it — same return value (undefined) as unset used to
// produce, which is what tells the callers below "don't prune".
test("parseRetentionDays treats -1 as unlimited, on purpose", () => {
  assert.equal(parseRetentionDays("-1"), undefined);
});

// 0 is deliberately not the sentinel — "0 days" reads as "keep
// nothing", the opposite of unlimited — and gets its own message
// rather than falling into the generic one below, naming -1 as the
// value that actually means what someone reaching for 0 probably
// wants.
test("parseRetentionDays refuses 0, naming -1 as the right value", () => {
  assert.throws(() => parseRetentionDays("0"), /Use -1 for no limit/);
});

test("parseRetentionDays throws for other negative or non-numeric values", () => {
  assert.throws(() => parseRetentionDays("-5"));
  assert.throws(() => parseRetentionDays("not-a-number"));
});

test("pruneOldEvents deletes only events older than the cutoff", () => {
  const db = setupDb();
  const now = Date.now();
  const oldTs = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
  const recentTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: oldTs,
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: recentTs,
    url: "https://example.com/",
    props: {},
  });

  const deleted = pruneOldEvents(db, 30);

  assert.equal(deleted, 1);
  const remaining = db.prepare("SELECT visitor_id FROM events").all() as {
    visitor_id: string;
  }[];
  assert.deepEqual(
    remaining.map((r) => r.visitor_id),
    ["v2"],
  );
});

test("pruneOldRejectedEvents deletes only rejected events older than the cutoff", () => {
  const db = setupDb();
  const now = Date.now();
  const oldTs = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
  const recentTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  insertRejectedEvent(db, "invalid_envelope", oldTs);
  insertRejectedEvent(db, "unknown_event_type", recentTs, "typo_event");

  const deleted = pruneOldRejectedEvents(db, 30);

  assert.equal(deleted, 1);
  const remaining = db.prepare("SELECT reason FROM rejected_events").all() as {
    reason: string;
  }[];
  assert.deepEqual(
    remaining.map((r) => r.reason),
    ["unknown_event_type"],
  );
});

test("pruneOldBotActivity deletes only bot activity rows older than the cutoff", () => {
  const db = setupDb();
  const now = Date.now();
  const oldTs = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
  const recentTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  insertBotActivity(db, oldTs, 10);
  insertBotActivity(db, recentTs, 5);

  const deleted = pruneOldBotActivity(db, 30);

  assert.equal(deleted, 1);
  const remaining = db.prepare("SELECT count FROM bot_activity").all() as {
    count: number;
  }[];
  assert.deepEqual(
    remaining.map((r) => r.count),
    [5],
  );
});

test("countEventsForVisitor and deleteVisitorData only affect the given visitor", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:01:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  assert.equal(countEventsForVisitor(db, "v1"), 2);
  assert.equal(countEventsForVisitor(db, "v2"), 1);
  assert.equal(countEventsForVisitor(db, "unknown"), 0);

  const deleted = deleteVisitorData(db, "v1");

  assert.equal(deleted, 2);
  assert.equal(countEventsForVisitor(db, "v1"), 0);
  assert.equal(countEventsForVisitor(db, "v2"), 1);
});
