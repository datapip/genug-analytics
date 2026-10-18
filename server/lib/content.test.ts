import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import {
  getBouncePages,
  getEntryPages,
  getExitPages,
  getTopPages,
  getTopReferrers,
  getTopEntryParams,
} from "./content.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

test("getTopPages ranks paths by page_view count within the period, respecting limit", () => {
  const db = setupDb();
  const urls = [
    "https://example.com/",
    "https://example.com/",
    "https://example.com/",
    "https://example.com/pricing",
    "https://example.com/pricing",
    "https://example.com/about",
  ];
  urls.forEach((url, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url,
      props: {},
    });
  });
  // A non-page_view event on the most-visited URL must not inflate its count.
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v-extra",
    sessionId: "s-extra",
    ts: "2026-01-01T10:06:00.000Z",
    url: "https://example.com/",
    props: {},
  });

  const result = getTopPages(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    2,
    "page_view",
  ).items;

  assert.deepEqual(result, [
    { host: "example.com", path: "/", views: 3 },
    { host: "example.com", path: "/pricing", views: 2 },
  ]);
});

test("getTopPages merges URLs that only differ by query string or hash", () => {
  const db = setupDb();
  const urls = [
    "https://example.com/blog/post-1?utm_source=twitter",
    "https://example.com/blog/post-1?utm_source=newsletter",
    "https://example.com/blog/post-1#comments",
    "https://example.com/blog/post-1",
  ];
  urls.forEach((url, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url,
      props: {},
    });
  });

  const result = getTopPages(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
    "page_view",
  ).items;

  assert.deepEqual(result, [
    { host: "example.com", path: "/blog/post-1", views: 4 },
  ]);
});

// One installation may collect for several sites, and "/" on two of
// them is two pages. www.example.com counts as example.com.
test("the page queries keep one site's path apart from another's", () => {
  const db = setupDb();
  const views: [string, string][] = [
    ["s1", "https://shop.example.com/"],
    ["s2", "https://shop.example.com/"],
    ["s3", "https://example.com/"],
    ["s4", "https://www.example.com/"],
    ["s5", "https://Blog.Example.com/"],
  ];
  views.forEach(([sessionId, url], i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: sessionId,
      sessionId,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url,
      props: {},
    });
  });

  for (const query of [
    getTopPages,
    getEntryPages,
    getExitPages,
    getBouncePages,
  ]) {
    const counted = Object.fromEntries(
      query(db, PERIOD, 10, "page_view").items.map((row) => [
        `${row.host}${row.path}`,
        "views" in row ? row.views : row.sessions,
      ]),
    );
    assert.deepEqual(
      counted,
      { "shop.example.com/": 2, "example.com/": 2, "blog.example.com/": 1 },
      query.name,
    );
  }

  // An unparseable url keeps its whole text as the path, with no site,
  // and a newline in it must not break the grouping key.
  insertEvent(db, {
    event: "page_view",
    visitorId: "s6",
    sessionId: "s6",
    ts: "2026-01-01T10:09:00.000Z",
    url: "not-a-url\nsecond line",
    props: {},
  });
  assert.deepEqual(
    getTopPages(db, PERIOD, 10, "page_view").items.find(
      (row) => row.host === "",
    ),
    { host: "", path: "not-a-url\nsecond line", views: 1 },
  );
});

test("getTopReferrers counts sessions and buckets no-referrer as direct (null)", () => {
  const db = setupDb();
  // Different counts per row (3/2/1), so the expected order is clear.
  const referrers = [
    "https://www.google.com/search?q=genug",
    "https://www.google.com/search?q=analytics",
    "https://www.google.com/search?q=self-hosted",
    "", // direct — the client always sends document.referrer, "" when absent
    undefined, // an atypical caller that omitted the field entirely
    "https://x.com/some/status/123",
  ];
  referrers.forEach((referrer, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/",
      referrer,
      props: {},
    });
  });
  // A non-page_view event must not be counted.
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v-extra",
    sessionId: "s-extra",
    ts: "2026-01-01T10:06:00.000Z",
    url: "https://example.com/",
    referrer: "https://www.google.com/search?q=extra",
    props: {
      target_url: "https://partner.example.com/x",
      target_host: "partner.example.com",
      link_text: "x",
    },
  });

  const result = getTopReferrers(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
    "page_view",
  ).items;

  assert.deepEqual(result, [
    { host: "www.google.com", sessions: 3 },
    { host: null, sessions: 2 },
    { host: "x.com", sessions: 1 },
  ]);
});

