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
    { path: "/", views: 3 },
    { path: "/pricing", views: 2 },
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

  assert.deepEqual(result, [{ path: "/blog/post-1", views: 4 }]);
});

test("getTopReferrers counts sessions and buckets no-referrer as direct (null)", () => {
  const db = setupDb();
  // Distinct counts per bucket (3/2/1) so the expected order is
  // unambiguous regardless of the underlying row iteration order.
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
  // The case that made this session-scoped. On a single-page app
  // document.referrer does not change on a route change, so every page
  // view of this one visit carries the Google referrer — counted per
  // view, one visitor reading six pages was six Google visits.
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
  // The discriminating case for the MIN(ts) row pick: unlike an SPA,
  // here the later views carry the site's own pages. Pick the wrong row
  // of the group and the referrer is a self-referral, so the session is
  // not merely misattributed — it is dropped from the report entirely.
  // That asymmetry is why this matters more here than in getEntryPages,
  // where a wrong row still counts the session, just under another path.
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

  // deepEqual on the whole array, so a stray direct bucket fails too.
  assert.deepEqual(getTopReferrers(db, PERIOD, 10, "page_view").items, [
    { host: "www.google.com", sessions: 1 },
  ]);
});

test("getTopReferrers does not count a session that began before the period", () => {
  const db = setupDb();
  // The session started the day before, so it belongs to that day's
  // referrer split, not this one — its Google entry was already counted
  // there. Pinned because it is a real edge with a real cost: referrer
  // totals come out below the period's active-session count. (Before
  // sessions were scoped by their start, this only passed because the
  // in-window view's referrer happened to be a self-referral.)
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
    // An external referrer on the in-window view, so this only passes
    // because the session is scoped out — not because the self-referral
    // rule happened to drop it.
    referrer: "https://t.co/abc",
    props: {},
  });

  assert.deepEqual(getTopReferrers(db, PERIOD, 10, "page_view").items, []);
});

test("getTopReferrers excludes a self-referral entry, apex and www alike", () => {
  const db = setupDb();
  // Session-scoping removes most internal navigation by construction,
  // but not a session that begins mid-visit: 30 minutes idle ends one
  // (see lib/session.ts), so the next page view starts a session whose
  // entry carries the site's own previous page. Both spellings, since a
  // visitor can cross between them.
  const rows: { url: string; referrer: string }[] = [
    { url: "https://example.com/x", referrer: "https://example.com/" },
    { url: "https://example.com/x", referrer: "https://www.example.com/a" },
    { url: "https://www.example.com/x", referrer: "https://example.com/b" },
    { url: "https://www.example.com/x", referrer: "https://www.example.com/c" },
    // A referral from another subdomain is NOT folded away: without a
    // public suffix list there is no telling one of the deployment's own
    // subdomains from an unrelated site sharing a parent domain.
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
  // A non-page-view event before s3's page_view — must not be mistaken
  // for an earlier "entry" than the actual first page view.
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
    { path: "/home", sessions: 2 },
    { path: "/pricing", sessions: 1 },
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
    { path: "/checkout", sessions: 2 },
    { path: "/about", sessions: 1 },
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
    { path: "/home", sessions: 2, bounced: 2, bounceRate: 1 },
    { path: "/landing", sessions: 3, bounced: 2, bounceRate: 0.6667 },
  ]);
});

test("getEntryPages/getExitPages/getBouncePages return empty arrays for a period with no events", () => {
  const db = setupDb();
  assert.deepEqual(getEntryPages(db, PERIOD, 10, "page_view").items, []);
  assert.deepEqual(getExitPages(db, PERIOD, 10, "page_view").items, []);
  assert.deepEqual(getBouncePages(db, PERIOD, 10, "page_view").items, []);
});

// The edge every session-shaped query used to get wrong: a session
// under way at `from` had its first in-window view reported as its
// entry, and one with views before `from` reported as a bounce. A
// session belongs to the period it started in and is read in full.
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
  // s3: began before the period with a download, first page view
  // inside it. Still not this period's session — the scope is on the
  // session's first event of any type, not its first page view.
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

// The boundary the period's own start sits on. The scope condition
// bounds the outer query with `ts >= @from` (see lib/sessionScope.ts),
// and a strict `>` there would drop this session's first page view
// while still counting the session — reporting /second as where it
// entered, which is wrong and looks entirely plausible.
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
    { path: "/first", sessions: 1 },
  ]);
});

test("getEntryPages ignores a session that began before the period", () => {
  const db = setupDb();
  straddlingSessions(db);
  assert.deepEqual(getEntryPages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { path: "/blog", sessions: 1 },
  ]);
});

test("getExitPages reports a session's real last page, even after the period's end", () => {
  const db = setupDb();
  straddlingSessions(db);
  assert.deepEqual(getExitPages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { path: "/contact", sessions: 1 },
  ]);
});

test("getBouncePages judges a session on its full length, not the part inside the period", () => {
  const db = setupDb();
  straddlingSessions(db);
  // s1 is not this period's; s2 read two pages, so nothing bounced.
  assert.deepEqual(getBouncePages(db, STRADDLE_PERIOD, 10, "page_view").items, [
    { path: "/blog", sessions: 1, bounced: 0, bounceRate: 0 },
  ]);
});

// The wrapper every ranked query returns: what was cut, and the
// denominator for a share, so the agent never mistakes ten rows for
// the whole and never needs a second call to compute a percentage.
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
    items: [{ path: "/a", views: 3 }],
    groups: 3,
    total: 6,
  });
});

// Ranked by bounced sessions, not rate: a one-session page at 100%
// must not outrank the page that actually loses the most visitors.
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
      { path: "/big", sessions: 3, bounced: 2, bounceRate: 0.6667 },
      { path: "/tiny", sessions: 1, bounced: 1, bounceRate: 1 },
    ],
    groups: 2,
    total: 3,
  });
});

// Campaign parameters are kept at ingestion and were read by nothing.
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
  // s1's later view carries no parameter — the entry page is what counts.
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
