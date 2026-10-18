import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { bareHost, parseUrl, siteHost } from "./url.js";
import { IN_SESSION_STARTED_IN_PERIOD } from "./sessionScope.js";

// A segment is a set of sessions, described by conditions that are all
// required (AND). Every query that takes a period also takes one of
// these, so "where did buyers of X come from" is get_top_referrers with
// a segment, not a tool of its own — and the same goes for "what do
// mobile visitors read" or "how did the newsletter campaign do". The
// clause is built once per call and pasted into each query's WHERE as
// `session_id IN (...)` fragments, so a query never needs to know
// which kind of condition it is filtering on.
//
// One condition per kind, deliberately no OR: intersecting session sets
// is one `IN` per condition, and every question that has come up reads
// as "sessions that did A and B".
export type SegmentCondition =
  // Sessions containing this event — optionally with one prop equal to
  // (or, for a list prop, containing) a value.
  | {
      kind: "event";
      event: string;
      property?: string;
      value?: string | number | boolean;
      isList?: boolean;
    }
  // Envelope fields, constant across a session.
  | { kind: "deviceType"; value: string }
  | { kind: "browser"; value: string }
  // null = the request carried no Accept-Language header. A bare
  // language ("en") also matches its regional variants ("en-US").
  | { kind: "language"; value: string | null }
  // A two-letter code, or "ZZ" for looked up and not found
  // (lib/country.ts).
  | { kind: "country"; value: string }
  // The site the session was on, folded through bareHost: one
  // installation may collect for several (siteHost in lib/url.ts).
  | { kind: "host"; value: string }
  // Where the session's entry page view came from; null = direct.
  | { kind: "referrerHost"; value: string | null }
  // The path of the session's entry page view.
  | { kind: "entryPath"; value: string }
  // One query parameter on the session's entry page view, e.g.
  // utm_campaign = "spring". Only the parameters ingestion keeps exist
  // to match on (lib/url.ts); the MCP layer checks that.
  | { kind: "entryParam"; name: string; value: string };

export interface SegmentClause {
  // Empty, or one " AND session_id IN (...)" per condition. Each
  // fragment refers to @from and @to, which every period query binds,
  // plus its own prefixed parameters in `params`.
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

  // The entry page views of the period, loaded once however many
  // entry-based conditions there are: it is every session's entry row,
  // the same materialisation get_top_referrers does, and repeating it
  // per condition multiplied the one cost in this builder.
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
        // The event itself is not bounded by the period — the session
        // is. A session that started at 23:50 and ordered at 00:10 is
        // "a session that ordered" for the day it started in, and the
        // session-shaped queries (entry, exit, bounce, duration) read
        // exactly that session in full; bounding the event to the
        // period dropped it from every segmented one of them while the
        // unsegmented query still counted it. Candidates are sessions
        // touching the period. The unary + keeps SQLite off the
        // (event, ts) index: with no ANALYZE statistics it would pick
        // that one and walk every row of the event since the database
        // began, checking each against the period's sessions.
        let where = `+event = ${bind("event", condition.event)} AND session_id IN (SELECT session_id FROM events WHERE ts BETWEEN @from AND @to)`;
        if (condition.property !== undefined) {
          const path = bind("path", `$.${condition.property}`);
          // SQLite stores JSON booleans as 0/1, so a boolean value has
          // to be compared as a number.
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
        // The breakdowns fold a NULL column (no User-Agent header at
        // all) into the unclassified bucket, so a segment on that
        // bucket has to reach the same rows or it under-counts what the
        // breakdown just reported.
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
        // Locale tags are case-insensitive (en-US, en-us). Compared
        // lowercased on both sides, and the variant match is a plain
        // prefix on substr() rather than LIKE, so "%" and "_" in the
        // value are characters, not wildcards.
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
        // By the session's first event in the period, the row
        // getTopCountries files it under, so a session that changed
        // network midway (a VPN switched on) is in one country's
        // segment and that country's row, never in another's segment
        // while counted under the first.
        fragments.push(
          `SELECT session_id FROM (SELECT session_id, country, MIN(ts) FROM events WHERE ts BETWEEN @from AND @to GROUP BY session_id) WHERE country = ${bind("value", condition.value)}`,
        );
        break;
      }
      case "host": {
        // By the session's first event in the period, like country, and
        // not its entry page view: a session of custom events only has
        // a site too. A session stored since 0.13.0 never changes site
        // (lib/session.ts); an older one that did is filed under its
        // first, as periodHosts files it.
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
        // Resolved in JS, like getTopReferrers and getEntryPages do:
        // a host or a query parameter is parsed out of the stored URL
        // at query time, not stored as a column (see "Data model" in
        // docs/decisions.md). The matching session ids go in as one
        // JSON array, the same json_each idiom lib/funnel.ts uses to
        // stay under SQLite's bound-parameter cap.
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

// The first event of every session in the period, for its url.
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

// The sites with a session in the period, so a host segment naming
// none of them is refused with the list rather than matched against
// nothing — a typo'd host would otherwise read as a site with no
// visitors. Busiest first: the url is the sender's to write, so a
// stranger posting to /events can add hosts, and the caller lists only
// the first few.
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

// The entry page view of every session that started in the period —
// the same rows getEntryPages and getTopReferrers rank.
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
      // Apex and www fold together, as in getTopReferrers.
      return bareHost(host) === bareHost(condition.value);
    }
    case "entryPath":
      return parseUrl(entry.url).path === condition.value;
    case "entryParam":
      return queryParam(entry.url, condition.name) === condition.value;
  }
}

// The value of one query parameter on a stored URL, matched by name
// case-insensitively: the allowlist that keeps utm_* at ingestion is
// case-insensitive and preserves the URL's own casing, so a link tagged
// UTM_Campaign is stored that way and must still answer to utm_campaign.
export function queryParam(url: string, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of new URLSearchParams(parseUrl(url).params)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}
