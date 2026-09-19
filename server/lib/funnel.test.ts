import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { getStepsFunnel } from "./funnel.js";
import { buildSegment } from "./segment.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-31T23:59:59.999Z",
};

test("getStepsFunnel narrows visitors step by step, in order", () => {
  const db = setupDb();

  // v1: completes all three steps, in order.
  insertEvent(db, {
    event: "viewed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "added_to_cart",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "checkout",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:10:00.000Z",
    url: "u",
    props: {},
  });

  // v2: views and adds to cart, never checks out.
  insertEvent(db, {
    event: "viewed",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-02T10:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "added_to_cart",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-02T10:05:00.000Z",
    url: "u",
    props: {},
  });

  // v3: only views.
  insertEvent(db, {
    event: "viewed",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-03T10:00:00.000Z",
    url: "u",
    props: {},
  });

  const result = getStepsFunnel(
    db,
    ["viewed", "added_to_cart", "checkout"],
    PERIOD,
  );

  assert.deepEqual(result, [
    { event: "viewed", reached: 3, conversionRate: 1 },
    { event: "added_to_cart", reached: 2, conversionRate: 0.6667 },
    { event: "checkout", reached: 1, conversionRate: 0.3333 },
  ]);
});

test("getStepsFunnel does not count a later step happening before the earlier one", () => {
  const db = setupDb();

  // checkout happens BEFORE viewed — shouldn't count as progressing the funnel.
  insertEvent(db, {
    event: "checkout",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T09:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "viewed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "u",
    props: {},
  });

  const result = getStepsFunnel(db, ["viewed", "checkout"], PERIOD);

  assert.deepEqual(result, [
    { event: "viewed", reached: 1, conversionRate: 1 },
    { event: "checkout", reached: 0, conversionRate: 0 },
  ]);
});

test("getStepsFunnel uses a visitor's earliest occurrence of each step", () => {
  const db = setupDb();

  // v1 views twice; only occurrences of "added_to_cart" after the
  // *first* view should count.
  insertEvent(db, {
    event: "viewed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "viewed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T12:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "added_to_cart",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T11:00:00.000Z",
    url: "u",
    props: {},
  });

  const result = getStepsFunnel(db, ["viewed", "added_to_cart"], PERIOD);

  assert.deepEqual(result, [
    { event: "viewed", reached: 1, conversionRate: 1 },
    { event: "added_to_cart", reached: 1, conversionRate: 1 },
  ]);
});

test("getStepsFunnel returns an empty array for zero steps", () => {
  const db = setupDb();
  assert.deepEqual(getStepsFunnel(db, [], PERIOD), []);
});

test("getStepsFunnel returns zero visitors for every step when no one reaches the first one", () => {
  const db = setupDb();
  const result = getStepsFunnel(db, ["viewed", "checkout"], PERIOD);
  assert.deepEqual(result, [
    { event: "viewed", reached: 0, conversionRate: 1 },
    { event: "checkout", reached: 0, conversionRate: 0 },
  ]);
});

// Only visitors who reached the first step and then the second count,
// and they have to be matched back to the right ids.
test("advances only the visitors who reached the next step", () => {
  const db = setupDb();
  for (let i = 0; i < 5; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/",
      props: {},
    });
    // Only the even visitors go on to the second step.
    if (i % 2 === 0) {
      insertEvent(db, {
        event: "file_download",
        visitorId: `v${i}`,
        sessionId: `s${i}`,
        ts: `2026-01-01T11:0${i}:00.000Z`,
        url: "https://example.com/a.pdf",
        props: {
          file_url: "https://example.com/a.pdf",
          file_extension: "pdf",
          link_text: "PDF",
        },
      });
    }
  }

  const result = getStepsFunnel(db, ["page_view", "file_download"], PERIOD);

  assert.deepEqual(
    result.map((s) => s.reached),
    [5, 3],
  );
});

