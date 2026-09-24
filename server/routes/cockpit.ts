import { join } from "node:path";
import {
  Router,
  json,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import {
  serializeRegistry,
  schemaErrors,
  eventRegistry,
  eventsPath,
  eventsSource,
  pageViewEventType,
  roleEventNames,
  reloadEvents,
  resetEvents,
  MAX_EVENT_NAME_LENGTH,
  MAX_PROP_LIST_LENGTH,
} from "@genug/schema-registry";
import { db } from "../db/index.js";
import {
  getTrafficSummary,
  getTrafficByDay,
  getTrafficByDayOfWeek,
  getTrafficByHour,
} from "../lib/traffic.js";
import { getTopPages, getTopReferrers } from "../lib/content.js";
import { getStoredEventCounts } from "../lib/events.js";
import {
  getDeviceTypeBreakdown,
  getConsentBreakdown,
} from "../lib/audience.js";
import { getRecentEvents } from "../lib/recentEvents.js";
import { editEventFile } from "../lib/editEvent.js";
import { createEventFile } from "../lib/createEvent.js";
import { addEventProp } from "../lib/addEventProp.js";
import { deleteEventFile } from "../lib/deleteEvent.js";
import { parseRetentionDays } from "../lib/retention.js";
import {
  getRejectedEventCount,
  getTopRejectedEvents,
} from "../lib/rejectedEvents.js";
import {
  getBotActivityCount,
  botActivityCounter,
  drainBotHits,
} from "../lib/botActivity.js";
import { getOrphanedEvents } from "../lib/orphanedEvents.js";
import { getToolManifest } from "../mcp/tools.js";
import { resetDatabase } from "../lib/resetDatabase.js";
import { parseReadOnly, requireEnv } from "../lib/env.js";
import { timingSafeStringEqual } from "../lib/auth.js";
import {
  contextPath,
  readGroundRulesRaw,
  readBusinessContextRaw,
  MAX_PROSE_FIELD_BYTES,
} from "../lib/context.js";
import { writeGroundRules } from "../lib/writeGroundRules.js";
import { writeBusinessContext } from "../lib/writeBusinessContext.js";
import {
  readHistory,
  appendHistoryEntry,
  HISTORY_FILE,
} from "../lib/history.js";
import {
  recordEventRenamed,
  recordEventDeleted,
  recordEventsReset,
} from "../lib/autoHistory.js";
import { VERSION } from "../lib/version.js";
import { latestVersion } from "../lib/updateCheck.js";

// Read directly from the environment rather than threaded in, same as
// eventsRouter's ALLOWED_ORIGIN — server/index.ts already
// requires this to build the cockpit's session gate, so by the time a
// request reaches this router it is guaranteed to be set.
const cockpitPassword = requireEnv("COCKPIT_PASSWORD");
const readOnly = parseReadOnly(process.env.READ_ONLY);

const DEFAULT_WINDOW_DAYS = 7;
// Only these three are offered — a full custom date range is analysis,
// which is the AI agent's job (see docs/decisions.md's "Core design
// principle"); the cockpit's job is a quick, bounded glance.
const ALLOWED_WINDOW_DAYS = new Set([1, 7, 30]);
const RECENT_EVENTS_LIMIT = 5;
const TOP_PAGES_LIMIT = 5;
const TOP_REFERRERS_LIMIT = 5;
const DEVICE_BREAKDOWN_LIMIT = 6;
const REJECTED_EVENTS_LIMIT = 5;

function parseWindowDays(value: unknown): number {
  const days = Number(value);
  return ALLOWED_WINDOW_DAYS.has(days) ? days : DEFAULT_WINDOW_DAYS;
}

export const cockpitRouter: Router = Router();

// How many rows a name really lost, once the registry has been reloaded.
//
// Usually all of them — a name nothing registers any more matches no
// registry-driven query. The exception is the one the whole stand-in
// branch exists for: deleting or renaming away from the event carrying
// `_pageView` hands that name back to the built-in (registry.ts), so
// the rows under it match a registered event again and nothing is
// stranded at all. Saying otherwise in the history log would invent a
// cause for a drop that never happened, which is the failure that log
// exists to prevent.
//
// eventRegistry is read here, inside the handler's call, so it is the
// binding reloadEvents() just replaced (see AGENTS.md).
function strandedAfterReload(name: string, candidates: number): number {
  if (Object.prototype.hasOwnProperty.call(eventRegistry, name)) return 0;
  return Math.max(0, candidates);
}

// Read-only mode closes every write on this router in one place, by
// method rather than by route: an edit, a new event, a reload and both
// danger-zone resets are all POST or PUT, and so will be the next write
// someone adds. Answered with a message that says the deployment is
// read-only, not a bare 403 that would read as a broken page, and
// checked before the CSRF header so that a cross-site form gets the
// same answer as the page itself — there is nothing here to protect
// from a forged request that a real one could not do either.
cockpitRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!readOnly || req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error:
      "This deployment is read-only (READ_ONLY=true): events cannot be " +
      "edited, created, reloaded or reset from the cockpit.",
  });
});

