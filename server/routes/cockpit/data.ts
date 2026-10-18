import { join } from "node:path";
import type { Request, Response, Router } from "express";
import {
  serializeRegistry,
  schemaErrors,
  eventRegistry,
  eventsPath,
  eventsSource,
  pageViewEventType,
  roleEventNames,
} from "@genug/schema-registry";
import {
  getTrafficSummary,
  getTrafficByDay,
  getTrafficByDayOfWeek,
  getTrafficByHour,
} from "../../lib/traffic.js";
import { getTopPages, getTopReferrers } from "../../lib/content.js";
import { getStoredEventCounts } from "../../lib/events.js";
import {
  getDeviceTypeBreakdown,
  getConsentBreakdown,
} from "../../lib/audience.js";
import { getRecentEvents } from "../../lib/recentEvents.js";
import { getLastEventAt } from "../../lib/collectionHealth.js";
import { parseWindowRange, windowPeriod } from "../../lib/windowPeriod.js";
import {
  getRejectedEventCount,
  getTopRejectedEvents,
} from "../../lib/rejectedEvents.js";
import { getBotActivityCount } from "../../lib/botActivity.js";
import { getOrphanedEvents } from "../../lib/orphanedEvents.js";
import { getToolManifest } from "../../mcp/tools.js";
import {
  contextPath,
  readGroundRulesRaw,
  readBusinessContextRaw,
  MAX_PROSE_FIELD_BYTES,
} from "../../lib/context.js";
import { readHistory, HISTORY_FILE } from "../../lib/history.js";
import { VERSION } from "../../lib/version.js";
import { latestVersion } from "../../lib/updateCheck.js";
import type { CockpitRouterDeps } from "../cockpit.js";

// GET /cockpit/data: everything the page shows, in one answer.

const RECENT_EVENTS_LIMIT = 5;
const TOP_PAGES_LIMIT = 5;
const TOP_REFERRERS_LIMIT = 5;
const DEVICE_BREAKDOWN_LIMIT = 6;
const REJECTED_EVENTS_LIMIT = 5;

// A read-only deployment is the public demo, whose password is
// published, and this route runs some twenty queries synchronously: a
// few viewers holding refresh would stall /events behind them. In that
// mode every viewer gets the same answer — nothing on it depends on who
// asked, and nothing can change it from here — so one answer per range
// is kept briefly. Not in normal mode, where an owner's own edit must
// show on the next load.
const READ_ONLY_DATA_CACHE_MS = 30 * 1000;