test("getTopReferrers attributes a session once, however many pages it reads", () => {
  const db = setupDb();
  // Why referrers are counted per session: in a single-page app,
  // document.referrer doesn't change between routes, so every page view
  // of this visit has the Google referrer. Counted per page view, one
  // visitor reading six pages would be six Google visits.
  for (let i = 0; i < 6; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v-busy",
      sessionId: "s-busy",
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: `https://example.com/page-${i}`,
      referrer: "https://www.google.com/search?q=genug",
      props: {},
    });
  }
  // Two quieter visits from elsewhere, which the busy one must not
  // outrank.
  for (const [i, host] of ["https://x.com/a", "https://x.com/b"].entries()) {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v-quiet-${i}`,
      sessionId: `s-quiet-${i}`,
      ts: `2026-01-01T11:0${i}:00.000Z`,
      url: "https://example.com/",
      referrer: host,
      props: {},
    });
  }

  const result = getTopReferrers(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
    "page_view",
  ).items;

  assert.deepEqual(result, [
    { host: "x.com", sessions: 2 },
    { host: "www.google.com", sessions: 1 },
  ]);
});

test("getTopReferrers keeps an ordinary multi-page session on its entry referrer", () => {
  const db = setupDb();
  // Checks that the referrer comes from the session's first row
  // (MIN(ts)). Here the later page views have the site's own pages as
  // referrer; taking one of those would drop the session from the report
  // as a self-referral.
  const views = [
    {
      ts: "2026-01-01T10:00:00.000Z",
      referrer: "https://www.google.com/search?q=x",
    },
    { ts: "2026-01-01T10:02:00.000Z", referrer: "https://example.com/" },
    { ts: "2026-01-01T10:05:00.000Z", referrer: "https://example.com/pricing" },
  ];
  views.forEach((view, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: "s1",
      ts: view.ts,
      url: `https://example.com/page-${i}`,
      referrer: view.referrer,
      props: {},
    });
  });

  // Compare the whole array, so an extra "direct" row fails too.
  assert.deepEqual(getTopReferrers(db, PERIOD, 10, "page_view").items, [
    { host: "www.google.com", sessions: 1 },
  ]);
});

test("getTopReferrers does not count a session that began before the period", () => {
  const db = setupDb();
  // The session started the day before, so it counts for that day, not
  // this one. So referrer totals can be lower than the number of
  // sessions active in the period.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2025-12-31T23:58:00.000Z",
    url: "https://example.com/",
    referrer: "https://www.google.com/search?q=x",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:01:00.000Z",
    url: "https://example.com/pricing",
    // An external referrer on the view inside the period, so the test
    // only passes because the session belongs to the day before.
    referrer: "https://t.co/abc",
    props: {},
  });

  assert.deepEqual(getTopReferrers(db, PERIOD, 10, "page_view").items, []);
});

test("getTopReferrers excludes a self-referral entry, apex and www alike", () => {
  const db = setupDb();
  // Counting per session removes most links within the site, but not a
  // session that starts mid-visit: after 30 minutes without activity
  // (lib/session.ts), the next page view starts a new session with the
  // site's own page as referrer. Both with and without www.
  const rows: { url: string; referrer: string }[] = [
    { url: "https://example.com/x", referrer: "https://example.com/" },
    { url: "https://example.com/x", referrer: "https://www.example.com/a" },
    { url: "https://www.example.com/x", referrer: "https://example.com/b" },
    { url: "https://www.example.com/x", referrer: "https://www.example.com/c" },
    // A link from another subdomain is not removed: without the public
    // suffix list, the site's own subdomains can't be told from unrelated
    // sites under the same parent domain.
    { url: "https://example.com/x", referrer: "https://blog.example.com/p1" },
    { url: "https://example.com/x", referrer: "https://blog.example.com/p2" },
    { url: "https://example.com/x", referrer: "https://www.google.com/?q=1" },
    { url: "https://example.com/x", referrer: "https://www.google.com/?q=2" },
    { url: "https://example.com/x", referrer: "https://www.google.com/?q=3" },
    { url: "https://example.com/x", referrer: "" }, // direct
  ];
  rows.forEach((row, i) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
      url: row.url,
      referrer: row.referrer,
      props: {},
    });
  });

  const result = getTopReferrers(
    db,
    { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" },
    10,
    "page_view",
  ).items;

  assert.deepEqual(result, [
    { host: "www.google.com", sessions: 3 },
    { host: "blog.example.com", sessions: 2 },
    { host: null, sessions: 1 },
  ]);
});

