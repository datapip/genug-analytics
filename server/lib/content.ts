import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { bareHost, parseUrl } from "./url.js";
import {
  rank,
  rankSessionsBy,
  mapRanked,
  roundTo,
  type Ranked,
} from "./aggregate.js";
import { NO_SEGMENT, queryParam, type SegmentClause } from "./segment.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// Queries about pages and where visitors came from. They all count the
// page-view event, whose name is passed in rather than assumed. Used by
// mcp/content.ts.
//
// Every query takes an optional segment (lib/segment.ts): "where did
// buyers of X come from" is getTopReferrers limited to those sessions.

// A page is a path on a site. One installation may collect for several
// sites (siteHost in lib/url.ts), and "/" on two of them is two pages.
// Every row has its host, even with only one site, so rows always have
// the same fields.
interface PageKey {
  host: string;
  path: string;
}

// One string per page, used as a Map key. The host comes from siteHost
// (www removed) and never contains a newline, so splitting at the first
// newline gets host and path back, even when the path is an unparseable
// url that contains newlines.
function pageKey(url: string): string {
  const { host, path } = parseUrl(url);
  return `${bareHost(host)}\n${path}`;
}

function fromPageKey(key: string): PageKey {
  const split = key.indexOf("\n");
  return { host: key.slice(0, split), path: key.slice(split + 1) };
}

export interface TopPage extends PageKey {
  views: number;
}

// Grouped by host and path, not the full url: two URLs that differ only
// in query string or fragment (?utm_source=... or #section) are the same
// page. SQLite can't parse URLs, so SQL counts views per url and this
// code then adds them up per page. That is fast enough for the sites
// this project is for (see "Target user" in docs/decisions.md).
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

  const viewsByPage = new Map<string, number>();
  for (const row of rows) {
    const key = pageKey(row.url);
    viewsByPage.set(key, (viewsByPage.get(key) ?? 0) + row.views);
  }

  return rank(
    [...viewsByPage.entries()].map(([key, views]) => ({
      ...fromPageKey(key),
      views,
    })),
    (row) => row.views,
    limit,
  );
}

interface EntryPageView {
  url: string;
  referrer: string | null;
}

// The first page view of each session that started in the period. When
// a query has MIN(ts), SQLite takes the other plain columns from the row
// with that minimum, so this returns each session's first page view and
// its referrer without a subquery. Used by the entry and referrer
// queries below.
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

// A link from example.com to www.example.com (or back) is the visitor
// moving within the site, not a traffic source. See bareHost in
// lib/url.ts for why only `www` is removed.
function isSelfReferral(referrerHost: string, ownHost: string): boolean {
  return bareHost(referrerHost) === bareHost(ownHost);
}

// Counts sessions by the referrer of their first page view, grouped by
// hostname rather than full URL; otherwise Google Search would be one row
// per search-results URL.
//
// **Counted per session, not per page view.** A visit arrives through
// one source, however many pages it then reads. Counting page views
// would make busy visits inflate their source. On a single-page app
// `document.referrer` doesn't change between routes (see "Client script
// embedding contract" in docs/decisions.md), so one visitor from Google
// who clicked through five routes would count as five.
//
// Referrals from the site itself are left out. Counting per session
// removes most of them, but not all: a session ends after 30 minutes
// without activity (lib/session.ts), so a visitor who pauses and goes on
// starts a new session whose first page view has the previous page as
// referrer. That is the same visit continuing, so it is dropped rather
// than counted as direct.
export function getTopReferrers(
  db: Database.Database,
  period: Period,
  limit: number,
  pageViewEvent: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<TopReferrer> {
  const sessionsByHost = new Map<string | null, number>();
  for (const row of entryPageViews(db, period, pageViewEvent, segment)) {
    // The client sends "" as the referrer for direct traffic. A request
    // sent without the client script may have no referrer at all (NULL).
    // Both mean "direct" and are counted together.
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

// Ranks sessions by the value of one query parameter on their first page
// view, such as `utm_campaign`. Only the kept parameters are stored
// (lib/url.ts). There is no attribution model: the caller names one
// parameter. Sessions whose first page had no such parameter are left
// out, so `groups` and `total` only cover tagged sessions.
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

export interface EntryPage extends PageKey {
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
      (row) => pageKey(row.url),
      limit,
    ),
    ({ key, sessions }) => ({ ...fromPageKey(key), sessions }),
  );
}

export interface ExitPage extends PageKey {
  sessions: number;
}

// Same as getEntryPages, but for the last page view of each session.
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
    rankSessionsBy(rows, (row) => pageKey(row.url), limit),
    ({ key, sessions }) => ({ ...fromPageKey(key), sessions }),
  );
}

export interface BouncePage extends PageKey {
  sessions: number; // sessions that entered on this page
  bounced: number; // of those, how many viewed no other page
  bounceRate: number; // bounced / sessions, 0-1
}

// A session "bounced" when this was its only page view: the visitor left
// without viewing a second page. Grouped by each session's first page,
// like getEntryPages, with the number of page views each session had.
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

  const byPage = new Map<string, { sessions: number; bounced: number }>();
  for (const row of rows) {
    const key = pageKey(row.url);
    const entry = byPage.get(key) ?? { sessions: 0, bounced: 0 };
    entry.sessions += 1;
    if (row.viewEvents === 1) entry.bounced += 1;
    byPage.set(key, entry);
  }

  // Ranked by the number of bounced sessions, not by rate: by rate, a
  // page with 1 session and 1 bounce would rank above one with 500
  // sessions and 400 bounces. The question is "which pages lose the most
  // visitors". The rate is still on each row, and it breaks ties: rank()
  // keeps the input order for equal counts, so of two pages losing the
  // same number, the one with the higher rate comes first.
  const pages = [...byPage.entries()]
    .map(([key, { sessions, bounced }]) => ({
      ...fromPageKey(key),
      sessions,
      bounced,
      bounceRate: roundTo(bounced / sessions, 4),
    }))
    .sort((a, b) => b.bounceRate - a.bounceRate);
  return rank(pages, (row) => row.bounced, limit);
}
