import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import {
  getSessionSummary,
  getTrafficByDay,
  getTrafficByDayOfWeek,
  getTrafficByHour,
  getTrafficSummary,
  hasAnyEvents,
} from "./traffic.js";

// The bucketed shapes gained `visitors`; the older assertions here are
// about the other three numbers, and a dedicated test below pins visitors.
function withoutVisitors<T extends { visitors: number }>(rows: T[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "visitors"),
    ),
  );
}

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("getTrafficSummary counts distinct sessions and every event (not just page_view) within the period, when no pageViewEvent is given", () => {
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
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:02:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  // Outside the period below — must not be counted.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-02-01T00:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const summary = getTrafficSummary(
    db,
    {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T23:59:59.999Z",
    },
    "page_view",
  );

  // Additive: 2 page_view + 1 outbound_link_click, split into 1
  // interaction event and 2 view events.
  assert.deepEqual(summary, {
    sessions: 2,
    visitors: 2,
    interactionEvents: 1,
    viewEvents: 2,
  });
});

test("getTrafficSummary returns zeroes for a period with no events", () => {
  const db = setupDb();
  const summary = getTrafficSummary(
    db,
    {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T23:59:59.999Z",
    },
    "page_view",
  );
  assert.deepEqual(summary, {
    sessions: 0,
    visitors: 0,
    interactionEvents: 0,
    viewEvents: 0,
  });
});

test("getTrafficSummary splits interactionEvents and viewEvents (additively) when a pageViewEvent is given", () => {
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
    event: "outbound_link_click",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const summary = getTrafficSummary(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    "page_view",
  );

  // 1 page_view (viewEvents) + 1 outbound_link_click (interactionEvents) —
  // the two fields are additive, not overlapping: neither counts the
  // other's event.
  assert.deepEqual(summary, {
    sessions: 1,
    visitors: 1,
    interactionEvents: 1,
    viewEvents: 1,
  });
});

test("hasAnyEvents is false for an empty table and true once any event exists", () => {
  const db = setupDb();
  assert.equal(hasAnyEvents(db), false);

  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  assert.equal(hasAnyEvents(db), true);
});

test("getTrafficByDay splits interactionEvents/viewEvents per day and zero-fills days with no events", () => {
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
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-03T09:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getTrafficByDay(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T23:59:59.999Z" },
    "page_view",
  );

  assert.deepEqual(withoutVisitors(result), [
    { date: "2026-01-01", sessions: 1, interactionEvents: 1, viewEvents: 1 },
    { date: "2026-01-02", sessions: 0, interactionEvents: 0, viewEvents: 0 },
    { date: "2026-01-03", sessions: 1, interactionEvents: 0, viewEvents: 1 },
  ]);
});

test("getTrafficByDayOfWeek groups by weekday (Monday-first), summed across every week in the period", () => {
  const db = setupDb();
  // 2026-01-05 is a Monday.
  const week = [
    ["2026-01-05", "v1", "s1"], // Monday
    ["2026-01-06", "v2", "s2"], // Tuesday
    ["2026-01-07", "v3", "s3"], // Wednesday
    ["2026-01-08", "v4", "s4"], // Thursday
    ["2026-01-09", "v5", "s5"], // Friday
    ["2026-01-10", "v6", "s6"], // Saturday
    ["2026-01-11", "v7", "s7"], // Sunday
  ];
  for (const [date, visitorId, sessionId] of week) {
    insertEvent(db, {
      event: "page_view",
      visitorId: visitorId!,
      sessionId: sessionId!,
      ts: `${date}T10:00:00.000Z`,
      url: "https://example.com/",
      props: {},
    });
  }
  // A second Monday — proves counts sum across weeks, not per-week.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v8",
    sessionId: "s8",
    ts: "2026-01-12T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getTrafficByDayOfWeek(
    db,
    { from: "2026-01-05T00:00:00.000Z", to: "2026-01-12T23:59:59.999Z" },
    "page_view",
  );

  assert.deepEqual(withoutVisitors(result), [
    { day: "Monday", sessions: 2, interactionEvents: 0, viewEvents: 2 },
    { day: "Tuesday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
    { day: "Wednesday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
    { day: "Thursday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
    { day: "Friday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
    { day: "Saturday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
    { day: "Sunday", sessions: 1, interactionEvents: 0, viewEvents: 1 },
  ]);
});

test("getTrafficByHour groups by UTC hour, zero-filling all 24 hours", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:30:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T14:15:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T14:20:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });

  const result = getTrafficByHour(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    "page_view",
  );

  assert.equal(result.length, 24);
  assert.deepEqual(withoutVisitors(result)[0], {
    hour: 0,
    sessions: 1,
    interactionEvents: 0,
    viewEvents: 1,
  });
  assert.deepEqual(withoutVisitors(result)[1], {
    hour: 1,
    sessions: 0,
    interactionEvents: 0,
    viewEvents: 0,
  });
  assert.deepEqual(withoutVisitors(result)[14], {
    hour: 14,
    sessions: 1,
    interactionEvents: 1,
    viewEvents: 1,
  });
});

test("getSessionSummary averages MAX(ts) - MIN(ts) across sessions in the period", () => {
  const db = setupDb();
  // s1: 10 minutes long.
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
    ts: "2026-01-01T10:10:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });
  // s2: a single event — a "bounce", 0 seconds.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getSessionSummary(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    "page_view",
  );

  // (600s + 0s) / 2 sessions = 300s average.
  // Both sessions viewed exactly one page (s1's second event is a click),
  // so both bounced.
  assert.deepEqual(result, {
    sessions: 2,
    averageSeconds: 300,
    sessionsWithViews: 2,
    bounced: 2,
    bounceRate: 1,
  });
});