// The bug the json_each visitor set exists for: binding one parameter
// per visitor hit SQLite's cap of 32,766 per statement, so this threw
// "too many SQL variables" above 32,763 visitors rather than answering.
test("survives more visitors than SQLite allows bound parameters", () => {
  const db = setupDb();
  const insert = db.prepare(
    "INSERT INTO events (event, visitor_id, session_id, ts, url, props, consent_mode) VALUES (?, ?, ?, ?, ?, ?, 'consentless')",
  );
  const visitors = 33_000;
  db.transaction(() => {
    for (let i = 0; i < visitors; i++) {
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

  for (const scope of ["session", "visitor"] as const) {
    const funnel = getStepsFunnel(
      db,
      ["page_view", "file_download"],
      PERIOD,
      scope,
    );
    assert.equal(funnel[0]!.reached, visitors, scope);
    assert.equal(funnel[1]!.reached, 0, scope);
  }
});

// The reason session is the default scope: a consentless visitor_id
// rotates at UTC midnight, so the same person is v-day1 before it and
// v-day2 after. Visitor scope splits their funnel in two and reports no
// conversion; session scope, keyed on the id the server carries across
// midnight, still sees one visit that completed both steps.
test("getStepsFunnel's session scope survives a visitor_id rotating at midnight", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "viewed",
    visitorId: "v-day1",
    sessionId: "s1",
    ts: "2026-01-01T23:50:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "checkout",
    visitorId: "v-day2",
    sessionId: "s1",
    ts: "2026-01-02T00:10:00.000Z",
    url: "u",
    props: {},
  });

  assert.deepEqual(getStepsFunnel(db, ["viewed", "checkout"], PERIOD), [
    { event: "viewed", reached: 1, conversionRate: 1 },
    { event: "checkout", reached: 1, conversionRate: 1 },
  ]);
  assert.deepEqual(
    getStepsFunnel(db, ["viewed", "checkout"], PERIOD, "visitor"),
    [
      { event: "viewed", reached: 1, conversionRate: 1 },
      { event: "checkout", reached: 0, conversionRate: 0 },
    ],
  );
});

// And the case visitor scope exists for: a consentful visitor who comes
// back days later in a new session. Session scope can't see it.
test("getStepsFunnel's visitor scope follows a visitor across sessions", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "viewed",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-05T10:00:00.000Z",
    url: "u",
    props: {},
  });
  insertEvent(db, {
    event: "checkout",
    visitorId: "v1",
    sessionId: "s2",
    ts: "2026-01-08T10:00:00.000Z",
    url: "u",
    props: {},
  });

  assert.equal(
    getStepsFunnel(db, ["viewed", "checkout"], PERIOD, "visitor")[1]!.reached,
    1,
  );
  assert.equal(
    getStepsFunnel(db, ["viewed", "checkout"], PERIOD)[1]!.reached,
    0,
  );
});

// The segment decides who enters at step one; in session scope a later
// step done by a session outside the segment can never count, since
// only the entering keys are looked up.
test("getStepsFunnel's segment narrows who enters the funnel", () => {
  const db = setupDb();
  for (const [session, device] of [
    ["s1", "mobile"],
    ["s2", "desktop"],
  ] as const) {
    insertEvent(db, {
      event: "viewed",
      visitorId: session,
      sessionId: session,
      ts: "2026-01-01T10:00:00.000Z",
      url: "u",
      deviceType: device,
      props: {},
    });
    insertEvent(db, {
      event: "checkout",
      visitorId: session,
      sessionId: session,
      ts: "2026-01-01T10:05:00.000Z",
      url: "u",
      deviceType: device,
      props: {},
    });
  }
  const mobile = buildSegment(
    db,
    [{ kind: "deviceType", value: "mobile" }],
    PERIOD,
    "page_view",
  );

  assert.deepEqual(
    getStepsFunnel(db, ["viewed", "checkout"], PERIOD, "session", mobile).map(
      (step) => step.reached,
    ),
    [1, 1],
  );
});
