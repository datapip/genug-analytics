import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";
import { insertEvent, findLastEventForVisitor } from "./events.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("findLastEventForVisitor returns undefined for an unknown visitor", () => {
  const db = setupDb();
  assert.equal(findLastEventForVisitor(db, "nobody"), undefined);
});

test("insertEvent then findLastEventForVisitor round-trips session_id and ts", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "visitor-1",
    sessionId: "session-1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    props: { page_title: "Home", document_language: "en" },
  });

  const last = findLastEventForVisitor(db, "visitor-1");
  assert.deepEqual(last, {
    sessionId: "session-1",
    ts: "2026-01-01T00:00:00.000Z",
  });
});

test("findLastEventForVisitor returns the most recent row by ts", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "visitor-1",
    sessionId: "session-1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com/a",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "visitor-1",
    sessionId: "session-2",
    ts: "2026-01-01T01:00:00.000Z",
    url: "https://example.com/b",
    props: {},
  });

  const last = findLastEventForVisitor(db, "visitor-1");
  assert.equal(last?.sessionId, "session-2");
});

test("insertEvent stores consentMode when given", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    props: {},
    consentMode: "consentful",
  });

  const row = db.prepare("SELECT consent_mode FROM events").get() as {
    consent_mode: string | null;
  };
  assert.equal(row.consent_mode, "consentful");
});

// There is no third "unknown" consent state: the envelope's own consent
// field defaults to false, so an event that says nothing about consent
// was not collected with consent. The column is NOT NULL to keep that
// true at the storage layer, not just by convention.
test("insertEvent stores consentless when no consent mode is given", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    props: {},
  });

  const row = db.prepare("SELECT consent_mode FROM events").get() as {
    consent_mode: string;
  };
  assert.equal(row.consent_mode, "consentless");
});

test("insertEvent without idempotencyKey always inserts and returns true", () => {
  const db = setupDb();
  const inserted = insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    props: {},
  });
  assert.equal(inserted, true);
});

test("insertEvent with a duplicate (event, idempotencyKey) pair is a no-op the second time", () => {
  const db = setupDb();
  const first = insertEvent(db, {
    event: "order_completed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com/thank-you",
    props: { value: 49.9 },
    idempotencyKey: "ORD-1001",
  });
  const second = insertEvent(db, {
    // Refreshed confirmation page: same order, later timestamp/session.
    event: "order_completed",
    visitorId: "v1",
    sessionId: "s2",
    ts: "2026-01-01T00:05:00.000Z",
    url: "https://example.com/thank-you",
    props: { value: 49.9 },
    idempotencyKey: "ORD-1001",
  });

  assert.equal(first, true);
  assert.equal(second, false);

  const rows = db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE event = ?")
    .get("order_completed") as { count: number };
  assert.equal(rows.count, 1);
});

test("insertEvent treats the same idempotencyKey on a different event type as distinct", () => {
  const db = setupDb();
  const first = insertEvent(db, {
    event: "order_completed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com/thank-you",
    props: {},
    idempotencyKey: "ORD-1001",
  });
  const second = insertEvent(db, {
    event: "refund_issued",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T01:00:00.000Z",
    url: "https://example.com/thank-you",
    props: {},
    idempotencyKey: "ORD-1001",
  });

  assert.equal(first, true);
  assert.equal(second, true);
});

test("insertEvent never dedups multiple events that don't set idempotencyKey", () => {
  const db = setupDb();
  const first = insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    url: "https://example.com",
    props: {},
  });
  const second = insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:01:00.000Z",
    url: "https://example.com",
    props: {},
  });

  assert.equal(first, true);
  assert.equal(second, true);
});
