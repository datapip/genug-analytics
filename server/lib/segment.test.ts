import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { buildSegment, type SegmentCondition } from "./segment.js";
import { getTrafficSummary, getSessionSummary } from "./traffic.js";
import { getEntryPages } from "./content.js";
import type { Period } from "./period.js";

// The old single-condition segment tool, expressed through what replaced
// it: a segment clause pasted into the traffic summary. `visitors` is
// dropped from the result so the assertions below stay about what the
// segment selected.
function segmentSummary(
  db: Database.Database,
  filter: Omit<Extract<SegmentCondition, { kind: "event" }>, "kind">,
  period: Period,
  pageViewEvent: string,
) {
  const clause = buildSegment(
    db,
    [{ kind: "event", ...filter }],
    period,
    pageViewEvent,
  );
  const { sessions, interactionEvents, viewEvents } = getTrafficSummary(
    db,
    period,
    pageViewEvent,
    clause,
  );
  return { sessions, interactionEvents, viewEvents };
}

// The full summary for a segment built from any conditions.
function summaryFor(
  db: Database.Database,
  conditions: SegmentCondition[],
  period: Period = PERIOD,
) {
  return getTrafficSummary(
    db,
    period,
    "page_view",
    buildSegment(db, conditions, period, "page_view"),
  );
}

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

test("segment scopes to sessions containing the given event, event-only filter", () => {
  const db = setupDb();
  // v1's session did the event and has 3 events total.
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
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:02:00.000Z",
    url: "https://example.com/other",
    props: {},
  });
  // v2's session never clicked — must not be included.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = segmentSummary(
    db,
    { event: "outbound_link_click" },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 2,
  });
});

test("segment matches a string prop value", () => {
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
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/about",
      target_host: "partner.example.com",
      link_text: "About",
    },
  });

  const result = segmentSummary(
    db,
    {
      event: "outbound_link_click",
      property: "target_url",
      value: "https://partner.example.com/pricing",
    },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 0,
  });
});

test("segment matches a numeric prop value", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
      position: 2,
    },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/y",
      target_host: "partner.example.com",
      link_text: "y",
      position: 5,
    },
  });

  const result = segmentSummary(
    db,
    { event: "outbound_link_click", property: "position", value: 2 },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 0,
  });
});

test("segment matches a boolean prop value", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
      external: true,
    },
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/y",
      target_host: "partner.example.com",
      link_text: "y",
      external: false,
    },
  });

  const result = segmentSummary(
    db,
    { event: "outbound_link_click", property: "external", value: true },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 0,
  });
});

test("segment returns zeroes when nothing matches", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = segmentSummary(
    db,
    { event: "outbound_link_click" },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 0,
    interactionEvents: 0,
    viewEvents: 0,
  });
});

test("segment splits interactionEvents/viewEvents (additively, scoped to the matched sessions) when a pageViewEvent is given", () => {
  const db = setupDb();
  // s1: did the target event and has one page_view — counted.
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  // s2: did not do the target event — its page_view must not be counted.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = segmentSummary(
    db,
    { event: "outbound_link_click" },
    PERIOD,
    "page_view",
  );

  // 1 page_view (viewEvents) + 1 outbound_link_click (interactionEvents) —
  // additive, not overlapping.
  assert.deepEqual(result, {
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 1,
  });
});

test("segment reports viewEvents: 0 (not omitted) when nothing matches but a pageViewEvent is given", () => {
  const db = setupDb();
  const result = segmentSummary(
    db,
    { event: "outbound_link_click" },
    PERIOD,
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 0,
    interactionEvents: 0,
    viewEvents: 0,
  });
});

// The bug the subquery exists for: this used to materialize every
// matching session_id and rebind them one bound parameter each, against
// SQLite's cap of 32,766 — so it threw "too many SQL variables" instead
// of answering. Same ceiling funnel.ts chunks around, reached sooner
// here, because filtering on the page-view event selects essentially
// every session in the period.
test("survives more sessions than SQLite allows bound parameters", () => {
  const db = setupDb();
  const insert = db.prepare(
    "INSERT INTO events (event, visitor_id, session_id, ts, url, props, consent_mode) VALUES (?, ?, ?, ?, ?, ?, 'consentless')",
  );
  const sessions = 33_000;
  db.transaction(() => {
    for (let i = 0; i < sessions; i++) {
      insert.run(
        "page_view",
        `v${i}`,
        `s${i}`,
        "2026-01-01T10:00:00.000Z",
        "https://example.com/",
        "{}",
      );
    }
  })();

  const result = segmentSummary(
    db,
    { event: "page_view" },
    PERIOD,
    "page_view",
  );
  assert.deepEqual(result, {
    sessions,
    interactionEvents: 0,
    viewEvents: sessions,
  });
});

