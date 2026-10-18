import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { classifyUserAgent } from "./userAgent.js";
import {
  getConsentBreakdown,
  getDeviceTypeBreakdown,
  getBrowserBreakdown,
  getCohortReturn,
  getNewVsReturningVisitors,
  getTopLanguages,
  getTopCountries,
} from "./audience.js";
import { buildSegment } from "./segment.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

function event(overrides: {
  visitorId: string;
  sessionId?: string;
  ts: string;
  visitorLanguage?: string;
  country?: string;
  consentMode?: "consentful" | "consentless";
}) {
  return {
    event: "page_view",
    sessionId: `s-${overrides.visitorId}`,
    url: "https://example.com/",
    props: {},
    ...overrides,
  };
}

test("getTopLanguages ranks by sessions, not raw event count", () => {
  const db = setupDb();
  // One busy en-US session with 5 events against two quieter de-DE
  // sessions: the larger audience must rank first.
  for (let i = 0; i < 5; i++) {
    insertEvent(
      db,
      event({
        visitorId: "v1",
        ts: `2026-01-01T10:0${i}:00.000Z`,
        visitorLanguage: "en-US",
      }),
    );
  }
  insertEvent(
    db,
    event({
      visitorId: "v2",
      ts: "2026-01-01T11:00:00.000Z",
      visitorLanguage: "de-DE",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v3",
      ts: "2026-01-01T11:01:00.000Z",
      visitorLanguage: "de-DE",
    }),
  );

  assert.deepEqual(getTopLanguages(db, PERIOD, 10).items, [
    { language: "de-DE", sessions: 2 },
    { language: "en-US", sessions: 1 },
  ]);
});

// The language is stored per event, so one session can have two.
// Counting distinct sessions per language would count it twice, and the
// shares would add up to more than 100%.
test("getTopLanguages counts a session once, under the locale it began with", () => {
  const db = setupDb();
  for (const [ts, language] of [
    ["2026-01-01T10:00:00.000Z", "de-DE"],
    ["2026-01-01T10:05:00.000Z", "en-GB"],
    ["2026-01-01T10:10:00.000Z", "en-GB"],
  ] as const) {
    insertEvent(db, event({ visitorId: "v1", ts, visitorLanguage: language }));
  }
  insertEvent(
    db,
    event({
      visitorId: "v2",
      ts: "2026-01-01T11:00:00.000Z",
      visitorLanguage: "fr-FR",
    }),
  );

  const ranked = getTopLanguages(db, PERIOD, 10);
  assert.deepEqual(ranked.items, [
    { language: "de-DE", sessions: 1 },
    { language: "fr-FR", sessions: 1 },
  ]);
  assert.equal(ranked.total, 2, "two sessions exist, so the total is two");
});

// No Accept-Language header means the language is unknown: null.
test("getTopLanguages reports a missing Accept-Language as null", () => {
  const db = setupDb();
  insertEvent(db, event({ visitorId: "v1", ts: "2026-01-01T10:00:00.000Z" }));

  assert.deepEqual(getTopLanguages(db, PERIOD, 10).items, [
    { language: null, sessions: 1 },
  ]);
});

test("getTopLanguages honours the limit and the period", () => {
  const db = setupDb();
  insertEvent(
    db,
    event({
      visitorId: "v1",
      ts: "2026-01-01T10:00:00.000Z",
      visitorLanguage: "en-US",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v2",
      ts: "2026-01-01T10:00:00.000Z",
      visitorLanguage: "fr-FR",
    }),
  );
  // Outside the period entirely.
  insertEvent(
    db,
    event({
      visitorId: "v3",
      ts: "2025-06-01T10:00:00.000Z",
      visitorLanguage: "es-ES",
    }),
  );

  assert.equal(getTopLanguages(db, PERIOD, 1).items.length, 1);
  const languages = getTopLanguages(db, PERIOD, 10).items.map(
    (r) => r.language,
  );
  assert.ok(!languages.includes("es-ES"), "outside the period");
});