cockpitRouter.get("/data", (req: Request, res: Response) => {
  const windowDays = parseWindowDays(req.query.days);
  const now = new Date();
  const period = {
    from: new Date(
      now.getTime() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    to: now.toISOString(),
  };

  res.json({
    period,
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
    retentionDays: parseRetentionDays(process.env.RETENTION_DAYS) ?? null,
    trafficSummary: getTrafficSummary(db, period, pageViewEventType),
    botActivityCount: getBotActivityCount(db, period),
    rejectedEventCount: getRejectedEventCount(db, period),
    // The count alone is a number nobody can act on — "1 rejected" says
    // something is broken but not what, and finding out meant asking
    // the agent. Grouped by (reason, event) rather than listed row by
    // row: one broken integration produces hundreds of identical
    // rejections, and five copies of the same line is worse than one
    // line saying it happened five hundred times.
    topRejectedEvents: getTopRejectedEvents(db, period, REJECTED_EVENTS_LIMIT)
      .items,
    trafficByDay: getTrafficByDay(db, period, pageViewEventType),
    trafficByDayOfWeek: getTrafficByDayOfWeek(db, period, pageViewEventType),
    trafficByHour: getTrafficByHour(db, period, pageViewEventType),
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
    recentEvents: getRecentEvents(db, RECENT_EVENTS_LIMIT),
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
    toolManifest: getToolManifest(db, { readOnly }),
    // Read fresh on every load, same as the MCP resource these three
    // feed (lib/context.ts deliberately holds no live binding) — an
    // edit made on the volume between one cockpit refresh and the next
    // must show up here too, not just to the agent.
    groundRules: groundRulesForCockpit(),
    businessContext: businessContextForCockpit(),
    proseFieldMaxBytes: MAX_PROSE_FIELD_BYTES,
    history: historyForCockpit(),
  });
});

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

// Re-reads the event files and swaps the registry in, without a
// restart. Dropping a file on the volume and restarting the container
// is a fine way to apply a change made at a terminal; being told to go
// and restart something after clicking a button in a browser is not.
//
// A POST, because it changes what the running server does. Nothing in
// the request body: what to load is whatever is on disk.
cockpitRouter.post("/reload", (req: Request, res: Response) => {
  // See refusesCockpitOrigin below for the CSRF story. Only that half —
  // reload touches nothing refusesWrite's other check is about.
  if (
    refusesCockpitOrigin(
      req,
      res,
      "Reload must be requested from the cockpit page.",
    )
  ) {
    return;
  }

  const result = reloadEvents();
  if (!result.ok) {
    // The registry that was already running is still running — a failed
    // build is discarded whole rather than half-applied. Said out loud,
    // because "reload failed" otherwise reads as "collection is down".
    res.status(500).json(result);
    return;
  }

  res.json({
    ok: true,
    eventCount: result.eventCount,
    errorCount: result.errors.length,
  });
});

// The words on one event: its name, its description, and the prose
// attached to each of its props. Deliberately not its props'
// names or types — see lib/editEvent.ts for why that line is where it
// is.
//
// The 10-character minimums are the same bar the repo's own tests hold
// the built-in events to. A description is the only thing an AI agent
// ever reads to understand what an event means, so "x" is not a
// description, it is an unlabelled column.
// Long enough for a sentence explaining a rename, short enough that the
// entry it lands in stays inside the history log's own 2000-character
// note cap with both event names in front of it.
const REASON_MAX_LENGTH = 500;

// Shared so the same rule read the same way everywhere it's checked —
// an event's own description (eventEditSchema, eventCreateSchema) and a
// prop's (here, and propSpecSchema below) are two different fields, but
// a person fixing one message and missing its twin is how the two drift
// apart.
const EVENT_DESCRIPTION_MESSAGE =
  "A description needs to say what the event means.";
const PROP_DESCRIPTION_MESSAGE =
  "A prop description needs to say what the value is.";

const eventEditSchema = z.strictObject({
  name: z.string().max(MAX_EVENT_NAME_LENGTH),
  description: z.string().min(10, EVENT_DESCRIPTION_MESSAGE).max(1000),
  props: z.record(
    z.string().max(MAX_EVENT_NAME_LENGTH),
    z.strictObject({
      description: z.string().min(10, PROP_DESCRIPTION_MESSAGE).max(1000),
      example: z.string().max(1000),
    }),
  ),
  renameStoredEvents: z.boolean(),
  // Optional on purpose. A rename made to fix a typo should not have to
  // be justified in writing, and a required box would be filled in with
  // "." within a week. Capped like every other text field: it ends up in
  // the document served to the agent.
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
});

// The body a DELETE may carry. Nothing is required — the cockpit sends
// one only when the box was filled in, and a delete from curl with no
// body at all still works.
const eventDeleteSchema = z.strictObject({
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
});

const parseEditBody = json({ limit: "64kb" });

// Half the CSRF story for every write on this router. It used to be
// all of it: under Basic Auth a browser attached the credentials to a
// cross-site form POST by itself, so being authenticated said nothing
// about where the request came from. The session cookie is
// SameSite=Lax, which a browser will not send on a cross-site POST at
// all — this header is now the second lock rather than the only one.
// Kept because the two fail differently: a header no plain form can
// set forces a preflight, and /cockpit answers no CORS preflight.
//
// Shared by every write route — including reload and reset below,
// which need nothing else refusesWrite checks — so the comparison and
// the response shape can't drift out of step between them. `message`
// keeps each call site's own wording; only the check and the 400
// itself are shared.
function refusesCockpitOrigin(
  req: Request,
  res: Response,
  message: string,
): boolean {
  if (req.get("x-genug-cockpit") !== "1") {
    res.status(400).json({ ok: false, error: message });
    return true;
  }
  return false;
}

// The two gates every write to an event *file* passes (on top of the
// CSRF check above, which every write on the router passes), kept in
// one place so they cannot drift apart: a route that forgot the second
// would accept a save that the next deploy throws away. Returns true
// when it has already answered the request.
function refusesWrite(req: Request, res: Response, action: string): boolean {
  if (
    refusesCockpitOrigin(
      req,
      res,
      `${action} must be saved from the cockpit page.`,
    )
  ) {
    return true;
  }

  if (eventsSource !== eventsPath) {
    res.status(409).json({
      ok: false,
      error:
        `Events are being read from the image, not from ${eventsPath}, so ` +
        `a change made here could not persist. The Schema registry card ` +
        `lists the reason.`,
    });
    return true;
  }

  return false;
}

cockpitRouter.put(
  "/events/:name",
  parseEditBody,
  (req: Request, res: Response) => {
    if (refusesWrite(req, res, "An edit")) return;

    const body = eventEditSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        ok: false,
        error: body.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; "),
      });
      return;
    }

    // Express types a route param as string | string[]; a single :name
    // is always the former, and a narrow check beats a cast that would
    // quietly stringify an array into a filename.
    const currentName = req.params.name;
    if (typeof currentName !== "string") {
      res.status(400).json({ ok: false, error: "Malformed event name." });
      return;
    }

    // Counted before the edit, because afterwards the rows have either
    // moved or been left behind and there is no telling which from the
    // outside. Cheap enough for a human-initiated edit, and the
    // alternative — inferring "stranded" from movedRows === 0 — cannot
    // tell an event whose rows stayed put from one that never had any.
    const storedBefore = getStoredEventCounts(db)[currentName] ?? 0;

    const result = editEventFile(db, eventsSource, currentName, body.data);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    // The file is already on disk; this is what makes it take effect.
    // It cannot meaningfully fail here — editEventFile ran the loader's
    // own checker before writing — but saying so beats implying the
    // change is live when it is not.
    const reload = reloadEvents();
    if (!reload.ok) {
      res.status(500).json({
        ok: false,
        error:
          `Saved ${result.name}.json, but the registry would not reload: ` +
          reload.error,
      });
      return;
    }

    // Only a rename, not every edit. Changing an event's words moves
    // no number, and a history log that records those buries the three
    // lines worth reading among dozens that are not.
    if (result.name !== currentName) {
      recordEventRenamed(currentName, result.name, {
        movedRows: result.movedRows,
        strandedRows: strandedAfterReload(
          currentName,
          storedBefore - result.movedRows,
        ),
        reason: body.data.reason,
      });
    }

    res.json({
      ok: true,
      name: result.name,
      movedRows: result.movedRows,
      eventCount: reload.eventCount,
      errorCount: reload.errors.length,
    });
  },
);