function cockpitData(
  { db, readOnly, timezone, siteHosts, retentionDays }: CockpitRouterDeps,
  period: ReturnType<typeof windowPeriod>,
  now: Date,
) {
  return {
    period,
    // The zone every day and hour on the page is in. The page formats
    // its labels in it and says which it is, since the viewer's
    // browser may well be somewhere else.
    timezone,
    // Which build is serving this page. A bug report that says "the
    // cockpit showed X" is only actionable with the version attached,
    // and once images are pulled rather than built the operator has no
    // other way to see it short of reading container logs. Already
    // carries its own "v" prefix from the release tag, or is "dev" from
    // a clone (see lib/version.ts) — the page prints it verbatim.
    version: VERSION,
    // Read live, not captured at import time — lib/updateCheck.ts
    // replaces this binding on its own schedule (same reasoning as
    // eventRegistry). null means either no newer tag or the check
    // hasn't resolved yet; the cockpit treats both the same way.
    latestVersion,
    retentionDays: retentionDays ?? null,
    // From the configuration, not from the rows a period returned, so a
    // two-site installation names the site on every page row even when
    // the top ones all happen to be one site's.
    siteHosts: [...siteHosts],
    trafficSummary: getTrafficSummary(db, period, pageViewEventType),
    botActivityCount: getBotActivityCount(db, period),
    // All time, not the selected period: "is anything arriving" is the
    // question, and 7d and 30d leave today out. The page prints it
    // beside its own fetch time, so a stalled script shows as a gap
    // between the two.
    lastEventAt: getLastEventAt(db, now),
    rejectedEventCount: getRejectedEventCount(db, period),
    // The count alone is a number nobody can act on — "1 rejected" says
    // something is broken but not what, and finding out meant asking
    // the agent. Grouped by (reason, event) rather than listed row by
    // row: one broken integration produces hundreds of identical
    // rejections, and five copies of the same line is worse than one
    // line saying it happened five hundred times.
    topRejectedEvents: getTopRejectedEvents(db, period, REJECTED_EVENTS_LIMIT)
      .items,
    trafficByDay: getTrafficByDay(db, period, pageViewEventType, timezone),
    trafficByDayOfWeek: getTrafficByDayOfWeek(
      db,
      period,
      pageViewEventType,
      timezone,
    ),
    trafficByHour: getTrafficByHour(db, period, pageViewEventType, timezone),
    topPages: getTopPages(db, period, TOP_PAGES_LIMIT, pageViewEventType).items,
    topReferrers: getTopReferrers(
      db,
      period,
      TOP_REFERRERS_LIMIT,
      pageViewEventType,
    ).items,
    // Device type only, not crossed with the browser (see
    // lib/audience.ts): crossed and then limited, Chrome alone can take
    // three of six rows and push every other browser off the list
    // without ever stating a plain total. Browser share is the agent's
    // to answer through get_device_breakdown.
    deviceBreakdown: getDeviceTypeBreakdown(db, period, DEVICE_BREAKDOWN_LIMIT)
      .items,
    // Shown as a single share line, not a stat card: a deployment
    // with no consent banner (consent UI is out of v1 scope) would
    // otherwise get a card reading 100% consentless forever.
    consentBreakdown: getConsentBreakdown(db, period),
    // Withheld in read-only mode for the reason get_recent_events is
    // (rawDataToolModules in mcp/tools.ts): these are raw rows, not an
    // aggregate, and read-only mode is the one meant for sharing (the
    // public demo publishes its cockpit password).
    recentEvents: readOnly ? [] : getRecentEvents(db, RECENT_EVENTS_LIMIT).rows,
    schemaRegistry: serializeRegistry(),
    // Which registered name carries the "_pageView" role. Read from the
    // live binding per request (see AGENTS.md), never cached. The
    // registry otherwise gives no hint that one of these events is the
    // one every page-scoped number on this page depends on, and a
    // deployment is free to have renamed it.
    pageViewEventType,
    // The other two roles, same live-binding reasoning as above. Optional
    // — a deployment that never registered outbound-click or
    // file-download tracking has `undefined` here, and the Schema
    // registry card simply shows no badge for either.
    roleEventNames,
    // Whether an edit made here can be saved at all. False when seeding
    // could not prepare a volume and the image's own directory is
    // serving — writing into that would be thrown away on the next
    // deploy, so the page says so instead of offering a Save button
    // that quietly does nothing lasting.
    schemaEditable: !readOnly && eventsSource === eventsPath,
    // Whether any write is possible at all. The page hides every write
    // control when this is true, and says why, rather than leaving
    // buttons that fail.
    readOnly,
    // All time, not the selected period: this is "how much history a
    // rename would move", and a windowed number would understate it.
    storedEventCounts: getStoredEventCounts(db),
    // Event files on the volume that were skipped at startup. A skipped
    // file is silent otherwise: its events keep arriving and keep being
    // rejected as an unknown type, with nothing anywhere saying the
    // schema failed to load.
    schemaErrors,
    // Not period-scoped, unlike everything above it: a rename's
    // leftovers age out of any window while staying just as invisible.
    orphanedEvents: getOrphanedEvents(db, Object.keys(eventRegistry)),
    toolManifest: getToolManifest(db, { readOnly, timezone }),
    // Read fresh on every load, same as the MCP resource these three
    // feed (lib/context.ts deliberately holds no live binding) — an
    // edit made on the volume between one cockpit refresh and the next
    // must show up here too, not just to the agent.
    groundRules: groundRulesForCockpit(),
    businessContext: businessContextForCockpit(),
    proseFieldMaxBytes: MAX_PROSE_FIELD_BYTES,
    history: historyForCockpit(),
  };
}

// The raw text an owner can edit and save unchanged, not the agent's
// rendered "## Ground rules" section — see lib/context.ts's
// readGroundRulesRaw for why those are different shapes.
function groundRulesForCockpit(): {
  text: string | null;
  usingDefault: boolean;
  error: string | null;
} {
  const result = readGroundRulesRaw(contextPath);
  if (!result.ok) {
    return { text: null, usingDefault: false, error: result.error };
  }
  return { text: result.text, usingDefault: result.usingDefault, error: null };
}

// Same shape as groundRulesForCockpit, minus usingDefault — there is no
// built-in business context to fall back to, so an absent file is just
// empty text (see lib/context.ts's readBusinessContextRaw).
function businessContextForCockpit(): {
  text: string | null;
  error: string | null;
} {
  const result = readBusinessContextRaw(contextPath);
  if (!result.ok) {
    return { text: null, error: result.error };
  }
  return { text: result.text, error: null };
}

function historyForCockpit(): {
  entries: { from: string; to?: string; note: string }[];
  skipped: string[];
  dropped: number;
  error: string | null;
} {
  const result = readHistory(join(contextPath, HISTORY_FILE));
  if (!result.ok) {
    return { entries: [], skipped: [], dropped: 0, error: result.error };
  }
  return {
    entries: result.entries,
    skipped: result.skipped,
    dropped: result.dropped,
    error: null,
  };
}

export function registerDataRoutes(
  router: Router,
  deps: CockpitRouterDeps,
): void {
  const { readOnly, timezone } = deps;
  // Per router, so a test that builds two apps does not share answers.
  const readOnlyDataCache = new Map<string, { at: number; body: unknown }>();

  router.get("/data", (req: Request, res: Response) => {
    const parsed = parseWindowRange(req.query);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }
    const now = new Date();
    if (readOnly) {
      const cached = readOnlyDataCache.get(parsed.range);
      if (cached && now.getTime() - cached.at < READ_ONLY_DATA_CACHE_MS) {
        res.json(cached.body);
        return;
      }
    }
    const body = cockpitData(
      deps,
      windowPeriod(parsed.range, now, timezone),
      now,
    );
    if (readOnly) {
      readOnlyDataCache.set(parsed.range, { at: now.getTime(), body });
    }
    res.json(body);
  });
}
