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

// The Schema registry card's actions: reload, edit, create, add a prop,
// delete. Reset events is in the danger zone (cockpit/danger.ts).

// How many rows of a name no longer match any event, after reloading.
//
// Usually all of them. The exception: after deleting or renaming the
// page-view event, the built-in stand-in takes that name again
// (registry.ts), so its rows still match. Claiming otherwise in the
// history log would invent a cause for a drop that never happened.
//
// eventRegistry is read here, at call time, so it is the one
// reloadEvents() just replaced (see AGENTS.md).
function strandedAfterReload(name: string, candidates: number): number {
  if (Object.prototype.hasOwnProperty.call(eventRegistry, name)) return 0;
  return Math.max(0, candidates);
}

// One rule for every description field (events and props), so they
// can't end up with different limits or messages.
const EVENT_DESCRIPTION_MESSAGE =
  "A description needs to say what the event means.";
const PROP_DESCRIPTION_MESSAGE =
  "A prop description needs to say what the value is.";

// The wording of one event: its name, its description, and each prop's
// description and example. Not prop names or types (see
// lib/editEvent.ts for why).
//
// Descriptions need at least 10 characters, as the tests require for the
// built-in events. The description is all the agent knows about what an
// event means, so "x" isn't enough.
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
  // Optional: fixing a typo shouldn't need an explanation, and a
  // required box would soon be filled with ".". Length-limited like every
  // text field, because it ends up in the agent's document.
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
});

// The optional body of a DELETE. The cockpit only sends one when the
// "why?" box was filled in, and a DELETE without a body works too.
const eventDeleteSchema = z.strictObject({
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
});

// One prop as the browser sends it: a type from a fixed list (z.enum),
// never a rule string, plus two checkboxes. Used by the New event form
// (a list of these) and the Add prop form (propAddSchema, exactly one).
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

// A new event from the New event form. Unlike an edit, it defines props
// (see lib/createEvent.ts for why that is safe).
const eventCreateSchema = z.strictObject({
  name: z.string().max(MAX_EVENT_NAME_LENGTH),
  description: z.string().min(10, EVENT_DESCRIPTION_MESSAGE).max(1000),
  props: z.array(propSpecSchema).max(50),
});

// Error paths a person can understand: "props.2.example" becomes
// "Prop 3", as the form labels it, since people count from one.
function issuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "body";
  if (path[0] === "props" && typeof path[1] === "number") {
    return `prop ${path[1] + 1}${path[2] ? ` — ${String(path[2])}` : ""}`;
  }
  return path.join(".");
}

// One prop added to an existing event (see lib/addEventProp.ts). Same
// schema as the New event form's props. `optional` is accepted only so
// the body matches PropSpec; addEventProp ignores it and always makes
// the prop optional.
const propAddSchema = propSpecSchema;

export function registerEventRoutes(
  router: Router,
  deps: CockpitRouterDeps,
): void {
  const { db, timezone } = deps;
  // Reads the event files again and switches to the new registry, without
  // a restart. A POST, because it changes what the running server does.
  // There is no body: it loads whatever is on disk.
  router.post("/reload", (req: Request, res: Response) => {
    // Only the CSRF check: reload doesn't write an event file, so
    // refusesWrite's other check doesn't apply.
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
      // The old registry keeps running; a failed reload changes nothing.
      // Say so, or "reload failed" sounds like "collection is down".
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

    // Express types a route param as string | string[]. A single :name
    // is always a string; checking is safer than a cast, which could
    // turn an array into a file name.
    const currentName = req.params.name;
    if (typeof currentName !== "string") {
      res.status(400).json({ ok: false, error: "Malformed event name." });
      return;
    }

    // Count before the edit; afterwards there is no way to tell whether
    // rows were moved or left behind. movedRows === 0 alone can't tell
    // "rows stayed" from "there were no rows".
    const storedBefore = getStoredEventCounts(db)[currentName] ?? 0;

    const result = editEventFile(db, eventsSource, currentName, body.data);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    // The file is saved; reloading makes it take effect. It shouldn't
    // fail, since editEventFile already ran the loader's check, but if it
    // does, the response says so.
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

    // Only a rename is logged. Changing wording doesn't change any
    // number, and logging it would bury the entries that matter.
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

    // As with an edit: the file is saved, and reloading makes the server
    // accept the new event.
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

      // The file is saved; reloading makes the server accept the new
      // prop.
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

  // Deletes one event's file. See lib/deleteEvent.ts for what happens to
  // its rows and to role tags.
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

      // The body is only sent when the "why?" box was filled in, so a
      // missing one is normal.
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
        // Only happens when deleting the page-view event while another
        // file already uses the built-in's name: the stand-in can't be
        // registered, so buildRegistry() throws (see lib/deleteEvent.ts).
        // The file is restored right away; otherwise the next restart
        // would fail the same way.
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

      // After the restore above, so a delete that was undone isn't
      // logged.
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