// One prop, in the shape the browser sends it: a type from a fixed
// list, never a rule string — the two booleans are checkboxes, so the
// set of shapes either route below can be asked for is closed, and
// z.enum is what closes it. Shared by the New event form (an array of
// these) and the Add prop form (propAddSchema, exactly one) so a
// validation rule changed for one can't silently miss the other.
// Matches the PropSpec type in lib/createEvent.ts.
const propSpecSchema = z.strictObject({
  name: z.string().max(MAX_EVENT_NAME_LENGTH),
  type: z.enum(["text", "longText", "number", "boolean"]),
  optional: z.boolean(),
  list: z.boolean(),
  description: z.string().min(10, PROP_DESCRIPTION_MESSAGE).max(1000),
  example: z
    .array(z.string().max(1000))
    .min(1, "Every prop needs an example value.")
    .max(MAX_PROP_LIST_LENGTH),
});

// A new event, from the New event form. Unlike an edit, this one does
// define props — see lib/createEvent.ts for why that line sits
// differently for a name nothing has sent yet.
const eventCreateSchema = z.strictObject({
  name: z.string().max(MAX_EVENT_NAME_LENGTH),
  description: z.string().min(10, EVENT_DESCRIPTION_MESSAGE).max(1000),
  props: z.array(propSpecSchema).max(50),
});

