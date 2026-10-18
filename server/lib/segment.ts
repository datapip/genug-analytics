import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { bareHost, parseUrl, siteHost } from "./url.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// A segment is a set of sessions, described by conditions that must all
// be true (AND). Every query that takes a period also takes a segment, so
// "where did buyers of X come from" is get_top_referrers with a segment,
// not a separate tool; the same goes for "what do mobile visitors read"
// or "how did the newsletter campaign do". The condition is built once
// per call and added to each query's WHERE as `session_id IN (...)`
// parts, so the query doesn't need to know what kind of condition it is.
//
// One condition per kind, and no OR: each condition is one `IN`, and
// every real question so far was "sessions that did A and B".
export type SegmentCondition =
  // Sessions with this event, optionally where one prop equals a value
  // (or, for a list prop, contains it).
  | {
      kind: "event";
      event: string;
      property?: string;
      value?: string | number | boolean;
      isList?: boolean;
    }
  // Fields that are the same for the whole session.
  | { kind: "deviceType"; value: string }
  | { kind: "browser"; value: string }
  // null = the request had no Accept-Language header. A plain language
  // ("en") also matches its regional variants ("en-US").
  | { kind: "language"; value: string | null }
  // A two-letter code, or "ZZ" for "looked up, not found"
  // (lib/country.ts).
  | { kind: "country"; value: string }
  // The site the session was on (www removed by bareHost). One
  // installation may collect for several sites (siteHost in lib/url.ts).
  | { kind: "host"; value: string }
  // Where the session's first page view came from; null = direct.
  | { kind: "referrerHost"; value: string | null }
  // The path of the session's first page view.
  | { kind: "entryPath"; value: string }
  // One query parameter on the session's first page view, such as
  // utm_campaign = "spring". Only kept parameters are stored
  // (lib/url.ts); the MCP tools check that.
  | { kind: "entryParam"; name: string; value: string };

export interface SegmentClause {
  // Empty, or one " AND session_id IN (...)" per condition. Each part
  // uses @from and @to, which every period query provides, plus its own
  // parameters from `params`.
  sql: string;
  params: Record<string, unknown>;
}

export const NO_SEGMENT: SegmentClause = { sql: "", params: {} };

export function buildSegment(
  db: Database.Database,
  conditions: readonly SegmentCondition[],
  period: Period,
  pageViewEvent: string,
): SegmentClause {
  const fragments: string[] = [];
  const params: Record<string, unknown> = {};

  // The first page views of the period's sessions, loaded once, however
  // many conditions need them. This is the slow part of building a
  // segment, so it shouldn't run once per condition.
  let entries: EntryPageView[] | undefined;
  const entryPageViews = () =>
    (entries ??= entrySessions(db, period, pageViewEvent));
  let hosts: SessionHost[] | undefined;
  const sessionHostRows = () => (hosts ??= sessionHosts(db, period));

  conditions.forEach((condition, index) => {
    const p = (name: string) => `s${index}_${name}`;
    const bind = (name: string, value: unknown) => {
      params[p(name)] = value;
      return `@${p(name)}`;
    };

    switch (condition.kind) {
      case "event": {
        // The session must touch the period, but the event itself may be
        // outside it. A session that started at 23:50 and ordered at
        // 00:10 is "a session that ordered" for the day it started, and
        // the session queries (entry, exit, bounce, duration) read it in
        // full. The unary + stops SQLite from using the (event, ts)
        // index: without statistics it would choose that index and read
        // every row of the event ever stored.
        let where = `+event = ${bind("event", condition.event)} AND session_id IN (SELECT session_id FROM events WHERE ts BETWEEN @from AND @to)`;
        if (condition.property !== undefined) {
          const path = bind("path", `$.${condition.property}`);
          // SQLite stores JSON booleans as 0/1, so compare booleans as
          // numbers.
          const value = bind(
            "value",
            typeof condition.value === "boolean"
              ? Number(condition.value)
              : condition.value,
          );
          where += condition.isList
            ? ` AND EXISTS (SELECT 1 FROM json_each(json_extract(props, ${path})) WHERE value = ${value})`
            : ` AND json_extract(props, ${path}) = ${value}`;
        }
        fragments.push(`SELECT session_id FROM events WHERE ${where}`);
        break;
      }
      case "deviceType":
      case "browser": {
        const column =
          condition.kind === "deviceType" ? "device_type" : "browser";
        // The breakdowns count NULL (no User-Agent header) as
        // unclassified, so the segment for that value must include NULL
        // rows too, or it would find fewer than the breakdown reported.
        const unclassified =
          condition.kind === "deviceType" ? "other" : "Other";
        const value = bind("value", condition.value);
        const match =
          condition.value === unclassified
            ? `(${column} = ${value} OR ${column} IS NULL)`
            : `${column} = ${value}`;
        fragments.push(
          `SELECT session_id FROM events WHERE ${match} AND ts BETWEEN @from AND @to`,
        );
        break;
      }
      case "language": {
        // Language tags ignore case (en-US, en-us), so both sides are
        // lowercased. The regional-variant match compares a prefix with
        // substr() rather than LIKE, so "%" and "_" in the value are
        // plain characters, not wildcards.
        const lowered = condition.value?.toLowerCase();
        const prefix = `${lowered}-`;
        const match =
          lowered === undefined
            ? "visitor_language IS NULL"
            : `(lower(visitor_language) = ${bind("value", lowered)} OR substr(lower(visitor_language), 1, ${bind("prefixLength", prefix.length)}) = ${bind("prefix", prefix)})`;
        fragments.push(
          `SELECT session_id FROM events WHERE ${match} AND ts BETWEEN @from AND @to`,
        );
        break;
      }
      case "country": {
        // Uses the session's first event in the period, as
        // getTopCountries does. A session that changed network midway
        // (say, a VPN was switched on) then belongs to one country in
        // both.
        fragments.push(
          `SELECT session_id FROM (SELECT session_id, country, MIN(ts) FROM events WHERE ts BETWEEN @from AND @to GROUP BY session_id) WHERE country = ${bind("value", condition.value)}`,
        );
        break;
      }
      case "host": {
        // Uses the session's first event in the period, like country,
        // not its first page view: a session with only custom events has
        // a site too. New sessions never change site (lib/session.ts);
        // an older one that did belongs to its first site, as in
        // periodHosts.
        const ids = sessionHostRows()
          .filter((row) => siteHost(row.url) === condition.value)
          .map((row) => row.sessionId);
        fragments.push(
          `SELECT value FROM json_each(${bind("ids", JSON.stringify(ids))})`,
        );
        break;
      }
      case "referrerHost":
      case "entryPath":
      case "entryParam": {
        // Worked out in JavaScript, as in getTopReferrers and
        // getEntryPages: the host or query parameter is parsed from the
        // stored URL when queried, not stored as a column (see "Data
        // model" in docs/decisions.md). The matching session ids are
        // passed as one JSON array (json_each), as in lib/funnel.ts, to
        // stay under SQLite's limit on parameters.
        const ids = entryPageViews()
          .filter((entry) => matchesEntry(condition, entry))
          .map((entry) => entry.sessionId);
        fragments.push(
          `SELECT value FROM json_each(${bind("ids", JSON.stringify(ids))})`,
        );
        break;
      }
    }
  });

  return {
    sql: fragments
      .map((fragment) => ` AND session_id IN (${fragment})`)
      .join(""),
    params,
  };
}