// The property-filtered branch binds two extra parameters and builds a
// different WHERE, so it needs its own pass over the same ceiling.
test("survives the same volume when filtering on a property value", () => {
  const db = setupDb();
  const insert = db.prepare(
    "INSERT INTO events (event, visitor_id, session_id, ts, url, props, consent_mode) VALUES (?, ?, ?, ?, ?, ?, 'consentless')",
  );
  const sessions = 33_000;
  db.transaction(() => {
    for (let i = 0; i < sessions; i++) {
      insert.run(
        "page_view",
        `v${i}`,
        `s${i}`,
        "2026-01-01T10:00:00.000Z",
        "https://example.com/",
        JSON.stringify({ page_title: "Home", document_language: "en" }),
      );
    }
  })();

  const result = segmentSummary(
    db,
    { event: "page_view", property: "document_language", value: "en" },
    PERIOD,
    "page_view",
  );
  assert.deepEqual(result, {
    sessions,
    interactionEvents: 0,
    viewEvents: sessions,
  });
});

// A list prop keeps its values inside one JSON array, so comparing
// json_extract to the value compares the whole serialized array and
// matches nothing — which would report zero sessions, an answer that
// reads as "nobody did this". These pin the json_each branch that makes
// the filter mean "carries this value".
function insertArticle(
  db: Database.Database,
  session: string,
  tags: string[],
  sections: number[] = [],
) {
  insertEvent(db, {
    event: "article_read",
    visitorId: session,
    sessionId: session,
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/a",
    props: { tags, sections },
  });
}

test("segment matches a value inside a list prop", () => {
  const db = setupDb();
  insertArticle(db, "s1", ["pricing", "analytics"]);
  insertArticle(db, "s2", ["privacy"]);

  assert.deepEqual(
    segmentSummary(
      db,
      {
        event: "article_read",
        property: "tags",
        value: "pricing",
        isList: true,
      },
      PERIOD,
      "page_view",
    ),
    { sessions: 1, interactionEvents: 1, viewEvents: 0 },
  );
});

// One event carrying the value several times is still one event: EXISTS
// asks whether it is there, it does not multiply the row out, which
// would inflate every count this returns.
test("segment counts an event once however often the value repeats", () => {
  const db = setupDb();
  insertArticle(db, "s1", ["pricing", "pricing", "pricing"]);

  assert.deepEqual(
    segmentSummary(
      db,
      {
        event: "article_read",
        property: "tags",
        value: "pricing",
        isList: true,
      },
      PERIOD,
      "page_view",
    ),
    { sessions: 1, interactionEvents: 1, viewEvents: 0 },
  );
});

test("segment matches a number inside a list prop", () => {
  const db = setupDb();
  insertArticle(db, "s1", ["x"], [1, 2]);
  insertArticle(db, "s2", ["x"], [3]);

  assert.deepEqual(
    segmentSummary(
      db,
      { event: "article_read", property: "sections", value: 3, isList: true },
      PERIOD,
      "page_view",
    ),
    { sessions: 1, interactionEvents: 1, viewEvents: 0 },
  );
});

test("segment finds nothing for a value no list holds", () => {
  const db = setupDb();
  insertArticle(db, "s1", ["pricing"]);

  assert.deepEqual(
    segmentSummary(
      db,
      {
        event: "article_read",
        property: "tags",
        value: "absent",
        isList: true,
      },
      PERIOD,
      "page_view",
    ),
    { sessions: 0, interactionEvents: 0, viewEvents: 0 },
  );
});

// An empty list, and a prop that isn't there at all: json_each produces
// no rows for either, so neither needs a guard and neither errors.
test("segment tolerates an empty list and a missing prop", () => {
  const db = setupDb();
  insertArticle(db, "s1", []);
  insertEvent(db, {
    event: "article_read",
    visitorId: "s2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/a",
    props: {},
  });

  assert.deepEqual(
    segmentSummary(
      db,
      {
        event: "article_read",
        property: "tags",
        value: "pricing",
        isList: true,
      },
      PERIOD,
      "page_view",
    ),
    { sessions: 0, interactionEvents: 0, viewEvents: 0 },
  );
});