// Zod paths a person can act on: "props.2.example" names the third prop
// block on screen, which is headed "Prop 3" there, and nobody should
// have to know the index started at zero.
function issuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "body";
  if (path[0] === "props" && typeof path[1] === "number") {
    return `prop ${path[1] + 1}${path[2] ? ` — ${String(path[2])}` : ""}`;
  }
  return path.join(".");
}

cockpitRouter.post("/events", parseEditBody, (req: Request, res: Response) => {
  if (refusesWrite(req, res, "A new event")) return;

  const body = eventCreateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      ok: false,
      error: body.error.issues
        .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
        .join("; "),
    });
    return;
  }

  const result = createEventFile(db, eventsSource, body.data);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  // As with an edit: the file is on disk, and this is what makes the
  // server accept the event. Until it runs, POST /events would still
  // reject the name someone just defined.
  const reload = reloadEvents();
  if (!reload.ok) {
    res.status(500).json({
      ok: false,
      error:
        `Created ${result.name}.json, but the registry would not reload: ` +
        reload.error,
    });
    return;
  }

  res.json({
    ok: true,
    name: result.name,
    adoptedRows: result.adoptedRows,
    eventCount: reload.eventCount,
    errorCount: reload.errors.length,
  });
});

// One prop, added to an event that already has traffic — see
// lib/addEventProp.ts for why this is the one shape change the cockpit
// is allowed to make to a live event. Same schema as the New event
// form's props (propSpecSchema above): `optional` is accepted here only
// so the request body matches the shared PropSpec type; addEventProp
// never reads it and always composes the rule as optional.
const propAddSchema = propSpecSchema;

cockpitRouter.post(
  "/events/:name/props",
  parseEditBody,
  (req: Request, res: Response) => {
    if (refusesWrite(req, res, "A new prop")) return;

    const body = propAddSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        ok: false,
        error: body.error.issues
          .map((issue) => `${issue.path.join(".") || "prop"}: ${issue.message}`)
          .join("; "),
      });
      return;
    }

    const eventName = req.params.name;
    if (typeof eventName !== "string") {
      res.status(400).json({ ok: false, error: "Malformed event name." });
      return;
    }

    const result = addEventProp(eventsSource, eventName, body.data);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    // The file is already on disk; this is what makes the server accept
    // events carrying the new prop.
    const reload = reloadEvents();
    if (!reload.ok) {
      res.status(500).json({
        ok: false,
        error:
          `Saved the new prop, but the registry would not reload: ` +
          reload.error,
      });
      return;
    }

    res.json({
      ok: true,
      eventCount: reload.eventCount,
      errorCount: reload.errors.length,
    });
  },
);

