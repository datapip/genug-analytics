import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { buildSegment } from "./segment.js";
import { insertEvent } from "../db/events.js";
import {
  getEventsByProperty,
  getEntryEvents,
  getExitEvents,
  getPropertySum,
  getTopEvents,
  getEventTrend,
  isValidPropertyKey,
} from "./events.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

test("getTopEvents ranks every event type by count within the period, respecting limit", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:02:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
    },
  });

  const result = getTopEvents(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
  ).items;

  assert.deepEqual(result, [
    { event: "page_view", events: 2 },
    { event: "outbound_link_click", events: 1 },
  ]);
});

test("isValidPropertyKey accepts only lowercase letters, digits, and underscores", () => {
  assert.equal(isValidPropertyKey("product_id"), true);
  assert.equal(isValidPropertyKey("product_id_2"), true);
  assert.equal(isValidPropertyKey("productId2"), false);
  assert.equal(isValidPropertyKey("product.id"), false);
  assert.equal(isValidPropertyKey("$.product_id"), false);
  assert.equal(isValidPropertyKey(""), false);
});

test("getEventsByProperty groups one event type's occurrences by a prop value, excluding rows missing it", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
    },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
    },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T10:02:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/about",
      target_host: "partner.example.com",
      link_text: "About",
    },
  });
  // A different event type — must not be included even with the same prop.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v4",
    sessionId: "s4",
    ts: "2026-01-01T10:03:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getEventsByProperty(
    db,
    "outbound_link_click",
    "target_url",
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
  ).items;

  assert.deepEqual(result, [
    { value: "https://partner.example.com/pricing", events: 2 },
    { value: "https://partner.example.com/about", events: 1 },
  ]);
});

test("getPropertySum sums and averages a numeric prop, excluding rows missing it", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
      value: 49.9,
    },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
      value: 39.9,
    },
  });
  // Missing the "value" prop entirely — must not count toward sum,
  // average, or count.
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T10:02:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/about",
      target_host: "partner.example.com",
      link_text: "About",
    },
  });
  // A different event type — must not be included even with the same prop.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v4",
    sessionId: "s4",
    ts: "2026-01-01T10:03:00.000Z",
    url: "https://example.com/",
    props: { value: 1000 },
  });

  const result = getPropertySum(db, "outbound_link_click", "value", {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T23:59:59.999Z",
  });

  assert.deepEqual(result, { sum: 89.8, average: 44.9, values: 2 });
});

test("getPropertySum returns zeroes for a period with no matching events", () => {
  const db = setupDb();
  const result = getPropertySum(db, "outbound_link_click", "value", {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T23:59:59.999Z",
  });

  assert.deepEqual(result, { sum: 0, average: 0, values: 0 });
});

test("getEntryEvents ranks sessions by their first event type, regardless of a pageView tag", () => {
  const db = setupDb();
  // s1 and s2 both start with page_view; s3 starts with outbound_link_click.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T12:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/y",
      target_host: "partner.example.com",
      link_text: "y",
    },
  });

  const result = getEntryEvents(db, PERIOD, 10).items;

  assert.deepEqual(result, [
    { event: "page_view", sessions: 2 },
    { event: "outbound_link_click", sessions: 1 },
  ]);
});

test("getExitEvents ranks sessions by their last event type", () => {
  const db = setupDb();
  // s1 and s2 both end with outbound_link_click; s3 ends with page_view.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:05:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/y",
      target_host: "partner.example.com",
      link_text: "y",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T12:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getExitEvents(db, PERIOD, 10).items;

  assert.deepEqual(result, [
    { event: "outbound_link_click", sessions: 2 },
    { event: "page_view", sessions: 1 },
  ]);
});

test("getEntryEvents/getExitEvents return empty arrays for a period with no events", () => {
  const db = setupDb();
  assert.deepEqual(getEntryEvents(db, PERIOD, 10).items, []);
  assert.deepEqual(getExitEvents(db, PERIOD, 10).items, []);
});

// A list prop holds several values in one row. json_extract hands the
// whole array back as one opaque string, so grouping by it would group
// by the entire array — ["a","b"] and ["b","a"] would be two different
// "values". These tests pin the json_each expansion that makes a list
// queryable at all.
function insertArticle(
  db: Database.Database,
  id: string,
  tags: string[],
  prices: number[] = [],
) {
  insertEvent(db, {
    event: "article_read",
    visitorId: id,
    sessionId: id,
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/a",
    props: { tags, prices },
  });
}

test("getEventsByProperty counts each value of a list prop separately", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["pricing", "analytics"]);
  insertArticle(db, "v2", ["pricing"]);
  insertArticle(db, "v3", ["privacy"]);

  const result = getEventsByProperty(
    db,
    "article_read",
    "tags",
    PERIOD,
    10,
    true,
  ).items;

  // Ranked by count; the two on one apiece tie, and SQLite does not
  // promise an order between them, so only the ranking is asserted.
  assert.deepEqual(result[0], { value: "pricing", events: 2 });
  assert.deepEqual(
    result
      .slice(1)
      .sort((a, b) => String(a.value).localeCompare(String(b.value))),
    [
      { value: "analytics", events: 1 },
      { value: "privacy", events: 1 },
    ],
  );
  // Four counts across three events: one event contributes to every
  // value it carries, which is why the tool description says these do
  // not add up to the event total.
  assert.equal(
    result.reduce((total, row) => total + row.events, 0),
    4,
  );
});

