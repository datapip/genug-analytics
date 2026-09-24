import type Database from "better-sqlite3";
import type { Period } from "./period.js";
import {
  rankSessionsBy,
  mapRanked,
  roundTo,
  type Ranked,
} from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";

// "Who is visiting" — the visitor-shaped questions, as opposed to how
// much traffic there was (traffic.ts) or what they looked at
// (content.ts). Pairs with mcp/audience.ts.
//
// getTopLanguages and getConsentBreakdown read two columns that were
// being written on every event row and queried by nothing — the same
// gap `referrer` had before get_top_referrers existed: collected
// faithfully, impossible to ask about.

export interface LanguageCount {
  // null = the request carried no Accept-Language header at all, so the
  // visitor's locale is genuinely unknown rather than being some
  // "unknown" locale. Same explicit-null convention as
  // getTopReferrers' direct-traffic bucket.
  language: string | null;
  sessions: number;
}

// The visitor's browser/device locale (parsed from Accept-Language at
// ingestion), NOT the page's own declared language — an event may carry
// a document_language prop, which answers a different question.
//
// Counted in sessions, like every other audience breakdown. Not
// events, since one chatty visitor firing many events shouldn't
// outrank a genuinely larger audience speaking another language — and
// not visitors either, which this used to count: a consentless
// visitor_id rotates daily, so over a month one German reader became
// up to thirty "visitors" while the device breakdown next to it
// counted sessions. One unit across the family, and one that survives
// the rotation.
// One row per session, the same shape sessionDevices uses, rather than
// COUNT(DISTINCT session_id) grouped by language.
//
// The two are not equivalent, and the difference showed up the first
// time this was pointed at real traffic. Accept-Language is stored per
// event, not per session, so a session whose events carried two
// different locales was counted once under each — four language rows
// totalling four, against three sessions that actually existed. A
// reader taking shares off that gets more than 100%, and this tool's
// own description promises it is "the same unit as
// get_device_breakdown, so the two can be read side by side", which
// was then untrue.
//
// It is not only an artefact of hand-made requests: one consentless
// visitor_id can cover several people behind one address sharing a
// User-Agent, and they do not share a locale. Attributing the session
// to the locale it began with is the same rule entry pages and
// referrers already use.
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

  // A null locale is a real answer — the request carried no
  // Accept-Language header — so it needs a key of its own that cannot
  // collide with a locale string.
  const NO_LANGUAGE = "\u0000none";
  return mapRanked(
    rankSessionsBy(rows, (row) => row.language ?? NO_LANGUAGE, limit),
    ({ key, sessions }) => ({
      language: key === NO_LANGUAGE ? null : key,
      sessions,
    }),
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
// Worth having beyond curiosity: get_new_vs_returning_visitors is only
// meaningful for consentful visitors (consentless ids rotate daily), and
// until now there was no way to find out what that mix actually is.
//
// Counted per event, which is unambiguous — every row carries exactly
// one mode. Visitors are also reported, but a visitor who accepts a
// cookie banner mid-period legitimately appears under both modes, so
// the two visitor counts can sum to more than the real total (the tool
// description says so).
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

// The row set both device breakdowns start from: one row per session,
// holding the device columns of its earliest event. MIN(ts) with bare
// columns alongside takes them from the row producing the minimum —
// the same SQLite guarantee getEntryPages relies on.
//
// A session happens in one browser on one device, so the session is
// the honest unit here — and the only one that doesn't let engagement
// masquerade as reach. Counted per event, a single desktop visitor
// reading twenty pages outweighed ten phone visitors reading two, and
// "most of my traffic is desktop" meant nothing more than "my desktop
// visitors click around more". Same reasoning as getTopReferrers and
// getTopLanguages counting sessions.
//
// The columns hold what lib/userAgent.ts classified the header to at
// write time; the header itself is not stored (see db/migrations.ts).
// So a classifier fix applies to rows from then on, not to history —
// the trade accepted for not keeping a string that can single a
// visitor out on a quiet site.
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

// A row whose request carried no User-Agent at all has NULL in both
// columns. It is reported under the same unclassified bucket an
// unrecognised header lands in, rather than as a separate "none" row:
// the answer to "which device" is unknown either way.
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

// Device type alone, not crossed with the browser. The crossed version
// this replaced fragmented one real answer across several rows — with
// a limit applied, Chrome/desktop, Chrome/mobile and Chrome/tablet were
// three entries competing for the slots, so a site that is mostly
// Chrome could push every other browser off the list while never
// stating either plain fact. "Is my traffic mobile?" and "do I still
// need to test Safari?" are two questions; getBrowserBreakdown below
// answers the second.
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

// A visitor counts as "returning" if their all-time earliest event
// predates this period's start, "new" otherwise — only visitors active
// *within* the period are counted at all (a visitor who came before and
// never came back isn't part of either bucket for this period).
//
// Important caveat, not fixable here: consentless visitor_ids rotate
// daily (see "Visitor identification" in docs/decisions.md) — a consentless
// visitor who returns tomorrow gets a brand-new hash and looks "new"
// again here, every time. This is genuinely meaningful for consentful
// visitors (a persistent id) and for same-day returns either way; for a
// mostly-consentless deployment, treat it as a soft signal, not a hard
// retention number.
//
// The segment narrows who is active in the period, never the earlier
// events that decide "returning": a visitor who arrives from a campaign
// today returns because of any earlier visit, not an earlier one from
// that campaign. The lookback is one index seek per active visitor
// (idx_events_visitor_ts), not a pass over every visitor ever stored —
// that shape grew with the whole table, not with the period asked about.
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
  // Distinct visitors active in the cohort period (and matching the
  // segment, if one was given).
  cohortVisitors: number;
  // Of those, how many had a persistent (consentful) id on at least one
  // cohort event — the only ones that can be recognised again on a
  // later day. The rest are consentless, rotate daily, and can only
  // show up as "returned" within the cohort's own day.
  consentfulVisitors: number;
  // Cohort visitors with at least one event in the return period.
  returnedVisitors: number;
  // returnedVisitors / cohortVisitors, 0-1.
  returnRate: number;
}

// "Did last week's campaign visitors come back this week" — a set
// intersection across two periods, which no count-shaped tool can be
// combined into. The honest half of the answer is consentfulVisitors:
// a consentless visitor_id is a new hash every UTC day, so for them
// returning on a later day is unobservable by design, and the result
// says how much of the cohort that applies to instead of reporting a
// return rate that is really a consent rate.
//
// The segment is bound to the cohort period: its @from/@to are the
// cohort bounds, which is what "entered via utm_campaign=x last week"
// means.
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
