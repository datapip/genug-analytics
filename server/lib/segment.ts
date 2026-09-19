import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import { parseUrl } from "./url.js";
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
        // touching the period, so this never scans an event's whole
        // history.
        let where = `event = ${bind("event", condition.event)} AND session_id IN (SELECT session_id FROM events WHERE ts BETWEEN @from AND @to)`;
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

export function bareHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}
