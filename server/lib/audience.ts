import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import {
  rankSessionsBy,
  mapRanked,
  roundTo,
  type Ranked,
} from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";

// Queries about who is visiting: languages, countries, devices, consent,
// new and returning visitors. Traffic volume is in traffic.ts, pages in
// content.ts. Used by mcp/audience.ts.

export interface LanguageCount {
  // null = the request had no Accept-Language header, so the visitor's
  // language is unknown.
  language: string | null;
  sessions: number;
}

// The language of the visitor's browser (from the Accept-Language
// header), not the page's language, which a document_language prop may
// record.
//
// Counted in sessions, like the other audience breakdowns. Not in
// events, since one busy visitor shouldn't outweigh a larger audience
// speaking another language. Not in visitors either: without consent a
// visitor_id changes daily, so over a month one reader could count up to
// thirty times.
//
// Each session counts once, under the language of its first event, as
// entry pages and referrers do. The language is stored per event, and
// one session can have several (one visitor id can cover several people
// behind one address with the same User-Agent). Grouping with
// COUNT(DISTINCT session_id) would count such a session under each
// language, so the shares would add up to more than 100%.
export function getTopLanguages(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<LanguageCount> {
  const rows = db
    .prepare(
      `SELECT visitor_language AS language, MIN(ts) AS first_ts
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as { language: string | null }[];

  // A null language (no Accept-Language header) needs its own key that
  // can't be mistaken for a language code.
  const NO_LANGUAGE = "\u0000none";
  return mapRanked(
    rankSessionsBy(rows, (row) => row.language ?? NO_LANGUAGE, limit),
    ({ key, sessions }) => ({
      language: key === NO_LANGUAGE ? null : key,
      sessions,
    }),
  );
}

export interface CountryCount {
  // A two-letter code; "ZZ" when the lookup ran and found nothing (see
  // lib/country.ts).
  country: string;
  sessions: number;
}

// Where visitors are, by the country of their shortened address
// (lib/country.ts). Counted in sessions, each under its first event's
// country, for the same reasons as getTopLanguages above.
//
// Sessions without a lookup (stored while COUNTRY_LOOKUP was off) are
// counted separately, not as a row: a row could be cut off by the limit
// while still counting in `total`, which would make every share wrong.
export function getTopCountries(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<CountryCount> & { notLookedUp: number } {
  const rows = db
    .prepare(
      `SELECT country, MIN(ts) AS first_ts
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as { country: string | null }[];

  const lookedUp = rows.filter((row) => row.country !== null);
  return {
    ...mapRanked(
      rankSessionsBy(lookedUp, (row) => row.country!, limit),
      ({ key, sessions }) => ({ country: key, sessions }),
    ),
    notLookedUp: rows.length - lookedUp.length,
  };
}

// Whether any row in the period has a country. That tells "no sessions
// from this country" apart from "the lookup never ran".
export function periodHasCountries(
  db: Database.Database,
  period: Period,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM events
         WHERE ts BETWEEN @from AND @to AND country IS NOT NULL
         LIMIT 1`,
      )
      .get({ from: period.from, to: period.to }) !== undefined
  );
}

export interface ConsentModeCount {
  events: number;
  visitors: number;
}

export interface ConsentBreakdown {
  consentful: ConsentModeCount;
  consentless: ConsentModeCount;
}

// How much of the stored data was collected with the visitor's consent.
// This matters because get_new_vs_returning_visitors only works for
// visitors with consent (without it, ids change daily).
//
// Counted per event, since every row has exactly one mode. Visitors are
// reported too, but a visitor who accepts the cookie banner during the
// period appears under both modes, so the two visitor counts can add up
// to more than the real total (the tool description says so).
export function getConsentBreakdown(
  db: Database.Database,
  period: Period,
  segment: SegmentClause = NO_SEGMENT,
): ConsentBreakdown {
  const rows = db
    .prepare(
      `SELECT consent_mode AS mode,
              COUNT(*) AS events,
              COUNT(DISTINCT visitor_id) AS visitors
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY consent_mode`,
    )
    .all({ from: period.from, to: period.to, ...segment.params }) as {
    mode: string;
    events: number;
    visitors: number;
  }[];

  const byMode = new Map(rows.map((row) => [row.mode, row]));
  const count = (mode: string): ConsentModeCount => ({
    events: byMode.get(mode)?.events ?? 0,
    visitors: byMode.get(mode)?.visitors ?? 0,
  });

  return {
    consentful: count("consentful"),
    consentless: count("consentless"),
  };
}

// The rows both device breakdowns start from: one per session, with the
// device of its first event. With MIN(ts), SQLite takes the other plain
// columns from the row with the minimum, as in getEntryPages.
//
// A session happens in one browser on one device, so sessions are the
// right unit. Counted per event, one desktop visitor reading twenty
// pages would outweigh ten phone visitors reading two.
//
// The columns hold what lib/userAgent.ts made of the header when the
// event arrived; the header itself isn't stored, because on a small site
// it could identify a visitor. So a fix to lib/userAgent.ts only affects
// new rows.
interface SessionDevice {
  device_type: string | null;
  browser: string | null;
}

function sessionDevices(
  db: Database.Database,
  period: Period,
  segment: SegmentClause,
): SessionDevice[] {
  return db
    .prepare(
      `SELECT device_type, browser, MIN(ts) AS first_ts
       FROM events
       WHERE ts BETWEEN @from AND @to${segment.sql}
       GROUP BY session_id`,
    )
    .all({
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as SessionDevice[];
}

// A row from a request without a User-Agent has NULL in both columns.
// It is counted with the unrecognised ones rather than as a separate
// "none" row: either way the device is unknown.
function classified(row: SessionDevice): {
  browser: string;
  deviceType: string;
} {
  return {
    browser: row.browser ?? "Other",
    deviceType: row.device_type ?? "other",
  };
}

export interface DeviceTypeCount {
  deviceType: string;
  sessions: number;
}

// Device type only, not combined with the browser: combined and cut to a
// limit, Chrome/desktop, Chrome/mobile and Chrome/tablet could fill the
// list and push every other browser off it. "Is my traffic mobile?" and
// "do I still need to test Safari?" are separate questions;
// getBrowserBreakdown below answers the second.
export function getDeviceTypeBreakdown(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<DeviceTypeCount> {
  return mapRanked(
    rankSessionsBy(
      sessionDevices(db, period, segment),
      (row) => classified(row).deviceType,
      limit,
    ),
    ({ key, sessions }) => ({ deviceType: key, sessions }),
  );
}

export interface BrowserCount {
  browser: string;
  sessions: number;
}

export function getBrowserBreakdown(
  db: Database.Database,
  period: Period,
  limit: number,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<BrowserCount> {
  return mapRanked(
    rankSessionsBy(
      sessionDevices(db, period, segment),
      (row) => classified(row).browser,
      limit,
    ),
    ({ key, sessions }) => ({ browser: key, sessions }),
  );
}

export interface NewVsReturningVisitors {
  newVisitors: number;
  returningVisitors: number;
}

// A visitor active in the period is "returning" if their first event
// ever was before the period, and "new" otherwise. Visitors not active
// in the period aren't counted at all.
//
// Caveat: without consent a visitor_id changes daily (see "Visitor
// identification" in docs/decisions.md), so a visitor returning the next
// day looks "new" again. The numbers are meaningful for visitors with
// consent and for returns on the same day; on a site with mostly
// consentless visitors, treat them as a rough signal.
//
// The segment only limits who is active in the period, not the earlier
// visits: a visitor who came from a campaign today is returning because
// of any earlier visit. Finding the first event is one index lookup per
// active visitor (idx_events_visitor_ts), so the cost grows with the
// period, not with the whole table.
export function getNewVsReturningVisitors(
  db: Database.Database,
  period: Period,
  segment: SegmentClause = NO_SEGMENT,
): NewVsReturningVisitors {
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN EXISTS (
           SELECT 1 FROM events earlier
           WHERE earlier.visitor_id = active.visitor_id
             AND earlier.ts < @from
         ) THEN 'returning' ELSE 'new' END AS bucket,
         COUNT(*) AS count
       FROM (
         SELECT DISTINCT visitor_id
         FROM events
         WHERE ts BETWEEN @from AND @to${segment.sql}
       ) active
       GROUP BY bucket`,
    )
    .all({ from: period.from, to: period.to, ...segment.params }) as {
    bucket: "new" | "returning";
    count: number;
  }[];

  const byBucket = new Map(rows.map((row) => [row.bucket, row.count]));
  return {
    newVisitors: byBucket.get("new") ?? 0,
    returningVisitors: byBucket.get("returning") ?? 0,
  };
}

export interface CohortReturn {
  // Distinct visitors active in the cohort period (and in the segment,
  // if one was given).
  cohortVisitors: number;
  // How many of those had a consent id on at least one cohort event.
  // Only they can be recognised on a later day; the others' ids change
  // daily, so they can only count as "returned" on the same day.
  consentfulVisitors: number;
  // Cohort visitors with at least one event in the return period.
  returnedVisitors: number;
  // returnedVisitors / cohortVisitors, 0-1.
  returnRate: number;
}

// "Did last week's campaign visitors come back this week?": the
// visitors two periods have in common, which no counting tool can
// answer. consentfulVisitors says how many could be recognised at all:
// without consent a visitor gets a new id every day, so a later return
// can't be seen. Without it, the return rate would really be a consent
// rate.
//
// The segment applies to the cohort period (its @from/@to are the
// cohort's), which is what "came via utm_campaign=x last week" means.
export function getCohortReturn(
  db: Database.Database,
  cohort: Period,
  returnPeriod: Period,
  segment: SegmentClause = NO_SEGMENT,
): CohortReturn {
  const row = db
    .prepare(
      `WITH cohort AS (
         SELECT visitor_id,
                MAX(consent_mode = 'consentful') AS consentful
         FROM events
         WHERE ts BETWEEN @from AND @to${segment.sql}
         GROUP BY visitor_id
       )
       SELECT COUNT(*) AS cohortVisitors,
              COALESCE(SUM(consentful), 0) AS consentfulVisitors,
              COALESCE(SUM(EXISTS (
                SELECT 1 FROM events later
                WHERE later.visitor_id = cohort.visitor_id
                  AND later.ts BETWEEN @returnFrom AND @returnTo
              )), 0) AS returnedVisitors
       FROM cohort`,
    )
    .get({
      from: cohort.from,
      to: cohort.to,
      returnFrom: returnPeriod.from,
      returnTo: returnPeriod.to,
      ...segment.params,
    }) as {
    cohortVisitors: number;
    consentfulVisitors: number;
    returnedVisitors: number;
  };

  return {
    ...row,
    returnRate:
      row.cohortVisitors === 0
        ? 0
        : roundTo(row.returnedVisitors / row.cohortVisitors, 4),
  };
}