interface SessionHost {
  sessionId: string;
  url: string;
}

// The url of the first event of every session in the period.
function sessionHosts(db: Database.Database, period: Period): SessionHost[] {
  return db
    .prepare(
      `SELECT session_id AS sessionId, url, MIN(ts) AS first_ts
       FROM events
       WHERE ts BETWEEN @from AND @to
       GROUP BY session_id`,
    )
    .all({ from: period.from, to: period.to }) as SessionHost[];
}

// The sites with a session in the period, so a host segment that names
// none of them is refused with this list. Otherwise a typo would look
// like a site without visitors. Busiest first, and the caller only
// lists the first few.
export function periodHosts(db: Database.Database, period: Period): string[] {
  const sessions = new Map<string, number>();
  for (const row of sessionHosts(db, period)) {
    const host = siteHost(row.url);
    if (host !== "") sessions.set(host, (sessions.get(host) ?? 0) + 1);
  }
  return [...sessions.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([host]) => host);
}

interface EntryPageView {
  sessionId: string;
  url: string;
  referrer: string | null;
}

// The first page view of every session that started in the period,
// the same rows getEntryPages and getTopReferrers use.
function entrySessions(
  db: Database.Database,
  period: Period,
  pageViewEvent: string,
): EntryPageView[] {
  return db
    .prepare(
      `SELECT session_id AS sessionId, url, referrer, MIN(ts) AS first_ts
       FROM events
       WHERE event = @pageViewEvent
         AND ${IN_SESSION_STARTED_IN_PERIOD}
       GROUP BY session_id`,
    )
    .all({
      pageViewEvent,
      from: period.from,
      to: period.to,
    }) as EntryPageView[];
}

function matchesEntry(
  condition: Extract<
    SegmentCondition,
    { kind: "referrerHost" | "entryPath" | "entryParam" }
  >,
  entry: EntryPageView,
): boolean {
  switch (condition.kind) {
    case "referrerHost": {
      const host = entry.referrer
        ? parseUrl(entry.referrer).host || null
        : null;
      if (condition.value === null || host === null) {
        return host === condition.value;
      }
      // example.com and www.example.com count as one, as in
      // getTopReferrers.
      return bareHost(host) === bareHost(condition.value);
    }
    case "entryPath":
      return parseUrl(entry.url).path === condition.value;
    case "entryParam":
      return queryParam(entry.url, condition.name) === condition.value;
  }
}

// The value of one query parameter on a stored URL, matching the name
// ignoring case. The kept-parameter list ignores case but stores the URL
// as it was, so a link tagged UTM_Campaign is stored that way and must
// still match utm_campaign.
export function queryParam(url: string, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of new URLSearchParams(parseUrl(url).params)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}