test("getEntryPages ranks sessions by their first page-view path", () => {
  const db = setupDb();
  // s1 and s2 both start on /home; s3 starts on /pricing.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/home",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/home",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T12:00:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  // A non-page-view event before s3's page_view must not count as its
  // entry.
  insertEvent(db, {
    event: "outbound_link_click",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T11:55:00.000Z",
    url: "https://example.com/",
    props: {
      target_url: "https://partner.example.com/pricing",
      target_host: "partner.example.com",
      link_text: "Pricing",
    },
  });

  const result = getEntryPages(db, PERIOD, 10, "page_view").items;

  assert.deepEqual(result, [
    { host: "example.com", path: "/home", sessions: 2 },
    { host: "example.com", path: "/pricing", sessions: 1 },
  ]);
});

test("getExitPages ranks sessions by their last page-view path", () => {
  const db = setupDb();
  // s1 and s2 both end on /checkout; s3 ends on /about.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/home",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/checkout",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T11:05:00.000Z",
    url: "https://example.com/checkout",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T12:00:00.000Z",
    url: "https://example.com/about",
    props: {},
  });

  const result = getExitPages(db, PERIOD, 10, "page_view").items;

  assert.deepEqual(result, [
    { host: "example.com", path: "/checkout", sessions: 2 },
    { host: "example.com", path: "/about", sessions: 1 },
  ]);
});

test("getBouncePages reports bounce rate per entry page, sessions and bounced counts included", () => {
  const db = setupDb();
  // /landing: 3 sessions enter here, 2 of them bounce (1 page only).
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/landing",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/landing",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/landing",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/pricing",
    props: {},
  });
  // /home: 2 sessions enter here, both bounce.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v4",
    sessionId: "s4",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/home",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v5",
    sessionId: "s5",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/home",
    props: {},
  });

  const result = getBouncePages(db, PERIOD, 10, "page_view").items;

  assert.deepEqual(result, [
    {
      host: "example.com",
      path: "/home",
      sessions: 2,
      bounced: 2,
      bounceRate: 1,
    },
    {
      host: "example.com",
      path: "/landing",
      sessions: 3,
      bounced: 2,
      bounceRate: 0.6667,
    },
  ]);
});

test("getEntryPages/getExitPages/getBouncePages return empty arrays for a period with no events", () => {
  const db = setupDb();
  assert.deepEqual(getEntryPages(db, PERIOD, 10, "page_view").items, []);
  assert.deepEqual(getExitPages(db, PERIOD, 10, "page_view").items, []);
  assert.deepEqual(getBouncePages(db, PERIOD, 10, "page_view").items, []);
});

// A session belongs to the period it started in and is read in full.
// Otherwise a session already running at `from` would get a wrong entry
// page, and one with views before `from` would look like a bounce.
const STRADDLE_PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

function straddlingSessions(db: Database.Database) {
  // s1: began before the period, read /home then /pricing after midnight.
  // Not this period's session — its entry was /home yesterday, and
  // with two views it never bounced.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2025-12-31T23:55:00.000Z",
    url: "https://example.com/home",
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
  // s3: started before the period with a download; its first page view
  // is inside the period. Still not this period's session: what counts
  // is the session's first event of any kind.
  insertEvent(db, {
    event: "file_download",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2025-12-31T23:59:00.000Z",
    url: "https://example.com/late",
    props: {
      file_url: "https://example.com/a.pdf",
      file_extension: "pdf",
      link_text: "PDF",
    },
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v3",
    sessionId: "s3",
    ts: "2026-01-01T00:01:00.000Z",
    url: "https://example.com/late",
    props: {},
  });
  // s2: began late in the period on /blog, exited on /contact after
  // the period ended. Its real exit page is /contact.
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-01T23:50:00.000Z",
    url: "https://example.com/blog",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "s2",
    ts: "2026-01-02T00:10:00.000Z",
    url: "https://example.com/contact",
    props: {},
  });
}

// A session starting exactly at `from`. lib/sessionScope.ts uses
// `ts >= @from`; with `>` the first page view would be dropped and
// /second reported as the entry page.
test("getEntryPages counts a page view landing exactly on the period's start", () => {
  const db = setupDb();
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: STRADDLE_PERIOD.from,
    url: "https://example.com/first",
    props: {},
  });
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T00:30:00.000Z",
    url: "https://example.com/second",
    props: {},
  });

  assert.deepEqual(getEntryPages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { host: "example.com", path: "/first", sessions: 1 },
  ]);
});