test("getSessionSummary returns zeroes for a period with no events", () => {
  const db = setupDb();
  const result = getSessionSummary(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    "page_view",
  );
  assert.deepEqual(result, {
    sessions: 0,
    averageSeconds: 0,
    sessionsWithViews: 0,
    bounced: 0,
    bounceRate: 0,
  });
});

// A session is measured over its full length, not the part inside the
// period — and belongs to the period it started in. Before, both
// sessions here were clipped to the window: s1 (started the day
// before) showed up as a 5-minute session and s2 as a 10-minute one.
test("getSessionSummary measures sessions that started in the period over their full length", () => {
  const db = setupDb();
  // s1: began before the period — not this period's session at all.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2025-12-31T23:50:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:05:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  // s2: began inside the period, ran 20 minutes past its end.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T23:50:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-02T00:10:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });

  const result = getSessionSummary(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    "page_view",
  );

  assert.deepEqual(result, {
    sessions: 1,
    averageSeconds: 1200,
    sessionsWithViews: 1,
    bounced: 0,
    bounceRate: 0,
  });
});

// Distinct visitors alongside sessions: two sessions of one visitor are
// one visitor, and a visitor active on two days is counted on each.
test("getTrafficSummary and getTrafficByDay count distinct visitors", () => {
  const db = setupDb();
  for (const [session, ts] of [
    ["s1", "2026-01-01T10:00:00.000Z"],
    ["s2", "2026-01-01T12:00:00.000Z"],
    ["s3", "2026-01-02T10:00:00.000Z"],
  ] as const) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: session,
      ts,
      url: "https://example.com/",
      props: {},
    });
  }
  const period = {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T23:59:59.999Z",
  };

  assert.equal(getTrafficSummary(db, period, "page_view").visitors, 1);
  assert.deepEqual(
    getTrafficByDay(db, period, "page_view").map((row) => row.visitors),
    [1, 1],
  );

  // The two columns must not be interchangeable. Every other fixture in
  // this file maps one visitor to one session, so counting visitors
  // where the field says sessions passed everything.
  assert.equal(getTrafficSummary(db, period, "page_view").sessions, 3);
  assert.deepEqual(
    getTrafficByDay(db, period, "page_view").map((row) => row.sessions),
    [2, 1],
  );
});

// Same discriminating shape for the two bucketed queries, where neither
// column was pinned against the other at all. One visitor, three
// sessions, deliberately in three different hours on two weekdays.
test("getTrafficByHour and getTrafficByDayOfWeek count sessions, not visitors", () => {
  const db = setupDb();
  for (const [session, ts] of [
    ["s1", "2026-01-01T10:00:00.000Z"],
    ["s2", "2026-01-01T12:00:00.000Z"],
    ["s3", "2026-01-02T10:00:00.000Z"],
  ] as const) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: session,
      ts,
      url: "https://example.com/",
      props: {},
    });
  }
  const period = {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T23:59:59.999Z",
  };

  const byHour = getTrafficByHour(db, period, "page_view");
  assert.equal(
    byHour.reduce((sum, row) => sum + row.sessions, 0),
    3,
    "three sessions across the day's hours",
  );
  assert.equal(byHour.find((row) => row.hour === 10)?.sessions, 2);
  assert.equal(byHour.find((row) => row.hour === 10)?.visitors, 1);

  const byWeekday = getTrafficByDayOfWeek(db, period, "page_view");
  assert.equal(
    byWeekday.reduce((sum, row) => sum + row.sessions, 0),
    3,
  );
  assert.equal(
    byWeekday.reduce((sum, row) => sum + row.visitors, 0),
    2,
    "one visitor, counted once on each of two weekdays",
  );
});

test("getSessionSummary's bounce rate is over sessions that viewed a page", () => {
  const db = setupDb();
  // s1: two page views — not a bounce. s2: one page view — a bounce.
  // s3: only a download, no page view — never entered on a page, so it
  // is neither bounced nor in the denominator.
  const rows = [
    ["s1", "page_view", "2026-01-01T10:00:00.000Z"],
    ["s1", "page_view", "2026-01-01T10:01:00.000Z"],
    ["s2", "page_view", "2026-01-01T11:00:00.000Z"],
    ["s3", "file_download", "2026-01-01T12:00:00.000Z"],
  ] as const;
  for (const [session, event, ts] of rows) {
    insertEvent(db, {
      event,
      visitorId: session,
      sessionId: session,
      ts,
      url: "https://example.com/",
      props:
        event === "file_download"
          ? {
              file_url: "https://example.com/a.pdf",
              file_extension: "pdf",
              link_text: "PDF",
            }
          : {},
    });
  }

  assert.deepEqual(
    getSessionSummary(
      db,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
      "page_view",
    ),
    {
      sessions: 3,
      averageSeconds: 20,
      sessionsWithViews: 2,
      bounced: 1,
      bounceRate: 0.5,
    },
  );
});