test("getConsentBreakdown counts events and visitors per mode", () => {
  const db = setupDb();
  insertEvent(
    db,
    event({
      visitorId: "v1",
      ts: "2026-01-01T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v1",
      ts: "2026-01-01T10:01:00.000Z",
      consentMode: "consentful",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v2",
      ts: "2026-01-01T10:02:00.000Z",
      consentMode: "consentless",
    }),
  );

  assert.deepEqual(getConsentBreakdown(db, PERIOD), {
    consentful: { events: 2, visitors: 1 },
    consentless: { events: 1, visitors: 1 },
  });
});

// A stored row without a consent mode counts as consentless (the
// column's default).
test("getConsentBreakdown counts an unspecified consent mode as consentless", () => {
  const db = setupDb();
  insertEvent(db, event({ visitorId: "v1", ts: "2026-01-01T10:00:00.000Z" }));

  assert.deepEqual(getConsentBreakdown(db, PERIOD), {
    consentful: { events: 0, visitors: 0 },
    consentless: { events: 1, visitors: 1 },
  });
});

test("getConsentBreakdown reports zeroes rather than failing on no data", () => {
  const db = setupDb();
  assert.deepEqual(getConsentBreakdown(db, PERIOD), {
    consentful: { events: 0, visitors: 0 },
    consentless: { events: 0, visitors: 0 },
  });
});

test("getNewVsReturningVisitors buckets active visitors by whether their all-time-earliest event predates the period", () => {
  const db = setupDb();
  // v1: earliest-ever event before the period — returning.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2025-12-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  // v2: earliest-ever event within the period — new.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s3",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  // v3: only active before the period — not counted at all.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s4",
    ts: "2025-12-01T09:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getNewVsReturningVisitors(db, {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T23:59:59.999Z",
  });

  assert.deepEqual(result, { newVisitors: 1, returningVisitors: 1 });
});

test("getNewVsReturningVisitors returns zeroes for a period with no events", () => {
  const db = setupDb();
  const result = getNewVsReturningVisitors(db, {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-01T23:59:59.999Z",
  });
  assert.deepEqual(result, { newVisitors: 0, returningVisitors: 0 });
});

// Both tools take a segment. (The SDK ignores unknown arguments, so a
// tool without one would quietly return whole-site numbers.)
test("getConsentBreakdown and getNewVsReturningVisitors apply a segment", () => {
  const db = setupDb();
  // m1: mobile, consentful, visited before the period — returning.
  // m2: mobile, consentless, first seen in the period — new.
  // d1: desktop, consentful, visited before — outside the segment.
  for (const [visitor, device, consent, earlier] of [
    ["m1", "mobile", "consentful", true],
    ["m2", "mobile", "consentless", false],
    ["d1", "desktop", "consentful", true],
  ] as const) {
    if (earlier) {
      // m1's earlier visit was on desktop: the segment decides who is
      // counted, not which earlier visits make them returning.
      insertEvent(db, {
        ...event({ visitorId: visitor, ts: "2025-12-01T10:00:00.000Z" }),
        sessionId: `old-${visitor}`,
        deviceType: "desktop",
      });
    }
    insertEvent(db, {
      ...event({
        visitorId: visitor,
        ts: "2026-01-01T10:00:00.000Z",
        consentMode: consent,
      }),
      deviceType: device,
    });
  }
  const mobile = buildSegment(
    db,
    [{ kind: "deviceType", value: "mobile" }],
    PERIOD,
    "page_view",
  );

  assert.deepEqual(getConsentBreakdown(db, PERIOD, mobile), {
    consentful: { events: 1, visitors: 1 },
    consentless: { events: 1, visitors: 1 },
  });
  assert.deepEqual(getNewVsReturningVisitors(db, PERIOD, mobile), {
    newVisitors: 1,
    returningVisitors: 1,
  });
  // And unsegmented, d1 is back in both.
  assert.deepEqual(getNewVsReturningVisitors(db, PERIOD), {
    newVisitors: 1,
    returningVisitors: 2,
  });
});

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
const ROKU_TV = "Roku4640X/DVP-7.70 (297.70E04154A)";