// Deletes one event's file — the scoped counterpart to the danger
// zone's whole-directory reset below. See lib/deleteEvent.ts for the
// role-tag guard: an event flagged as page view or one of the two
// automatic-click roles cannot be removed here.
cockpitRouter.delete(
  "/events/:name",
  parseEditBody,
  (req: Request, res: Response) => {
    if (refusesWrite(req, res, "A delete")) return;

    const eventName = req.params.name;
    if (typeof eventName !== "string") {
      res.status(400).json({ ok: false, error: "Malformed event name." });
      return;
    }

    // A DELETE carries a body only when the "why?" box was filled in,
    // so an empty one is the ordinary case rather than a mistake.
    const body = eventDeleteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        ok: false,
        error: `reason: ${body.error.issues[0]?.message ?? "is not valid"}`,
      });
      return;
    }

    const result = deleteEventFile(db, eventsSource, eventName);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    const reload = reloadEvents();
    if (!reload.ok) {
      // Only reachable by deleting the event carrying `_pageView` while
      // some other file already occupies the built-in's own name —
      // registry.ts's stand-in has nowhere to go, so buildRegistry()
      // throws rather than leave the deployment with no page-view event
      // at all (see lib/deleteEvent.ts). Restored immediately: the
      // server that is already running never serves this, and neither
      // does the next restart, which would otherwise hit the same throw
      // at startup with nothing there to catch it.
      result.restore();
      reloadEvents();
      res.status(409).json({
        ok: false,
        error:
          `Deleting "${eventName}" would leave the registry unable to ` +
          `load, so it was restored instead: ${reload.error}`,
      });
      return;
    }

    // After the restore branch above, so a delete that was undone
    // leaves nothing behind claiming it happened.
    recordEventDeleted(eventName, {
      storedRows: result.storedCount,
      strandedRows: strandedAfterReload(eventName, result.storedCount),
      reason: body.data.reason,
    });

    res.json({
      ok: true,
      name: eventName,
      storedCount: result.storedCount,
      eventCount: reload.eventCount,
      errorCount: reload.errors.length,
    });
  },
);

// The whole ground-rules or business-context file, overwritten in one
// call — see lib/writeGroundRules.ts and lib/writeBusinessContext.ts
// for why a whole-file overwrite is right for free prose with no shape
// to merge against. No length check here: each field's writer enforces
// the real cap, in bytes rather than the characters z.string().max()
// would count. Shared by both routes below since the body shape is
// identical either way.
const proseFieldSchema = z.strictObject({ text: z.string() });

// Every other write on this router sends a few hundred bytes at most —
// event names, descriptions, prop metadata — so parseEditBody's 64kb was
// never close to MAX_PROSE_FIELD_BYTES (32kb). These two are the first
// bodies that can get close. JSON-escapes its content (a `"`, `\` or
// newline in ordinary prose each cost 2 bytes instead of 1), so a
// document sitting right at the content cap can push the *request
// body* — not the text — past 64kb, and body-parser rejects it before
// the route or the writer's own friendly error ever runs. Comfortably
// over double the content cap even under pessimistic escaping, rather
// than testing around the collision. Shared by both routes for the same
// reason proseFieldSchema is: same body shape, same cap.
const parseProseFieldBody = json({ limit: "128kb" });

cockpitRouter.put(
  "/context/ground-rules",
  parseProseFieldBody,
  (req: Request, res: Response) => {
    if (
      refusesCockpitOrigin(
        req,
        res,
        "Ground rules must be saved from the cockpit page.",
      )
    ) {
      return;
    }

    const body = proseFieldSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    const result = writeGroundRules(body.data.text, contextPath);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    res.json({ ok: true });
  },
);

// The business-context counterpart to the route above — same body
// shape, same writer pattern (lib/writeBusinessContext.ts), no
// usingDefault to report back since there is nothing to fall back to.
cockpitRouter.put(
  "/context/about",
  parseProseFieldBody,
  (req: Request, res: Response) => {
    if (
      refusesCockpitOrigin(
        req,
        res,
        "The site's context must be saved from the cockpit page.",
      )
    ) {
      return;
    }

    const body = proseFieldSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    const result = writeBusinessContext(body.data.text, contextPath);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    res.json({ ok: true });
  },
);

