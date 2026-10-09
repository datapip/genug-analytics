import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { insertRejectedEvent } from "../db/rejectedEvents.js";
import { getCollectionHealth } from "./collectionHealth.js";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-07T12:00:00.000Z");

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function add(db: Database.Database, event: string, at: Date) {
  insertEvent(db, {
    event,
    visitorId: "v1",
    sessionId: "s1",
    ts: at.toISOString(),
    url: "https://example.com/",
    props: {},
  });
}

// One event every `everyHours`, newest `lastAgoHours` before NOW, going
// back `days` days from the newest.
function seed(
  db: Database.Database,
  event: string,
  everyHours: number,
  lastAgoHours: number,
  days: number,
) {
  const last = NOW.getTime() - lastAgoHours * HOUR;
  for (let t = last; t >= last - days * 24 * HOUR; t -= everyHours * HOUR) {
    add(db, event, new Date(t));
  }
}

test("an empty database is never_seen, not a normal zero", () => {
  const health = getCollectionHealth(setupDb(), NOW, "page_view");
  assert.equal(health.events.verdict, "never_seen");
  assert.equal(health.pageViews.verdict, "never_seen");
  assert.equal(health.events.lastSeen, null);
  assert.equal(health.eventsLast24h, 0);
});

test("a deployment under three days old says too_little_to_tell", () => {
  const db = setupDb();
  // Hourly for two days, then silent for ten hours: a long silence for
  // this history, but two days teach nothing about what is usual.
  seed(db, "page_view", 1, 10, 2);
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.events.verdict, "too_little_to_tell");
});

test("a single event in the window leaves no gap to learn from", () => {
  const db = setupDb();
  add(db, "page_view", new Date(NOW.getTime() - 20 * 24 * HOUR));
  add(db, "page_view", new Date(NOW.getTime() - 5 * HOUR));
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.events.longestEarlierGapHours, null);
  assert.equal(health.events.verdict, "too_little_to_tell");
});

test("a site silent for longer than the lookback is longer_than_usual", () => {
  const db = setupDb();
  // Hourly for two months, then nothing for fifteen days. Learned from
  // the two weeks before now, there would be no events at all and the
  // answer would be too_little_to_tell for the worst outage there is.
  seed(db, "page_view", 1, 15 * 24, 60);
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.events.longestEarlierGapHours, 1);
  assert.equal(health.events.verdict, "longer_than_usual");
  assert.equal(health.pageViews.verdict, "longer_than_usual");
});

test("a quiet site is judged on the gaps before its last event", () => {
  const db = setupDb();
  // One event every four days, the last ten days ago: only one of them
  // falls in the two weeks before now, but several in the two weeks
  // before the last one.
  seed(db, "page_view", 96, 10 * 24, 30);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.longestEarlierGapHours, 96);
  assert.equal(events.verdict, "longer_than_usual");
});

test("a silence inside the usual range is normal", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 5, 10);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.longestEarlierGapHours, 12);
  assert.equal(events.hoursSince, 5);
  assert.equal(events.verdict, "normal");
});

test("a silence beyond anything in the last two weeks is longer_than_usual", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 30, 10);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.hoursSince, 30);
  assert.equal(events.verdict, "longer_than_usual");
});

test("the silence that is still going on does not count as a past gap", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 40, 10);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  // If the trailing 40 hours leaked into the gap, hoursSince could never
  // exceed it and an outage would always read as normal.
  assert.equal(events.longestEarlierGapHours, 12);
});

test("a lull under an hour is not flagged on a busy site", () => {
  const db = setupDb();
  // Every six minutes for four days: the longest gap is six minutes,
  // and forty minutes without an event is well past it.
  seed(db, "page_view", 0.1, 40 / 60, 4);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.ok(events.hoursSince! > events.longestEarlierGapHours!);
  assert.equal(events.verdict, "normal");
});

test("page views are judged on their own while other events keep arriving", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 50, 10);
  seed(db, "signup", 6, 1, 10);
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.events.verdict, "normal");
  assert.equal(health.pageViews.verdict, "longer_than_usual");
});

test("the page-view name is the one passed in, not a hardcoded one", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 5, 10);
  const health = getCollectionHealth(db, NOW, "screen_view");
  assert.equal(health.pageViews.verdict, "never_seen");
});

test("counts events and rejections from the last 24 hours only", () => {
  const db = setupDb();
  add(db, "page_view", new Date(NOW.getTime() - 25 * HOUR));
  add(db, "page_view", new Date(NOW.getTime() - 23 * HOUR));
  insertRejectedEvent(
    db,
    "unknown_event_type",
    new Date(NOW.getTime() - 26 * HOUR).toISOString(),
    "typo",
  );
  insertRejectedEvent(
    db,
    "unknown_event_type",
    new Date(NOW.getTime() - HOUR).toISOString(),
    "typo",
  );
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.eventsLast24h, 1);
  assert.equal(health.rejectedLast24h, 1);
});

test("the one-hour floor is a lower bound, not a mute", () => {
  const db = setupDb();
  seed(db, "page_view", 0.1, 1.5, 4);
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.verdict, "longer_than_usual");
});

test("history age is measured per event, so a young page-view stream says so", () => {
  const db = setupDb();
  seed(db, "signup", 6, 1, 10);
  seed(db, "page_view", 6, 1, 1);
  const health = getCollectionHealth(db, NOW, "page_view");
  assert.equal(health.events.verdict, "normal");
  assert.equal(health.pageViews.verdict, "too_little_to_tell");
});

test("three days of history is enough, just under is not", () => {
  const enough = setupDb();
  const young = setupDb();
  for (const [db, firstAgo] of [
    [enough, 72],
    [young, 71],
  ] as const) {
    add(db, "page_view", new Date(NOW.getTime() - firstAgo * HOUR));
    add(db, "page_view", new Date(NOW.getTime() - 30 * HOUR));
    add(db, "page_view", new Date(NOW.getTime() - 6 * HOUR));
  }
  assert.equal(
    getCollectionHealth(enough, NOW, "page_view").events.verdict,
    "normal",
  );
  assert.equal(
    getCollectionHealth(young, NOW, "page_view").events.verdict,
    "too_little_to_tell",
  );
});

test("the longest gap earlier in the window is the one learned", () => {
  const db = setupDb();
  // Every six hours for twelve days, minus a 30-hour hole eight days ago.
  for (let h = 20; h <= 288; h += 6) {
    if (h > 194 && h < 224) continue;
    add(db, "page_view", new Date(NOW.getTime() - h * HOUR));
  }
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.longestEarlierGapHours, 30);
  assert.equal(events.hoursSince, 20);
  assert.equal(events.verdict, "normal");
});

test("a row dated after now is ignored", () => {
  const db = setupDb();
  seed(db, "page_view", 12, 5, 10);
  add(db, "page_view", new Date(NOW.getTime() + 2 * HOUR));
  const { events } = getCollectionHealth(db, NOW, "page_view");
  assert.equal(events.hoursSince, 5);
  assert.equal(
    events.lastSeen,
    new Date(NOW.getTime() - 5 * HOUR).toISOString(),
  );
});