test("getBrowserBreakdown groups by browser + device type, counted in sessions", () => {
  const db = setupDb();
  // Two page views in ONE session: the pair counts once, not twice.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    ...classifyUserAgent(CHROME_WINDOWS),
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:01:00.000Z",
    url: "https://example.com/other",
    ...classifyUserAgent(CHROME_WINDOWS),
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/",
    ...classifyUserAgent(SAFARI_IPHONE),
    props: {},
  });

  const result = getBrowserBreakdown(db, PERIOD, 10).items;

  assert.deepEqual(result, [
    { browser: "Chrome", sessions: 1 },
    { browser: "Safari", sessions: 1 },
  ]);
});

test("getDeviceTypeBreakdown totals a device type across browsers", () => {
  const db = setupDb();
  // Three browsers, two of them on desktop. By device type, desktop must
  // be one row of 3, not split by browser.
  const agents = [
    CHROME_WINDOWS,
    CHROME_WINDOWS,
    FIREFOX_WINDOWS,
    SAFARI_IPHONE,
    CHROME_ANDROID,
  ];
  agents.forEach((userAgent, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/",
      ...classifyUserAgent(userAgent),
      props: {},
    });
  });

  assert.deepEqual(getDeviceTypeBreakdown(db, PERIOD, 10).items, [
    { deviceType: "desktop", sessions: 3 },
    { deviceType: "mobile", sessions: 2 },
  ]);
});