// The flag is load-bearing, not decoration: without it the same data
// answers zero, which is the failure this branch exists to remove.
test("without the list flag the same filter matches nothing", () => {
  const db = setupDb();
  insertArticle(db, "s1", ["pricing"]);

  assert.deepEqual(
    segmentSummary(
      db,
      { event: "article_read", property: "tags", value: "pricing" },
      PERIOD,
      "page_view",
    ),
    { sessions: 0, interactionEvents: 0, viewEvents: 0 },
  );
});

// --- the other dimensions, and AND ---

function visit(
  db: Database.Database,
  session: string,
  url: string,
  extra: {
    referrer?: string;
    deviceType?: string;
    browser?: string;
    visitorLanguage?: string;
    ts?: string;
  } = {},
) {
  insertEvent(db, {
    event: "page_view",
    visitorId: `v-${session}`,
    sessionId: session,
    ts: extra.ts ?? "2026-01-01T10:00:00.000Z",
    url,
    referrer: extra.referrer,
    deviceType: extra.deviceType,
    browser: extra.browser,
    visitorLanguage: extra.visitorLanguage,
    props: {},
  });
}

test("a deviceType or browser condition selects the sessions on it", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/", {
    deviceType: "mobile",
    browser: "Safari",
  });
  visit(db, "s2", "https://example.com/", {
    deviceType: "desktop",
    browser: "Chrome",
  });
  visit(db, "s3", "https://example.com/", {
    deviceType: "mobile",
    browser: "Chrome",
  });

  assert.equal(
    summaryFor(db, [{ kind: "deviceType", value: "mobile" }]).sessions,
    2,
  );
  assert.equal(
    summaryFor(db, [{ kind: "browser", value: "Chrome" }]).sessions,
    2,
  );
  // AND: both at once.
  assert.equal(
    summaryFor(db, [
      { kind: "deviceType", value: "mobile" },
      { kind: "browser", value: "Chrome" },
    ]).sessions,
    1,
  );
});

test("a language condition matches regional variants of a bare language, and null the missing header", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/", { visitorLanguage: "en-US" });
  visit(db, "s2", "https://example.com/", { visitorLanguage: "en" });
  visit(db, "s3", "https://example.com/", { visitorLanguage: "de-DE" });
  visit(db, "s4", "https://example.com/");

  assert.equal(summaryFor(db, [{ kind: "language", value: "en" }]).sessions, 2);
  assert.equal(
    summaryFor(db, [{ kind: "language", value: "en-US" }]).sessions,
    1,
  );
  assert.equal(summaryFor(db, [{ kind: "language", value: null }]).sessions, 1);
});

test("entry-based conditions look at the page view that started the session", () => {
  const db = setupDb();
  // s1: from Google onto /pricing?utm_campaign=spring, then /other.
  visit(db, "s1", "https://example.com/pricing?utm_campaign=spring", {
    referrer: "https://www.google.com/search?q=x",
  });
  visit(db, "s1", "https://example.com/other", {
    referrer: "https://example.com/pricing",
    ts: "2026-01-01T10:05:00.000Z",
  });
  // s2: direct onto /other.
  visit(db, "s2", "https://example.com/other");
  // s3: from google.com (apex) onto /pricing, untagged.
  visit(db, "s3", "https://example.com/pricing", {
    referrer: "https://google.com/",
  });

  assert.equal(
    summaryFor(db, [{ kind: "referrerHost", value: "google.com" }]).sessions,
    2,
  );
  assert.equal(
    summaryFor(db, [{ kind: "referrerHost", value: null }]).sessions,
    1,
  );
  assert.equal(
    summaryFor(db, [{ kind: "entryPath", value: "/pricing" }]).sessions,
    2,
  );
  // s1's second view is on /other, but it did not *enter* there.
  assert.equal(
    summaryFor(db, [{ kind: "entryPath", value: "/other" }]).sessions,
    1,
  );
  assert.equal(
    summaryFor(db, [
      { kind: "entryParam", name: "utm_campaign", value: "spring" },
    ]).sessions,
    1,
  );
  assert.equal(
    summaryFor(db, [
      { kind: "entryParam", name: "utm_campaign", value: "autumn" },
    ]).sessions,
    0,
  );
});