test("getEntryPages ignores a session that began before the period", () => {
  const db = setupDb();
  straddlingSessions(db);
  assert.deepEqual(getEntryPages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { host: "example.com", path: "/blog", sessions: 1 },
  ]);
});

test("getExitPages reports a session's real last page, even after the period's end", () => {
  const db = setupDb();
  straddlingSessions(db);
  assert.deepEqual(getExitPages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { host: "example.com", path: "/contact", sessions: 1 },
  ]);
});

test("getBouncePages judges a session on its full length, not the part inside the period", () => {
  const db = setupDb();
  straddlingSessions(db);
  // s1 is not this period's; s2 read two pages, so nothing bounced.
  assert.deepEqual(getBouncePages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    {
      host: "example.com",
      path: "/blog",
      sessions: 1,
      bounced: 0,
      bounceRate: 0,
    },
  ]);
});

// Every ranked query also returns how many rows there were and their
// total, so the agent knows the list was cut and can compute shares.
test("getTopPages reports groups and total beyond the limit", () => {
  const db = setupDb();
  for (const [path, views] of [
    ["/a", 3],
    ["/b", 2],
    ["/c", 1],
  ] as const) {
    for (let i = 0; i < views; i++) {
      insertEvent(db, {
        event: "page_view",
        visitorId: "v1",
        sessionId: `s-${path}-${i}`,
        ts: `2026-01-01T10:0${i}:00.000Z`,
        url: `https://example.com${path}`,
        props: {},
      });
    }
  }

  assert.deepEqual(getTopPages(db, PERIOD, 1, "page_view"), {
    items: [{ host: "example.com", path: "/a", views: 3 }],
    groups: 3,
    total: 6,
  });
});

// Ranked by bounced sessions, not by rate: a page with one session at
// 100% must not rank above the page that loses the most visitors.
test("getBouncePages ranks by bounced sessions, keeping the rate on the row", () => {
  const db = setupDb();
  // /big: 3 entries, 2 bounced (rate 0.6667).
  for (let i = 0; i < 3; i++) {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: `big${i}`,
      ts: `2026-01-01T10:0${i}:00.000Z`,
      url: "https://example.com/big",
      props: {},
    });
  }
  insertEvent(db, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "big0",
    ts: "2026-01-01T10:10:00.000Z",
    url: "https://example.com/other",
    props: {},
  });
  // /tiny: 1 entry, 1 bounced (rate 1).
  insertEvent(db, {
    event: "page_view",
    visitorId: "v2",
    sessionId: "tiny",
    ts: "2026-01-01T11:00:00.000Z",
    url: "https://example.com/tiny",
    props: {},
  });

  assert.deepEqual(getBouncePages(db, PERIOD, 10, "page_view"), {
    items: [
      {
        host: "example.com",
        path: "/big",
        sessions: 3,
        bounced: 2,
        bounceRate: 0.6667,
      },
      {
        host: "example.com",
        path: "/tiny",
        sessions: 1,
        bounced: 1,
        bounceRate: 1,
      },
    ],
    groups: 2,
    total: 3,
  });
});

// Ranking sessions by a campaign parameter on their first page.
test("getTopEntryParams ranks sessions by one entry-page query parameter", () => {
  const db = setupDb();
  const entries = [
    ["s1", "https://example.com/?utm_campaign=spring&utm_source=news"],
    ["s2", "https://example.com/pricing?utm_campaign=spring"],
    ["s3", "https://example.com/?utm_campaign=autumn"],
    ["s4", "https://example.com/"],
  ] as const;
  for (const [session, url] of entries) {
    insertEvent(db, {
      event: "page_view",
      visitorId: session,
      sessionId: session,
      ts: "2026-01-01T10:00:00.000Z",
      url,
      props: {},
    });
  }
  // s1's later view has no parameter; only the entry page counts.
  insertEvent(db, {
    event: "page_view",
    visitorId: "s1",
    sessionId: "s1",
    ts: "2026-01-01T10:05:00.000Z",
    url: "https://example.com/other",
    props: {},
  });

  assert.deepEqual(
    getTopEntryParams(db, "utm_campaign", PERIOD, 10, "page_view"),
    {
      items: [
        { value: "spring", sessions: 2 },
        { value: "autumn", sessions: 1 },
      ],
      groups: 2,
      total: 3,
    },
  );
  assert.deepEqual(
    getTopEntryParams(db, "utm_source", PERIOD, 10, "page_view").items,
    [{ value: "news", sessions: 1 }],
  );
});