test("getDeviceTypeBreakdown counts a busy session once, not once per event", () => {
  const db = setupDb();
  // One desktop visitor reading ten pages must not outweigh three phone
  // visits.
  for (let i = 0; i < 10; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v-desk",
      sessionId: "s-desk",
      ts: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
      url: `https://example.com/page-${i}`,
      ...classifyUserAgent(CHROME_WINDOWS),
      props: {},
    });
  }
  for (let i = 0; i < 3; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v-phone-${i}`,
      sessionId: `s-phone-${i}`,
      ts: `2026-01-01T11:0${i}:00.000Z`,
      url: "https://example.com/",
      ...classifyUserAgent(SAFARI_IPHONE),
      props: {},
    });
  }

  assert.deepEqual(getDeviceTypeBreakdown(db, PERIOD, 10).items, [
    { deviceType: "mobile", sessions: 3 },
    { deviceType: "desktop", sessions: 1 },
  ]);
});

test("getDeviceTypeBreakdown reports an unrecognised device as its own type", () => {
  const db = setupDb();
  // Not counted as desktop: a smart TV is "other".
  const agents = [CHROME_WINDOWS, CHROME_WINDOWS, ROKU_TV];
  agents.forEach((userAgent, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/",
      ...classifyUserAgent(userAgent),
      props: {},
    });
  });

  assert.deepEqual(getDeviceTypeBreakdown(db, PERIOD, 10).items, [
    { deviceType: "desktop", sessions: 2 },
    { deviceType: "other", sessions: 1 },
  ]);
});

// Sessions, not visitors: without consent the visitor_id changes daily,
// so over a month one reader would count up to thirty times.
test("getTopLanguages counts sessions, so a visitor whose id rotated still counts one session per visit", () => {
  const db = setupDb();
  insertEvent(
    db,
    event({
      visitorId: "v-day1",
      sessionId: "s1",
      ts: "2026-01-01T10:00:00.000Z",
      visitorLanguage: "de-DE",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v-day1",
      sessionId: "s1",
      ts: "2026-01-01T10:01:00.000Z",
      visitorLanguage: "de-DE",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "v-day2",
      sessionId: "s2",
      ts: "2026-01-01T12:00:00.000Z",
      visitorLanguage: "de-DE",
    }),
  );

  assert.deepEqual(getTopLanguages(db, PERIOD, 10).items, [
    { language: "de-DE", sessions: 2 },
  ]);
});

// Only visitors with consent can be recognised later; without consent
// the id changes daily.
test("getCohortReturn counts who came back, and how many could have", () => {
  const db = setupDb();
  const cohort = {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-07T23:59:59.999Z",
  };
  const later = {
    from: "2026-01-08T00:00:00.000Z",
    to: "2026-01-14T23:59:59.999Z",
  };
  // c1: consentful, returns. c2: consentful, does not. x1: consentless
  // in the cohort; its "return" is a different id and can't be linked.
  insertEvent(
    db,
    event({
      visitorId: "c1",
      ts: "2026-01-02T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "c1",
      ts: "2026-01-10T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "c2",
      ts: "2026-01-03T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "x1",
      ts: "2026-01-03T10:00:00.000Z",
      consentMode: "consentless",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "x2",
      ts: "2026-01-10T10:00:00.000Z",
      consentMode: "consentless",
    }),
  );
  // Outside both periods: not in the cohort.
  insertEvent(
    db,
    event({
      visitorId: "old",
      ts: "2025-12-01T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );

  assert.deepEqual(getCohortReturn(db, cohort, later), {
    cohortVisitors: 3,
    consentfulVisitors: 2,
    returnedVisitors: 1,
    returnRate: 0.3333,
  });
});

test("getCohortReturn is all zeros for an empty cohort", () => {
  const db = setupDb();
  assert.deepEqual(
    getCohortReturn(
      db,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
      { from: "2026-01-02T00:00:00.000Z", to: "2026-01-02T23:59:59.999Z" },
    ),
    {
      cohortVisitors: 0,
      consentfulVisitors: 0,
      returnedVisitors: 0,
      returnRate: 0,
    },
  );
});

// Giving consent keeps the day's hash as the cookie id
// (routes/events.ts), so a visitor without consent in the cohort who
// consents later keeps the same id and can return. So consentfulVisitors
// is a minimum, not a maximum.
test("getCohortReturn can see a consentless cohort visitor return once they consented later", () => {
  const db = setupDb();
  insertEvent(
    db,
    event({
      visitorId: "x1",
      ts: "2026-01-02T10:00:00.000Z",
      consentMode: "consentless",
    }),
  );
  insertEvent(
    db,
    event({
      visitorId: "x1",
      ts: "2026-01-10T10:00:00.000Z",
      consentMode: "consentful",
    }),
  );

  assert.deepEqual(
    getCohortReturn(
      db,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-07T23:59:59.999Z" },
      { from: "2026-01-08T00:00:00.000Z", to: "2026-01-14T23:59:59.999Z" },
    ),
    {
      cohortVisitors: 1,
      consentfulVisitors: 0,
      returnedVisitors: 1,
      returnRate: 1,
    },
  );
});

// "Not looked up" (null) and "looked up, not found" (ZZ) are different
// and stay apart. A session counts once, under its first event.
test("getTopCountries counts sessions by their first event, keeping not-looked-up and ZZ apart", () => {
  const db = setupDb();
  insertEvent(
    db,
    event({ visitorId: "v1", ts: "2026-01-01T10:00:00.000Z", country: "DE" }),
  );
  insertEvent(
    db,
    event({ visitorId: "v1", ts: "2026-01-01T10:05:00.000Z", country: "AT" }),
  );
  insertEvent(
    db,
    event({ visitorId: "v2", ts: "2026-01-01T11:00:00.000Z", country: "DE" }),
  );
  insertEvent(
    db,
    event({ visitorId: "v3", ts: "2026-01-01T12:00:00.000Z", country: "ZZ" }),
  );
  insertEvent(db, event({ visitorId: "v4", ts: "2026-01-01T13:00:00.000Z" }));

  assert.deepEqual(getTopCountries(db, PERIOD, 10), {
    items: [
      { country: "DE", sessions: 2 },
      { country: "ZZ", sessions: 1 },
    ],
    groups: 2,
    total: 3,
    notLookedUp: 1,
  });
});

// Sessions without a lookup are counted separately, not as a row, which
// could be cut off by the limit while still counting in the total.
test("getTopCountries keeps the not-looked-up count whatever the limit", () => {
  const db = setupDb();
  for (let i = 0; i < 3; i++) {
    insertEvent(
      db,
      event({ visitorId: `n${i}`, ts: "2026-01-01T09:00:00.000Z" }),
    );
  }
  for (const [country, count] of [
    ["DE", 5],
    ["AT", 4],
  ] as const) {
    for (let i = 0; i < count; i++) {
      insertEvent(
        db,
        event({
          visitorId: `${country}${i}`,
          ts: "2026-01-01T10:00:00.000Z",
          country,
        }),
      );
    }
  }

  assert.deepEqual(getTopCountries(db, PERIOD, 1), {
    items: [{ country: "DE", sessions: 5 }],
    groups: 2,
    total: 9,
    notLookedUp: 3,
  });
});
