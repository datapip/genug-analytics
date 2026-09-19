import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { parseUrl } from "./url.js";
import {
  rank,
  rankSessionsBy,
  mapRanked,
  roundTo,
  type Ranked,
} from "./aggregate.js";
import {
  NO_SEGMENT,
  bareHost,
  queryParam,
  type SegmentClause,
} from "./segment.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// "Which pages, and where visitors came from" — every query here is
// scoped to the page-view event, which is why each takes it as an
// argument rather than assuming a name. Pairs with mcp/content.ts.
//
// Every query takes an optional segment (lib/segment.ts): "where did
// buyers of X come from" is getTopReferrers narrowed to those sessions.

export interface TopPage {
  path: string;
  views: number;
}

// Grouped by path, not the raw url — two URLs differing only by query
// string or hash (e.g. ?utm_source=... or a same-page anchor link) are
// the same page and shouldn't be counted, or shown, separately.
// Grouping happens in JS rather than SQL because SQLite has no URL
// parser — the SQL step still does the (cheap, indexed) per-url count,
// this just re-aggregates that small distinct-url set by path, which is
// fine at this project's moderate-traffic scale (see "Target user" in
// docs/decisions.md).
export function getTopPages(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<TopPage> {
  const rows = db
    .prepare(
      `SELECT url, COUNT(*) AS views
       FROM events
       WHERE event = @pageViewEvent AND ts BETWEEN @from AND @to${segment.sql}
       GROUP BY url`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    url: string;
    views: number;
  }[];

  const viewsByPath = new Map<string, number>();
  for (const row of rows) {
    const { path } = parseUrl(row.url);
    viewsByPath.set(path, (viewsByPath.get(path) ?? 0) + row.views);
  }

  return rank(
    [...viewsByPath.entries()].map(([path, views]) => ({ path, views })),
    (row) => row.views,
    limit,
  );
}

interface EntryPageView {
  url: string;
  referrer: string | null;
}

// The page view that started each session that started in the period.
// MIN(ts) with bare columns alongside: SQLite takes them from the row
// that produced the minimum, so this is each session's entry page view
// and its referrer — no subquery or window function needed. Shared by
// every "where did they land / come from" query below.
function entryPageViews(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
  segment: SegmentClause,
): EntryPageView[] {
  return db
    .prepare(
      `SELECT url, referrer, MIN(ts) AS first_ts
       FROM events
       WHERE event = @pageViewEvent
         AND ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as EntryPageView[];
}

export interface TopReferrer {
  host: string | null; // null = direct traffic (no referrer)
  sessions: number;
}

// A site reachable at both the apex and the www subdomain is one site,
// so a link from one to the other is internal navigation rather than a
// traffic source. Only `www` is folded: anything more (treating
// blog.example.com and shop.example.com as one site) needs a public
// suffix list to tell a subdomain from a separate registrable domain,
// and that is a dependency this project won't take for a ranking.
function isSelfReferral(referrerHost: string, ownHost: string): boolean {
  return bareHost(referrerHost) === bareHost(ownHost);
}

// One row per session, keyed on the referrer of the page view that
// started it, grouped by hostname rather than full URL — a single
// source like Google Search would otherwise fragment into one row per
// distinct search-result URL. Scoped to the page-view event, whichever
// event a deployment tagged "_pageView": true.
//
// **Counted per session, not per page view.** A traffic source is a way
// in, and a visit arrives through exactly one of them however many
// pages it goes on to read. Counting views made engagement look like
// acquisition, and on a single-page app it did so dramatically:
// `document.referrer` does not change on a route change (see "Client
// script embedding contract" in docs/decisions.md), so a visitor who
// arrived from Google and clicked through five routes was five Google
// page views. The busier the visit, the more it inflated whatever
// brought it.
//
// Self-referrals are still excluded. Session-scoping removes most of
// them by construction — the site's own previous page is only ever the
// referrer of a page view that isn't the first — but not all: a session
// ends after 30 minutes idle (see lib/session.ts), so a visitor who
// pauses and carries on starts a new session whose entry page view
// carries the previous page. That is the same visit continuing, not a
// new source, so it is dropped rather than counted as direct.
export function getTopReferrers(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<TopReferrer> {
  const sessionsByHost = new Map<string | null, number>();
  for (const row of entryPageViews(db, period, pageViewEvent, segment)) {
    // The client always sends document.referrer, "" for direct traffic
    // — so "" (falsy) and SQL NULL (no referrer field sent at all, an
    // atypical caller bypassing the client script) both mean "direct"
    // and must merge into the same bucket, not two separate ones.
    const host = row.referrer ? parseUrl(row.referrer).host || null : null;
    if (host !== null && isSelfReferral(host, parseUrl(row.url).host)) continue;
    sessionsByHost.set(host, (sessionsByHost.get(host) ?? 0) + 1);
  }

  return rank(
    [...sessionsByHost.entries()].map(([host, sessions]) => ({
      host,
      sessions,
    })),
    (row) => row.sessions,
    limit,
  );
}

export interface EntryParamValue {
  value: string;
  sessions: number;
}

// Sessions ranked by the value of one query parameter on their entry
// page view — `utm_campaign`, `gclid`, whatever the site owner tags
// links with. Ingestion keeps the campaign and click-id parameters and
// strips everything else (lib/url.ts), so this is the read side of
// that decision: still no attribution model, no opinion about which
// parameter matters or how to combine them — the caller names one.
// Sessions whose entry page carried no such parameter are not a row;
// `groups` and `total` therefore describe tagged sessions only.
export function getTopEntryParams(
  db: Database.Database,
  param: string,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<EntryParamValue> {
  const tagged = entryPageViews(db, period, pageViewEvent, segment)
    .map((row) => queryParam(row.url, param))
    .filter((value): value is string => value !== null);

  return mapRanked(
    rankSessionsBy(tagged, (value) => value, limit),
    ({ key, sessions }) => ({ value: key, sessions }),
  );
}

export interface EntryPage {
  path: string;
  sessions: number;
}

export function getEntryPages(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<EntryPage> {
  return mapRanked(
    rankSessionsBy(
      entryPageViews(db, period, pageViewEvent, segment),
      (row) => parseUrl(row.url).path,
      limit,
    ),
    ({ key, sessions }) => ({ path: key, sessions }),
  );
}

export interface ExitPage {
  path: string;
  sessions: number;
}

// Same as getEntryPages, but the page-view event with the latest ts per
// session — only meaningful in retrospect, once a session is over (see
// getSessionSummary), so this is necessarily query-time.
export function getExitPages(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<ExitPage> {
  const rows = db
    .prepare(
      `SELECT url, MAX(ts) AS last_ts
       FROM events
       WHERE event = @pageViewEvent
         AND ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    url: string;
  }[];

  return mapRanked(
    rankSessionsBy(rows, (row) => parseUrl(row.url).path, limit),
    ({ key, sessions }) => ({ path: key, sessions }),
  );
}

export interface BouncePage {
  path: string;
  sessions: number; // sessions that entered on this page
  bounced: number; // of those, how many viewed no other page
  bounceRate: number; // bounced / sessions, 0-1
}

// "Bounced" = a session's only page-view event was this one — i.e. the
// visitor left without viewing a second page. Grouped by each session's
// entry page, same as getEntryPages, carrying along how many page-view
// events that session had in total.
export function getBouncePages(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<BouncePage> {
  const rows = db
    .prepare(
      `SELECT url, MIN(ts) AS first_ts, COUNT(*) AS viewEvents
       FROM events
       WHERE event = @pageViewEvent
         AND ${IN_SESSION_STARTED_IN_PERIOD}${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as {
    url: string;
    viewEvents: number;
  }[];

  const byPath = new Map<string, { sessions: number; bounced: number }>();
  for (const row of rows) {
    const { path } = parseUrl(row.url);
    const entry = byPath.get(path) ?? { sessions: 0, bounced: 0 };
    entry.sessions += 1;
    if (row.viewEvents === 1) entry.bounced += 1;
    byPath.set(path, entry);
  }

  // Ranked by bounced sessions, not by rate: sorted on the rate, a page
  // with one session and one bounce sat above one with 500 sessions
  // and 400 bounces, and the description had to warn about it instead
  // of the ranking meaning something. "Which pages lose the most
  // visitors" is the question; the rate stays on the row for reading —
  // and breaks ties, since rank() sorts stably: of two pages losing the
  // same number, the one losing a larger share comes first.
  const pages = [...byPath.entries()]
    .map(([path, { sessions, bounced }]) => ({
      path,
      sessions,
      bounced,
      bounceRate: roundTo(bounced / sessions, 4),
    }))
    .sort((a, b) => b.bounceRate - a.bounceRate);
  return rank(pages, (row) => row.bounced, limit);
}
