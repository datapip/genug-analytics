import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { getRecentEvents } from "./recentEvents.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("getRecentEvents returns rows newest-first with props parsed back to an object, respecting limit", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: { page_title: "Home", document_language: "en" },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    referrer: "https://www.google.com/",
    deviceType: "desktop",
    browser: "Firefox",
    consentMode: "consentless",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
    },
  });

  const result = getRecentEvents(db, 1).rows;

  assert.deepEqual(result, [
    {
      event: "outbound_link_click",
      url: "https://example.com/",
      ts: "2026-01-01T10:01:00.000Z",
      props: {
        target_url: "https://partner.example.com/pricing",
        target_host: "partner.example.com",
        link_text: "Pricing",
      },
      sessionId: "s1",
      consentMode: "consentless",
      referrer: "https://www.google.com/",
      deviceType: "desktop",
      browser: "Firefox",
    },
  ]);
});

test("getRecentEvents stops at the character budget and says so, newest rows first", () => {
  const db = setupDb();
  for (let i = 0; i < 5; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: "s1",
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/",
      props: { page_title: "x".repeat(1000) },
    });
  }

  const { rows, truncated } = getRecentEvents(db, 5, 2500);

  assert.equal(truncated, true);
  assert.deepEqual(
    rows.map((r) => r.ts),
    ["2026-01-01T10:04:00.000Z", "2026-01-01T10:03:00.000Z"],
  );
});

test("getRecentEvents keeps the newest row even when it alone is over budget", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: { page_title: "x".repeat(1000) },
  });

  const { rows, truncated } = getRecentEvents(db, 5, 100);

  assert.equal(rows.length, 1);
  assert.equal(truncated, false);
});