// COUNT(DISTINCT events.id), not COUNT(*): the question is how many
// events carry a value, not how many times it was written down.
test("getEventsByProperty counts an event once even if it repeats a value", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["pricing", "pricing", "pricing"]);

  assert.deepEqual(
    getEventsByProperty(db, "article_read", "tags", PERIOD, 10, true).items,
    [{ value: "pricing", events: 1 }],
  );
});

test("getEventsByProperty ignores an event whose list is empty", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["pricing"]);
  insertArticle(db, "v2", []);

  assert.deepEqual(
    getEventsByProperty(db, "article_read", "tags", PERIOD, 10, true).items,
    [{ value: "pricing", events: 1 }],
  );
});

// Reading a list prop without the flag is what the old code did to
// every array: one bucket holding the serialized array, which is
// useless rather than wrong-looking. Pinned so the flag is visibly
// load-bearing.
test("getEventsByProperty without the list flag groups by the whole array", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["pricing", "analytics"]);

  const result = getEventsByProperty(
    db,
    "article_read",
    "tags",
    PERIOD,
    10,
  ).items;
  assert.equal(result.length, 1);
  assert.equal(result[0]!.value, '["pricing","analytics"]');
});

test("getPropertySum adds up every value across every list", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["x"], [0.5, 0.75]);
  insertArticle(db, "v2", ["x"], [1.25]);

  const result = getPropertySum(db, "article_read", "prices", PERIOD, true);

  // count is values, not events — three numbers over two events — so
  // sum / count is the average, which is the relationship a reader will
  // assume holds.
  assert.deepEqual(result, { sum: 2.5, average: 0.83, values: 3 });
});

test("getPropertySum returns zeroes when every list is empty", () => {
  const db = setupDb();
  insertArticle(db, "v1", ["x"], []);

  assert.deepEqual(getPropertySum(db, "article_read", "prices", PERIOD, true), {
    sum: 0,
    average: 0,
    values: 0,
  });
});

// Same edge as the page-scoped queries in content.test.ts: a session
// belongs to the period it started in, and its first and last event are
// read from its full length.
test("getEntryEvents/getExitEvents scope sessions by their start and read them in full", () => {
  const db = setupDb();
  const period = {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T23:59:59.999Z",
  };
  // s1 began before the period: not counted at all.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2025-12-31T23:55:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "file_download",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:05:00.000Z",
    url: "https://example.com/",
    props: {
      file_url: "https://example.com/a.pdf",
      file_extension: "pdf",
      link_text: "PDF",
    },
  });
  // s2 began in the period and ended after it with a download.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T23:50:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "file_download",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-02T00:10:00.000Z",
    url: "https://example.com/",
    props: {
      file_url: "https://example.com/b.pdf",
      file_extension: "pdf",
      link_text: "PDF",
    },
  });

  assert.deepEqual(getEntryEvents(db, period, 10).items, [
    { event: "page_view", sessions: 1 },
  ]);
  assert.deepEqual(getExitEvents(db, period, 10).items, [
    { event: "file_download", sessions: 1 },
  ]);
});

test("getEventTrend counts one event per day, zero-filled, with sessions and visitors", () => {
  const db = setupDb();
  const rows = [
    ["v1", "s1", "2026-01-01T10:00:00.000Z"],
    ["v1", "s1", "2026-01-01T10:01:00.000Z"],
    ["v2", "s2", "2026-01-01T11:00:00.000Z"],
    ["v1", "s3", "2026-01-03T10:00:00.000Z"],
  ] as const;
  for (const [visitor, session, ts] of rows) {
    insertEvent(db, {
      event: "file_download",
      visitorId: visitor,
      sessionId: session,
      ts,
      url: "https://example.com/",
      props: {
        file_url: "https://example.com/a.pdf",
        file_extension: "pdf",
        link_text: "PDF",
      },
    });
  }
  // A different event on the quiet day must not show up.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v9",
    sessionId: "s9",
    ts: "2026-01-02T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  assert.deepEqual(
    getEventTrend(db, "file_download", {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-03T23:59:59.999Z",
    }),
    [
      { date: "2026-01-01", events: 3, sessions: 2, visitors: 2 },
      { date: "2026-01-02", events: 0, sessions: 0, visitors: 0 },
      { date: "2026-01-03", events: 1, sessions: 1, visitors: 1 },
    ],
  );
});

// The segment clause is spliced between each statement's WHERE and the
// GROUP BY, for the scalar and the list variant alike; one segmented
// call each so a future edit to that splice has something to trip.
test("getEventsByProperty and getPropertySum apply a segment to the list variants", () => {
  const db = setupDb();
  for (const [session, device, tags, prices] of [
    ["s1", "mobile", ["a", "b"], [1, 2]],
    ["s2", "desktop", ["a"], [10]],
  ] as const) {
    insertEvent(db, {
      event: "article_read",
      visitorId: session,
      sessionId: session,
      ts: "2026-01-01T10:00:00.000Z",
      url: "https://example.com/",
      deviceType: device,
      props: { tags: [...tags], sections: [...prices] },
    });
  }
  const mobile = buildSegment(
    db,
    [{ kind: "deviceType", value: "mobile" }],
    PERIOD,
    "page_view",
  );

  assert.deepEqual(
    getEventsByProperty(db, "article_read", "tags", PERIOD, 10, true, mobile)
      .items,
    [
      { value: "a", events: 1 },
      { value: "b", events: 1 },
    ],
  );
  assert.deepEqual(
    getPropertySum(db, "article_read", "sections", PERIOD, true, mobile),
    { sum: 3, average: 1.5, values: 2 },
  );
});
