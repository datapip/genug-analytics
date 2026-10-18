import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  eventRegistry,
  eventsSource,
  reloadEvents,
  MAX_EVENT_NAME_LENGTH,
  MAX_PROP_LIST_LENGTH,
} from "@genug/schema-registry";
import { getStoredEventCounts } from "../../lib/events.js";
import { editEventFile } from "../../lib/editEvent.js";
import { createEventFile } from "../../lib/createEvent.js";
import { addEventProp } from "../../lib/addEventProp.js";
import { deleteEventFile } from "../../lib/deleteEvent.js";
import {
  recordEventRenamed,
  recordEventDeleted,
} from "../../lib/autoHistory.js";
import {
  REASON_MAX_LENGTH,
  parseEditBody,
  refusesCockpitOrigin,
  refusesWrite,
} from "./guards.js";
import type { CockpitRouterDeps } from "../cockpit.js";

// The Schema registry card's writes: reload, edit, create, add a prop,
// delete. Reset events is a danger-zone action (cockpit/danger.ts).

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

// Shared so the same rule read the same way everywhere it's checked —
// an event's own description (eventEditSchema, eventCreateSchema) and a
// prop's (here, and propSpecSchema below) are two different fields, but
// a person fixing one message and missing its twin is how the two drift
// apart.
const EVENT_DESCRIPTION_MESSAGE =
  "A description needs to say what the event means.";
const PROP_DESCRIPTION_MESSAGE =
  "A prop description needs to say what the value is.";

// The words on one event: its name, its description, and the prose
// attached to each of its props. Deliberately not its props'
// names or types — see lib/editEvent.ts for why that line is where it
// is.
//
// The 10-character minimums are the same bar the repo's own tests hold
// the built-in events to. A description is the only thing an AI agent
// ever reads to understand what an event means, so "x" is not a
// description, it is an unlabelled column.
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

// One prop, added to an event that already has traffic — see
// lib/addEventProp.ts for why this is the one shape change the cockpit
// is allowed to make to a live event. Same schema as the New event
// form's props (propSpecSchema above): `optional` is accepted here only
// so the request body matches the shared PropSpec type; addEventProp
// never reads it and always composes the rule as optional.
const propAddSchema = propSpecSchema;

export function registerEventRoutes(
  router: Router,
  deps: CockpitRouterDeps,
): void {
  const { db, timezone } = deps;
  // Re-reads the event files and swaps the registry in, without a
  // restart. Dropping a file on the volume and restarting the container
  // is a fine way to apply a change made at a terminal; being told to go
  // and restart something after clicking a button in a browser is not.
  //
  // A POST, because it changes what the running server does. Nothing in
  // the request body: what to load is whatever is on disk.
  router.post("/reload", (req: Request, res: Response) => {
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

  router.put("/events/:name", parseEditBody, (req: Request, res: Response) => {
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
      recordEventRenamed(
        currentName,
        result.name,
        {
          movedRows: result.movedRows,
          strandedRows: strandedAfterReload(
            currentName,
            storedBefore - result.movedRows,
          ),
          reason: body.data.reason,
        },
        timezone,
      );
    }

    res.json({
      ok: true,
      name: result.name,
      movedRows: result.movedRows,
      eventCount: reload.eventCount,
      errorCount: reload.errors.length,
    });
  });

  router.post("/events", parseEditBody, (req: Request, res: Response) => {
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

  router.post(
    "/events/:name/props",
    parseEditBody,
    (req: Request, res: Response) => {
      if (refusesWrite(req, res, "A new prop")) return;

      const body = propAddSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          ok: false,
          error: body.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "prop"}: ${issue.message}`,
            )
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
  router.delete(
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
      recordEventDeleted(
        eventName,
        {
          storedRows: result.storedCount,
          strandedRows: strandedAfterReload(eventName, result.storedCount),
          reason: body.data.reason,
        },
        timezone,
      );

      res.json({
        ok: true,
        name: eventName,
        storedCount: result.storedCount,
        eventCount: reload.eventCount,
        errorCount: reload.errors.length,
      });
    },
  );
}