// Adds one dated entry to history.json — the cockpit's counterpart to
// the add_history_note MCP tool (mcp/admin.ts), sharing the same
// append-only writer. Deliberately not extended to edit or delete an
// entry: those stay a file edit on the volume, exactly as they were
// before this route existed (see docs/decisions.md) — a person fixing a
// typo in a form is a small win next to what full CRUD over text the
// agent reads as instruction would cost.
cockpitRouter.post(
  "/context/history",
  parseEditBody,
  (req: Request, res: Response) => {
    if (
      refusesCockpitOrigin(
        req,
        res,
        "A history note must be added from the cockpit page.",
      )
    ) {
      return;
    }

    const result = appendHistoryEntry(
      join(contextPath, HISTORY_FILE),
      req.body,
    );
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    res.json({ ok: true, entry: result.entry, total: result.total });
  },
);

const resetSchema = z.strictObject({ password: z.string() });

// Both danger-zone routes answer a wrong *confirmation* password with
// 403, never 401. The request is already authenticated — it carried a
// valid session to reach the handler — and it is the retyped
// confirmation that failed, which is an authorization answer, not an
// authentication one.
//
// Not a nicety, though the reason has changed: under Basic Auth a 401
// from this origin made the browser throw away its cached credentials,
// so one typo broke every later request on the page. Now cockpit.js
// treats a 401 as "the session ran out" and sends the page to the login
// screen — so answering a mistyped confirmation with one would throw
// the owner out mid-confirmation instead. Same failure, new mechanism,
// same fix: 401 is the session's answer, and nothing else's.

// Puts the events directory back to the image's built-ins, discarding
// every event this deployment added or edited. Gated like the database
// reset — the password retyped — because it is the same kind of action:
// irreversible from the browser, and destructive of work rather than of
// test data.
//
// Stored rows are NOT touched. That is the point of the warning it
// returns: removing an event type strands the rows it already
// collected, which keep counting toward totals while matching no
// registry-driven query (see lib/orphanedEvents.ts). The cockpit's
// orphaned-events panel will report them on the next load anyway; this
// says so at the moment it happens, when the person can still connect
// cause and effect.
cockpitRouter.post(
  "/events/reset",
  parseEditBody,
  (req: Request, res: Response) => {
    if (refusesWrite(req, res, "A reset")) return;

    const body = resetSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    if (!timingSafeStringEqual(body.data.password, cockpitPassword)) {
      res.status(403).json({ ok: false, error: "Incorrect password." });
      return;
    }

    // Counted before the registry changes: afterwards these names are
    // gone from it, and what they collected is exactly what nothing
    // will be able to ask about any more.
    const storedBefore = getStoredEventCounts(db);

    const result = resetEvents();
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }

    const reloaded = reloadEvents();
    if (!reloaded.ok) {
      res.status(500).json({
        ok: false,
        error:
          `The events directory was reset, but reloading it failed: ` +
          `${reloaded.error}`,
      });
      return;
    }

    const surviving = new Set(Object.keys(eventRegistry));
    const stranded = Object.entries(storedBefore)
      .filter(([name, count]) => count > 0 && !surviving.has(name))
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count);

    recordEventsReset(result.removed.length, stranded);

    res.json({
      ok: true,
      removed: result.removed.length,
      eventCount: reloaded.eventCount,
      errorCount: reloaded.errors.length,
      stranded,
    });
  },
);

// Wipes every stored event, rejected event and bot-activity row — the
// cockpit's "danger zone" button, for clearing out test traffic before a
// real launch. The event schema itself is untouched.
//
// Already sitting behind the same session as every other /cockpit
// route, so this second password check is not the security boundary —
// it exists so the button can't be fired by a stray click or a script
// replaying an earlier action: the person has to type the password again,
// right before the request that acts on it.
cockpitRouter.post("/reset", parseEditBody, (req: Request, res: Response) => {
  if (
    refusesCockpitOrigin(
      req,
      res,
      "Reset must be requested from the cockpit page.",
    )
  ) {
    return;
  }

  const body = resetSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: "Malformed request." });
    return;
  }

  if (!timingSafeStringEqual(body.data.password, cockpitPassword)) {
    res.status(403).json({ ok: false, error: "Incorrect password." });
    return;
  }

  const result = resetDatabase(db);
  // The in-memory bot-hit counter is a fourth place data lives besides
  // the three tables resetDatabase clears — left non-zero, the next
  // hourly flush (server/index.ts) would write it into a bot_activity
  // table this reset just emptied.
  drainBotHits(botActivityCounter);

  res.json({ ok: true, ...result });
});
