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

// GET /cockpit/data: everything the page shows, in one response.

const RECENT_EVENTS_LIMIT = 5;
const TOP_PAGES_LIMIT = 5;
const TOP_REFERRERS_LIMIT = 5;
const DEVICE_BREAKDOWN_LIMIT = 6;
const REJECTED_EVENTS_LIMIT = 5;

// Read-only mode is used for the public demo, whose password is public.
// This route runs about twenty queries that block Node while they run,
// so a few viewers reloading repeatedly would delay /events. In this
// mode every viewer gets the same data and nobody can change it, so the
// response for each period is kept for a short time. Not in normal mode,
// where the owner's own edit must show on the next load.
const READ_ONLY_DATA_CACHE_MS = 30 * 1000;

function cockpitData(
  { db, readOnly, timezone, siteHosts, retentionDays }: CockpitRouterDeps,
  period: ReturnType<typeof windowPeriod>,
  now: Date,
) {
  return {
    period,
    // The time zone of every day and hour on the page. The page uses it
    // for its labels and shows it, since the viewer may be in another
    // time zone.
    timezone,
    // Which version is running, so a bug report can include it. It is
    // the release tag with its "v", or "dev" (see lib/version.ts), and
    // the page shows it as it is.
    version: VERSION,
    // Read on every request, because lib/updateCheck.ts replaces it once
    // a day. null means there is no newer version or the check hasn't
    // finished; the cockpit treats both the same.
    latestVersion,
    retentionDays: retentionDays ?? null,
    // From the configuration, not from the returned rows, so with two
    // sites every page row shows its site, even if the top rows all
    // happen to be from one site.
    siteHosts: [...siteHosts],
    trafficSummary: getTrafficSummary(db, period, pageViewEventType),
    botActivityCount: getBotActivityCount(db, period),
    // Over all time, not the selected period: the question is "is
    // anything arriving?", and 7d and 30d don't include today. The page
    // shows it next to the time it loaded, so a broken script shows as
    // a gap between the two.
    lastEventAt: getLastEventAt(db, now),
    rejectedEventCount: getRejectedEventCount(db, period),
    // Grouped by reason and event, so the page can say what is broken,
    // not only that something is. Not listed one by one: one broken
    // integration causes hundreds of identical rejections.
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
    // Device type only, not combined with the browser (see
    // lib/audience.ts): combined and cut to six rows, Chrome alone could
    // take three of them. The agent can answer browser questions with
    // get_device_breakdown.
    deviceBreakdown: getDeviceTypeBreakdown(db, period, DEVICE_BREAKDOWN_LIMIT)
      .items,
    // Shown as one line, not a stat card: a site without a consent
    // banner would otherwise always show a card reading "100% without
    // consent".
    consentBreakdown: getConsentBreakdown(db, period),
    // Left out in read-only mode, like get_recent_events
    // (rawDataToolModules in mcp/tools.ts): these are raw rows, and
    // read-only mode is for sharing (the public demo's password is
    // public).
    recentEvents: readOnly ? [] : getRecentEvents(db, RECENT_EVENTS_LIMIT).rows,
    schemaRegistry: serializeRegistry(),
    // Which event has the "_pageView" role, read on every request (it
    // changes when events are reloaded). Every page number on this page
    // depends on that event, and a deployment may have renamed it.
    pageViewEventType,
    // The other two roles, also read on every request. `undefined` when
    // no event has the role; the Schema registry card then shows no
    // badge for it.
    roleEventNames,
    // Whether edits to events can be saved for good. False when the
    // events are read from the image's own folder (no volume could be
    // prepared): changes there would be lost on the next deploy, so the
    // page says so instead of offering a Save button.
    schemaEditable: !readOnly && eventsSource === eventsPath,
    // When true, no change is possible. The page hides every editing
    // control and says why, instead of showing buttons that fail.
    readOnly,
    // Over all time, not the selected period: this is "how many rows a
    // rename would move".
    storedEventCounts: getStoredEventCounts(db),
    // Event files that were skipped when loading. Otherwise nobody would
    // notice: their events keep arriving and are rejected as unknown,
    // with nothing saying the file failed to load.
    schemaErrors,
    // Over all time: rows left by a rename fall out of any period but
    // stay just as invisible.
    orphanedEvents: getOrphanedEvents(db, Object.keys(eventRegistry)),
    toolManifest: getToolManifest(db, { readOnly, timezone }),
    // Read from disk on every load, like the MCP resource, so a file
    // edited on the server shows up here too.
    groundRules: groundRulesForCockpit(),
    businessContext: businessContextForCockpit(),
    proseFieldMaxBytes: MAX_PROSE_FIELD_BYTES,
    history: historyForCockpit(),
  };
}

// The file's text as the owner edits it, not the "## Ground rules"
// section the agent gets (see readGroundRulesRaw in lib/context.ts).
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

// Like groundRulesForCockpit, without usingDefault: there is no default
// business context, so a missing file is empty text (see
// readBusinessContextRaw in lib/context.ts).
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
  // One cache per router, so two apps in one test don't share it.
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