test("an entry-based condition only knows sessions that started in the period", () => {
  const db = setupDb();
  // Entered from Google yesterday, still browsing after midnight: the
  // session belongs to yesterday, so today's Google segment is empty.
  visit(db, "s1", "https://example.com/", {
    referrer: "https://www.google.com/",
    ts: "2025-12-31T23:55:00.000Z",
  });
  visit(db, "s1", "https://example.com/other", {
    referrer: "https://example.com/",
    ts: "2026-01-01T00:05:00.000Z",
  });

  assert.equal(
    summaryFor(db, [{ kind: "referrerHost", value: "google.com" }]).sessions,
    0,
  );
});

test("an empty condition list is no segment at all", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/");
  assert.equal(summaryFor(db, []).sessions, 1);
});

// The mismatch the testing review caught: the session-shaped queries
// read a session that started in the period in full, so the event
// condition must see the event even where it fell after the period.
test("an event condition keeps a session that started in the period and did the event after it", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/", { ts: "2026-01-01T23:50:00.000Z" });
  insertEvent(db, {
    event: "file_download",
    visitorId: "v-s1",
    sessionId: "s1",
    ts: "2026-01-02T00:10:00.000Z",
    url: "https://example.com/",
    props: {
      file_url: "https://example.com/a.pdf",
      file_extension: "pdf",
      link_text: "PDF",
    },
  });
  const clause = buildSegment(
    db,
    [{ kind: "event", event: "file_download" }],
    PERIOD,
    "page_view",
  );

  assert.equal(getSessionSummary(db, PERIOD, "page_view", clause).sessions, 1);
  assert.deepEqual(getEntryPages(db, PERIOD, 10, "page_view", clause).items, [
    { path: "/", sessions: 1 },
  ]);
});

// The (event, ts) index looks like the natural way in, but it would
// walk every row of the event since the database began and check each
// one against the period's sessions. The app never runs ANALYZE, so the
// planner picks it on shape alone; the plan has to start from the
// sessions instead.
test("an event condition starts from the period's sessions, not the event's history", () => {
  const db = setupDb();
  const clause = buildSegment(
    db,
    [{ kind: "event", event: "page_view" }],
    PERIOD,
    "page_view",
  );
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE ts BETWEEN @from AND @to${clause.sql}`,
    )
    .all({ ...PERIOD, ...clause.params }) as { detail: string }[];

  assert.ok(
    !plan.some((row) => row.detail.includes("idx_events_event_ts")),
    plan.map((row) => row.detail).join("\n"),
  );
});

test("a segment on the unclassified device or browser reaches rows with no User-Agent", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/", {
    deviceType: "other",
    browser: "Other",
  });
  visit(db, "s2", "https://example.com/");

  assert.equal(
    summaryFor(db, [{ kind: "deviceType", value: "other" }]).sessions,
    2,
  );
  assert.equal(
    summaryFor(db, [{ kind: "browser", value: "Other" }]).sessions,
    2,
  );
  assert.equal(
    summaryFor(db, [{ kind: "browser", value: "Chrome" }]).sessions,
    0,
  );
});

test("a language condition is case-insensitive and treats % and _ as characters", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/", { visitorLanguage: "en" });
  visit(db, "s2", "https://example.com/", { visitorLanguage: "en-US" });
  visit(db, "s3", "https://example.com/", { visitorLanguage: "EN-GB" });
  visit(db, "s4", "https://example.com/", { visitorLanguage: "es" });

  assert.equal(summaryFor(db, [{ kind: "language", value: "EN" }]).sessions, 3);
  assert.equal(summaryFor(db, [{ kind: "language", value: "en" }]).sessions, 3);
  assert.equal(summaryFor(db, [{ kind: "language", value: "e_" }]).sessions, 0);
  assert.equal(summaryFor(db, [{ kind: "language", value: "%" }]).sessions, 0);
});

test("two event conditions AND without their parameters colliding", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/");
  visit(db, "s2", "https://example.com/");
  insertEvent(db, {
    event: "file_download",
    visitorId: "v-s1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {
      file_url: "https://example.com/a.pdf",
      file_extension: "pdf",
      link_text: "PDF",
    },
  });

  assert.equal(
    summaryFor(db, [
      { kind: "event", event: "page_view" },
      { kind: "event", event: "file_download" },
    ]).sessions,
    1,
  );
});

test("an entry parameter matches its name case-insensitively", () => {
  const db = setupDb();
  visit(db, "s1", "https://example.com/?UTM_Campaign=spring");
  assert.equal(
    summaryFor(db, [
      { kind: "entryParam", name: "utm_campaign", value: "spring" },
    ]).sessions,
    1,
  );
});
